import { db } from '@/db/client';
import { catalogSyncLog, deviceProfiles } from '@/db/schema';
import { eq, desc } from 'drizzle-orm';
import {
  isCatalogEnabled,
  isAutoSyncEnabled,
  isGitHubPublishConfigured,
  getGitHubPublishStatus,
  getRecentSyncLog,
  getLastSuccessfulSync,
} from '@/modules/catalog';
import { parsePrNumber } from './parse-pr-number';

export const runtime = 'nodejs';

/**
 * GET /api/catalog/sync-status
 * Returns auto-sync state + last successful sync + recent log entries.
 * Read by the Settings widget to render "letzte Synchronisation".
 */
export async function GET() {
  const catalogEnabled = isCatalogEnabled();
  const autoSyncEnabled = isAutoSyncEnabled();
  const tokenConfigured = isGitHubPublishConfigured();
  const { disabledReason } = getGitHubPublishStatus();

  const lastSuccess = getLastSuccessfulSync();
  const recent = getRecentSyncLog(25);

  // Annotate log entries with profile name when available.
  const profileNames = new Map<number, string>();
  const ids = new Set(recent.map((r) => r.profileId).filter((v): v is number => v != null));
  if (ids.size > 0) {
    const rows = db.select({ id: deviceProfiles.id, name: deviceProfiles.name })
      .from(deviceProfiles)
      .all();
    for (const r of rows) profileNames.set(r.id, r.name);
  }

  const recentSyncErrors = db.select()
    .from(catalogSyncLog)
    .where(eq(catalogSyncLog.status, 'error'))
    .orderBy(desc(catalogSyncLog.createdAt))
    .limit(5)
    .all();

  // Derive lastPr from the most recent successful sync's pr_url. Branch is
  // not persisted separately in catalog_sync_log (would need another
  // migration); the URL + number are enough for the UI to render the link.
  const lastPrNumber = parsePrNumber(lastSuccess?.prUrl ?? null);
  const lastPr =
    lastSuccess?.prUrl && lastPrNumber != null
      ? { number: lastPrNumber, url: lastSuccess.prUrl, branch: null as string | null }
      : null;

  return Response.json({
    catalogEnabled,
    autoSyncEnabled,
    tokenConfigured,
    canAutoSync: catalogEnabled && autoSyncEnabled && tokenConfigured,
    disabledReason,
    lastPr,
    lastSuccess: lastSuccess
      ? {
          ...lastSuccess,
          profileName: lastSuccess.profileId != null ? profileNames.get(lastSuccess.profileId) ?? null : null,
        }
      : null,
    recentSyncErrors: recentSyncErrors.map((r) => ({
      ...r,
      profileName: r.profileId != null ? profileNames.get(r.profileId) ?? null : null,
    })),
    log: recent.map((r) => ({
      ...r,
      profileName: r.profileId != null ? profileNames.get(r.profileId) ?? null : null,
    })),
  });
}
