import {
  isCatalogEnabled,
  buildPublishBundle,
  publishToGitHub,
  isGitHubPublishConfigured,
  rebuildIndex,
  loadProfile,
  loadCharger,
  type PublishArtifact,
} from '@/modules/catalog';

export const runtime = 'nodejs';

/**
 * POST /api/catalog/submit-profile
 * Body: { profileId: number, mode?: 'auto' | 'manual', commitMessage?: string }
 *
 * Validates the local profile against catalog quality gates and either
 * commits the new entries to GitHub directly (mode=auto, requires
 * config.github.contentsToken to be set) or returns the artifacts for the
 * caller to download + commit manually.
 *
 * Always returns the issue list — submit goes through only when there are
 * no severity=error issues.
 */
export async function POST(request: Request) {
  if (!isCatalogEnabled()) {
    return Response.json({ error: 'catalog_disabled' }, { status: 403 });
  }

  let body: { profileId?: number; mode?: 'auto' | 'manual'; commitMessage?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid_body' }, { status: 400 });
  }
  if (typeof body.profileId !== 'number' || !Number.isInteger(body.profileId)) {
    return Response.json({ error: 'invalid_profile_id' }, { status: 400 });
  }

  const bundle = await buildPublishBundle(body.profileId);
  if (!bundle) {
    return Response.json({ error: 'profile_not_found_or_no_curve' }, { status: 404 });
  }

  const fatal = bundle.issues.filter((i) => i.severity === 'error');
  if (fatal.length > 0) {
    return Response.json(
      {
        ok: false,
        profileCatalogId: bundle.profileId,
        chargerCatalogId: bundle.chargerId,
        issues: bundle.issues,
      },
      { status: 422 }
    );
  }

  const desiredMode = body.mode ?? (isGitHubPublishConfigured() ? 'auto' : 'manual');

  if (desiredMode === 'manual') {
    return Response.json({
      ok: true,
      mode: 'manual',
      profileCatalogId: bundle.profileId,
      chargerCatalogId: bundle.chargerId,
      issues: bundle.issues,
      artifacts: bundle.artifacts,
    });
  }

  // Auto-publish path. Add a regenerated INDEX.json on top of the artifacts
  // so the commit ships a consistent index.
  const profileJson = loadProfile(bundle.profileId); // may be on disk already
  const chargerJson = bundle.chargerId ? loadCharger(bundle.chargerId) : null;
  // Use the bundle artifacts' actual JSON contents in case loader can't see
  // brand-new entries (file isn't on disk yet on this box).
  const extraProfiles = [];
  const extraChargers = [];
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
  if (profileJson && !extraProfiles.find((p) => p.id === profileJson.id)) extraProfiles.push(profileJson);
  if (chargerJson && !extraChargers.find((c) => c.id === chargerJson.id)) extraChargers.push(chargerJson);

  const newIndex = rebuildIndex(extraProfiles, extraChargers);
  const indexArtifact: PublishArtifact = {
    path: 'catalog/INDEX.json',
    contentType: 'application/json',
    contentBase64: Buffer.from(JSON.stringify(newIndex, null, 2) + '\n').toString('base64'),
  };

  const commitMessage =
    body.commitMessage?.trim() ||
    `catalog: add ${bundle.profileId.slice(0, 8)} (${extraProfiles[0]?.name ?? 'profile'})`;

  const push = await publishToGitHub([...bundle.artifacts, indexArtifact], commitMessage);

  return Response.json({
    ok: push.ok,
    mode: 'auto',
    profileCatalogId: bundle.profileId,
    chargerCatalogId: bundle.chargerId,
    issues: bundle.issues,
    commitSha: push.commitSha,
    filesCommitted: push.filesCommitted,
    error: push.error,
  }, { status: push.ok ? 200 : 502 });
}
