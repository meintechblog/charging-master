import 'server-only';
import { eq, desc, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { config, catalogSyncLog } from '@/db/schema';
import {
  buildPublishBundle,
  publishToGitHub,
  rebuildIndex,
  isGitHubPublishConfigured,
  isCatalogEnabled,
  loadProfile,
  loadCharger,
  type PublishArtifact,
} from './index';

export const AUTO_SYNC_KEY = 'catalog.autoSync';
const DEBOUNCE_MS = 15_000;
const LOG_RETENTION_ROWS = 200;

// Sticky circuit-breaker — N consecutive failures within window disables auto
// sync for the profile temporarily. Keeps GitHub from being hammered when the
// token is invalid or the repo permissions are revoked.
const FAILURE_WINDOW_MS = 10 * 60 * 1000;
const FAILURE_TRIP_COUNT = 3;
const breakerUntil = new Map<number, number>();

const debounceTimers = new Map<number, NodeJS.Timeout>();
// Stash the latest "reason" string per profile so the most recent trigger
// wins after debouncing (e.g. photo-upload immediately followed by photo-
// primary should commit as "photo-primary").
const pendingReason = new Map<number, string>();

export function isAutoSyncEnabled(): boolean {
  try {
    const row = db.select().from(config).where(eq(config.key, AUTO_SYNC_KEY)).get();
    // Default ON when key absent.
    if (!row) return true;
    return row.value !== 'false';
  } catch {
    return false;
  }
}

function logSync(entry: {
  profileId: number | null;
  catalogProfileId: string | null;
  reason: string;
  status: 'success' | 'error' | 'skipped';
  commitSha?: string | null;
  filesCommitted?: number;
  errorMessage?: string | null;
}): void {
  try {
    db.insert(catalogSyncLog).values({
      profileId: entry.profileId,
      catalogProfileId: entry.catalogProfileId,
      reason: entry.reason,
      status: entry.status,
      commitSha: entry.commitSha ?? null,
      filesCommitted: entry.filesCommitted ?? null,
      errorMessage: entry.errorMessage ?? null,
      createdAt: Date.now(),
    }).run();

    // Bounded growth: keep only the newest LOG_RETENTION_ROWS entries.
    db.run(sql`DELETE FROM catalog_sync_log WHERE id NOT IN (
      SELECT id FROM catalog_sync_log ORDER BY id DESC LIMIT ${LOG_RETENTION_ROWS}
    )`);
  } catch {
    // Never let logging failures break a sync.
  }
}

function recordFailure(profileId: number): void {
  const now = Date.now();
  const recent = db.select()
    .from(catalogSyncLog)
    .where(eq(catalogSyncLog.profileId, profileId))
    .orderBy(desc(catalogSyncLog.createdAt))
    .limit(FAILURE_TRIP_COUNT)
    .all();
  if (recent.length < FAILURE_TRIP_COUNT) return;
  const allRecentFailed = recent.every((r) => r.status === 'error' && now - r.createdAt < FAILURE_WINDOW_MS);
  if (allRecentFailed) {
    breakerUntil.set(profileId, now + FAILURE_WINDOW_MS);
  }
}

function isBreakerOpen(profileId: number): boolean {
  const until = breakerUntil.get(profileId);
  if (until == null) return false;
  if (Date.now() < until) return true;
  breakerUntil.delete(profileId);
  return false;
}

/**
 * Schedule a debounced catalog sync for a single profile. Multiple calls
 * within DEBOUNCE_MS collapse to a single commit; the latest reason wins.
 * Safe to call from any API route — fire and forget.
 */
export function scheduleCatalogSync(profileId: number, reason: string): void {
  if (!isAutoSyncEnabled()) return;
  if (!isCatalogEnabled()) return;
  if (!isGitHubPublishConfigured()) return;
  if (isBreakerOpen(profileId)) return;

  pendingReason.set(profileId, reason);

  const existing = debounceTimers.get(profileId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    debounceTimers.delete(profileId);
    const actualReason = pendingReason.get(profileId) ?? reason;
    pendingReason.delete(profileId);
    void runSyncOnce(profileId, actualReason).catch(() => {
      // runSyncOnce already logs internally; never let the timer reject.
    });
  }, DEBOUNCE_MS);
  // Allow Node to exit even if a sync timer is pending.
  if (typeof timer.unref === 'function') timer.unref();
  debounceTimers.set(profileId, timer);
}

/**
 * Run one sync immediately, bypassing the debounce. Used by the manual
 * /api/catalog/sync-now backfill endpoint and tests.
 */
