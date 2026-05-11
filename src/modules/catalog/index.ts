import 'server-only';
import { db } from '@/db/client';
import { config } from '@/db/schema';
import { eq } from 'drizzle-orm';

export const CATALOG_ENABLED_KEY = 'catalog.enabled';

export function isCatalogEnabled(): boolean {
  try {
    const row = db.select().from(config).where(eq(config.key, CATALOG_ENABLED_KEY)).get();
    return row?.value === 'true';
  } catch {
    return false;
  }
}

export type { CatalogIndex, CatalogProfile, CatalogCharger, CatalogMatch, CurvePoint } from './types';
export { loadIndex, loadProfile, loadCharger, loadCurvePoints, readPhoto } from './loader';
export { findMatches, resamplePower } from './match';
export { importProfile, importChargerOnly } from './import';
export { buildPublishBundle, rebuildIndex, type PublishBundle, type PublishArtifact, type ValidationIssue } from './publish';
export { publishToGitHub, isGitHubPublishConfigured, type GitHubPushResult } from './github-publish';
