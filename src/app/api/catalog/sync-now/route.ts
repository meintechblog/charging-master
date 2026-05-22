import { db } from '@/db/client';
import { deviceProfiles, referenceCurves } from '@/db/schema';
import { eq } from 'drizzle-orm';
import {
  isCatalogEnabled,
  isGitHubPublishConfigured,
  runSyncOnce,
} from '@/modules/catalog';

export const runtime = 'nodejs';

/**
 * POST /api/catalog/sync-now
 * Body: { profileId?: number } — if absent, syncs every profile that has a
 * reference curve (used as a backfill after first-time GitHub App env wiring).
 *
 * Bypasses the debounce. Sequential to avoid hammering the GitHub Data API
 * during a backfill of dozens of profiles.
 */
export async function POST(request: Request) {
  if (!isCatalogEnabled()) {
    return Response.json({ error: 'catalog_disabled' }, { status: 403 });
  }
  if (!isGitHubPublishConfigured()) {
    return Response.json({ error: 'github_app_env_missing' }, { status: 412 });
  }

  let body: { profileId?: number } = {};
  try {
    body = await request.json();
  } catch {
    // empty body = backfill all
  }

  let targets: number[];
  if (typeof body.profileId === 'number' && Number.isInteger(body.profileId)) {
    targets = [body.profileId];
  } else {
    // All profiles that have a reference curve are publishable candidates.
    const rows = db.selectDistinct({ id: referenceCurves.profileId })
      .from(referenceCurves)
      .all();
    targets = rows.map((r) => r.id).filter((id): id is number => id != null);
  }

  if (targets.length === 0) {
    return Response.json({ ok: true, syncedProfiles: 0, results: [] });
  }

  type Outcome = {
    profileId: number;
    profileName: string | null;
    status: 'success' | 'error' | 'skipped';
    commitSha?: string | null;
    error?: string;
  };
  const results: Outcome[] = [];

  for (const profileId of targets) {
    const profile = db.select({ name: deviceProfiles.name })
      .from(deviceProfiles)
      .where(eq(deviceProfiles.id, profileId))
      .get();
    const result = await runSyncOnce(profileId, 'backfill');
    results.push({
      profileId,
      profileName: profile?.name ?? null,
      status: result.status,
      commitSha: result.commitSha ?? null,
      error: result.error,
    });
  }

  const successCount = results.filter((r) => r.status === 'success').length;
  return Response.json({
    ok: true,
    requested: targets.length,
    syncedProfiles: successCount,
    results,
  });
}