export async function runSyncOnce(profileId: number, reason: string): Promise<{
  ok: boolean;
  status: 'success' | 'error' | 'skipped';
  commitSha?: string | null;
  filesCommitted?: number;
  error?: string;
}> {
  // Re-check guards in case the user toggled something during the debounce
  // window.
  if (!isCatalogEnabled()) {
    logSync({ profileId, catalogProfileId: null, reason, status: 'skipped', errorMessage: 'catalog_disabled' });
    return { ok: false, status: 'skipped', error: 'catalog_disabled' };
  }
  if (!isGitHubPublishConfigured()) {
    logSync({ profileId, catalogProfileId: null, reason, status: 'skipped', errorMessage: 'github_token_not_configured' });
    return { ok: false, status: 'skipped', error: 'github_token_not_configured' };
  }

  try {
    const bundle = await buildPublishBundle(profileId);
    if (!bundle) {
      logSync({ profileId, catalogProfileId: null, reason, status: 'skipped', errorMessage: 'profile_not_found_or_no_curve' });
      return { ok: false, status: 'skipped', error: 'profile_not_found_or_no_curve' };
    }

    const fatal = bundle.issues.filter((i) => i.severity === 'error');
    if (fatal.length > 0) {
      logSync({
        profileId,
        catalogProfileId: bundle.profileId,
        reason,
        status: 'skipped',
        errorMessage: `validation_failed: ${fatal.map((i) => i.field).join(',')}`,
      });
      return { ok: false, status: 'skipped', error: 'validation_failed' };
    }

    // Mirror submit-profile/route.ts: pull profile/charger JSON from artifacts
    // (the on-disk loader may not see brand-new entries yet).
    const extraProfiles: ReturnType<typeof loadProfile>[] = [];
    const extraChargers: ReturnType<typeof loadCharger>[] = [];
    for (const a of bundle.artifacts) {
      if (a.path.startsWith('catalog/profiles/') && a.path.endsWith('.json')) {
        try { extraProfiles.push(JSON.parse(Buffer.from(a.contentBase64, 'base64').toString('utf8'))); }
        catch { /* ignore */ }
      }
      if (a.path.startsWith('catalog/chargers/') && a.path.endsWith('.json')) {
        try { extraChargers.push(JSON.parse(Buffer.from(a.contentBase64, 'base64').toString('utf8'))); }
        catch { /* ignore */ }
      }
    }
    const onDiskProfile = loadProfile(bundle.profileId);
    if (onDiskProfile && !extraProfiles.find((p) => p?.id === onDiskProfile.id)) extraProfiles.push(onDiskProfile);
    if (bundle.chargerId) {
      const onDiskCharger = loadCharger(bundle.chargerId);
      if (onDiskCharger && !extraChargers.find((c) => c?.id === onDiskCharger.id)) extraChargers.push(onDiskCharger);
    }

    const filteredProfiles = extraProfiles.filter((p): p is NonNullable<typeof p> => p != null);
    const filteredChargers = extraChargers.filter((c): c is NonNullable<typeof c> => c != null);
    const newIndex = rebuildIndex(filteredProfiles, filteredChargers);
    const indexArtifact: PublishArtifact = {
      path: 'catalog/INDEX.json',
      contentType: 'application/json',
      contentBase64: Buffer.from(JSON.stringify(newIndex, null, 2) + '\n').toString('base64'),
    };

    const profileLabel = filteredProfiles[0]?.name ?? `profile ${bundle.profileId.slice(0, 8)}`;
    const message = `catalog: auto-sync ${reason} (${profileLabel})`;

    const push = await publishToGitHub([...bundle.artifacts, indexArtifact], message);

    if (push.ok) {
      logSync({
        profileId,
        catalogProfileId: bundle.profileId,
        reason,
        status: 'success',
        commitSha: push.commitSha,
        filesCommitted: push.filesCommitted.length,
      });
      breakerUntil.delete(profileId);
      return { ok: true, status: 'success', commitSha: push.commitSha, filesCommitted: push.filesCommitted.length };
    }

    logSync({
      profileId,
      catalogProfileId: bundle.profileId,
      reason,
      status: 'error',
      errorMessage: push.error ?? 'unknown',
    });
    recordFailure(profileId);
    return { ok: false, status: 'error', error: push.error ?? 'unknown' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logSync({ profileId, catalogProfileId: null, reason, status: 'error', errorMessage: msg });
    recordFailure(profileId);
    return { ok: false, status: 'error', error: msg };
  }
}

/**
 * Read the N most recent sync log rows. Used by the Settings widget.
 */
export function getRecentSyncLog(limit = 25) {
  return db.select()
    .from(catalogSyncLog)
    .orderBy(desc(catalogSyncLog.createdAt))
    .limit(limit)
    .all();
}

export function getLastSuccessfulSync() {
  return db.select()
    .from(catalogSyncLog)
    .where(eq(catalogSyncLog.status, 'success'))
    .orderBy(desc(catalogSyncLog.createdAt))
    .limit(1)
    .get() ?? null;
}
