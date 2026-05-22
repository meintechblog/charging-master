/**
 * GET /api/catalog/sync-status — unit tests.
 *
 * Focused on Wave-2 extensions:
 *   - parsePrNumber regex robustness (well-formed URL, malformed, null, fragments).
 *   - lastPr is null when getLastSuccessfulSync returns null or its prUrl is null.
 *   - lastPr is the parsed `{number, url, branch:null}` triple when prUrl matches /\/pull\/\d+$/.
 *   - disabledReason mirrors getGitHubPublishStatus().disabledReason.
 *
 * Pattern mirrors src/app/api/internal/reset-update-state/route.test.ts —
 * vi.mock the catalog module + db client BEFORE importing the route handler.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks (hoisted so the factories can reference these) ---

const mocks = vi.hoisted(() => {
  return {
    isCatalogEnabled: vi.fn(() => true),
    isAutoSyncEnabled: vi.fn(() => true),
    isGitHubPublishConfigured: vi.fn(() => true),
    getGitHubPublishStatus: vi.fn(() => ({ configured: true, disabledReason: null as string | null })),
    getRecentSyncLog: vi.fn<(limit?: number) => unknown[]>(() => []),
    getLastSuccessfulSync: vi.fn<() => unknown>(() => null),
  };
});

vi.mock('@/modules/catalog', () => ({
  isCatalogEnabled: mocks.isCatalogEnabled,
  isAutoSyncEnabled: mocks.isAutoSyncEnabled,
  isGitHubPublishConfigured: mocks.isGitHubPublishConfigured,
  getGitHubPublishStatus: mocks.getGitHubPublishStatus,
  getRecentSyncLog: mocks.getRecentSyncLog,
  getLastSuccessfulSync: mocks.getLastSuccessfulSync,
}));

// db.select() chain — return empty arrays for log + errors.
vi.mock('@/db/client', () => {
  const chain = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    orderBy: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    all: vi.fn(() => [] as unknown[]),
  };
  return { db: { select: vi.fn(() => chain) } };
});

vi.mock('@/db/schema', () => ({
  catalogSyncLog: { status: 'status', createdAt: 'createdAt' },
  deviceProfiles: { id: 'id', name: 'name' },
}));

// drizzle-orm helpers are called for column expressions; passthrough.
vi.mock('drizzle-orm', () => ({
  eq: (...args: unknown[]) => args,
  desc: (...args: unknown[]) => args,
}));

// Import AFTER mocks are in place.
import { GET } from './route';
import { parsePrNumber } from './parse-pr-number';

function defaultSyncRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 42,
    profileId: 7,
    catalogProfileId: 'bosch-powertube-625',
    reason: 'photo-upload',
    status: 'success',
    commitSha: 'abc1234',
    prUrl: 'https://github.com/meintechblog/charging-master-catalog/pull/42',
    filesCommitted: 3,
    errorMessage: null,
    createdAt: 1700000000000,
    ...overrides,
  };
}

describe('parsePrNumber', () => {
  it('extracts the number from a canonical github PR URL', () => {
    expect(parsePrNumber('https://github.com/owner/repo/pull/42')).toBe(42);
  });

  it('extracts large numbers correctly', () => {
    expect(parsePrNumber('https://github.com/owner/repo/pull/123456')).toBe(123456);
  });

  it('returns null for null input', () => {
    expect(parsePrNumber(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(parsePrNumber(undefined)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parsePrNumber('')).toBeNull();
  });

  it('returns null for a URL with no /pull/ segment', () => {
    expect(parsePrNumber('https://github.com/owner/repo/issues/42')).toBeNull();
  });

  it('returns null for a URL with non-digit pull suffix', () => {
    expect(parsePrNumber('https://github.com/owner/repo/pull/abc')).toBeNull();
  });

  it('returns null for a URL with trailing fragment after the number', () => {
    // Anchor is end-of-string ($) — fragments like #event-... do not match.
    expect(parsePrNumber('https://github.com/owner/repo/pull/42#event-12345')).toBeNull();
  });

  it('returns null for a URL with a query-string after the number', () => {
    expect(parsePrNumber('https://github.com/owner/repo/pull/42?diff=split')).toBeNull();
  });

  it('returns null for plain garbage', () => {
    expect(parsePrNumber('not a url')).toBeNull();
  });
});

describe('GET /api/catalog/sync-status', () => {
  beforeEach(() => {
    mocks.isCatalogEnabled.mockReturnValue(true);
    mocks.isAutoSyncEnabled.mockReturnValue(true);
    mocks.isGitHubPublishConfigured.mockReturnValue(true);
    mocks.getGitHubPublishStatus.mockReturnValue({ configured: true, disabledReason: null });
    mocks.getRecentSyncLog.mockReturnValue([]);
    mocks.getLastSuccessfulSync.mockReturnValue(null);
  });

  it('returns lastPr=null when there is no successful sync yet', async () => {
    mocks.getLastSuccessfulSync.mockReturnValue(null);
    const res = await GET();
    const body = (await res.json()) as { lastPr: unknown };
    expect(body.lastPr).toBeNull();
  });

  it('returns lastPr=null when lastSuccess has a null prUrl (legacy row)', async () => {
    mocks.getLastSuccessfulSync.mockReturnValue(defaultSyncRow({ prUrl: null }));
    const res = await GET();
    const body = (await res.json()) as { lastPr: unknown };
    expect(body.lastPr).toBeNull();
  });

  it('returns lastPr={number,url,branch:null} for a well-formed prUrl', async () => {
    mocks.getLastSuccessfulSync.mockReturnValue(defaultSyncRow());
    const res = await GET();
    const body = (await res.json()) as {
      lastPr: { number: number; url: string; branch: string | null } | null;
    };
    expect(body.lastPr).toEqual({
      number: 42,
      url: 'https://github.com/meintechblog/charging-master-catalog/pull/42',
      branch: null,
    });
  });

  it('returns lastPr=null when prUrl is malformed (no /pull/N segment)', async () => {
    mocks.getLastSuccessfulSync.mockReturnValue(
      defaultSyncRow({ prUrl: 'https://github.com/owner/repo/issues/42' }),
    );
    const res = await GET();
    const body = (await res.json()) as { lastPr: unknown };
    expect(body.lastPr).toBeNull();
  });

  it('passes disabledReason through from getGitHubPublishStatus', async () => {
    mocks.getGitHubPublishStatus.mockReturnValue({
      configured: false,
      disabledReason: 'exactly one of GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_PATH must be set',
    });
    mocks.isGitHubPublishConfigured.mockReturnValue(false);

    const res = await GET();
    const body = (await res.json()) as { disabledReason: string | null; tokenConfigured: boolean };

    expect(body.disabledReason).toBe(
      'exactly one of GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_PATH must be set',
    );
    expect(body.tokenConfigured).toBe(false);
  });

  it('disabledReason is null when env is fully configured', async () => {
    mocks.getGitHubPublishStatus.mockReturnValue({ configured: true, disabledReason: null });
    const res = await GET();
    const body = (await res.json()) as { disabledReason: string | null; tokenConfigured: boolean };
    expect(body.disabledReason).toBeNull();
    expect(body.tokenConfigured).toBe(true);
  });

  it('preserves all existing response fields (catalogEnabled, autoSyncEnabled, canAutoSync, lastSuccess, recentSyncErrors, log)', async () => {
    mocks.getLastSuccessfulSync.mockReturnValue(defaultSyncRow());
    const res = await GET();
    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toHaveProperty('catalogEnabled', true);
    expect(body).toHaveProperty('autoSyncEnabled', true);
    expect(body).toHaveProperty('tokenConfigured', true);
    expect(body).toHaveProperty('canAutoSync', true);
    expect(body).toHaveProperty('lastSuccess');
    expect(body).toHaveProperty('recentSyncErrors');
    expect(body).toHaveProperty('log');
  });
});
