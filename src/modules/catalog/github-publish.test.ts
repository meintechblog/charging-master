import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';

// `server-only` throws in non-Next bundlers. Stub it to a no-op so vitest
// can import github-publish.
vi.mock('server-only', () => ({}));

// Stub fs writes so the local-mirror block in publishToGitHub does not
// clobber real catalog/* files on the developer's machine when tests run.
// The mirror behaviour is non-fatal and orthogonal to the GitHub API
// pipeline we're testing — assert it does NOT crash, but don't actually
// touch disk.
vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);

// We also need to control env via vi.doMock — env.ts reads process.env at
// import time. The test file mocks @/lib/env directly so we can flip
// catalogAppEnv on/off per test.
vi.mock('@/lib/env', () => ({
  env: { DATABASE_PATH: 'data/charging-master.db', PORT: 3000 },
  catalogAppEnv: {
    GITHUB_APP_ID: '12345',
    GITHUB_APP_INSTALLATION_ID: 'inst-1',
    GITHUB_APP_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----',
    CATALOG_REPO_OWNER: 'foo',
    CATALOG_REPO_NAME: 'bar',
  },
  catalogAppEnvError: null,
}));

// Mock the auth module so we don't try to actually sign a JWT in the test —
// the JWT path is exercised by github-app-auth.test.ts.
vi.mock('@/lib/github-app-auth', () => ({
  getInstallationToken: vi.fn().mockResolvedValue({
    ok: true,
    token: 'ghs_test_token_value_xxxxxxx',
    expiresAt: Date.now() + 60 * 60_000,
  }),
}));

import * as envMod from '@/lib/env';
import * as authMod from '@/lib/github-app-auth';
const { publishToGitHub } = await import('./github-publish');
import type { PublishArtifact } from './publish';

type FetchStep = {
  match: (url: string, init: RequestInit | undefined) => boolean;
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  label?: string;
};

function setupFetchSequence(steps: FetchStep[]): {
  fetchMock: ReturnType<typeof vi.fn>;
  calls: { url: string; method: string; bodyText: string | null }[];
} {
  const calls: { url: string; method: string; bodyText: string | null }[] = [];
  let idx = 0;
  const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const bodyText = typeof init?.body === 'string' ? init.body : null;
    calls.push({ url, method, bodyText });
    if (idx >= steps.length) {
      throw new Error(`fetch sequence exhausted at call #${idx}: ${method} ${url}`);
    }
    const step = steps[idx]!;
    if (!step.match(url, init)) {
      throw new Error(
        `fetch sequence mismatch at step #${idx}${step.label ? ' (' + step.label + ')' : ''}: got ${method} ${url}`,
      );
    }
    idx++;
    const body = step.body === undefined ? '' : JSON.stringify(step.body);
    return new Response(body, { status: step.status, headers: step.headers });
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return { fetchMock, calls };
}

const ARTIFACT_A: PublishArtifact = {
  path: 'catalog/profiles/abc123.json',
  contentType: 'application/json',
  contentBase64: Buffer.from('{"id":"abc123"}').toString('base64'),
};
const ARTIFACT_INDEX: PublishArtifact = {
  path: 'catalog/INDEX.json',
  contentType: 'application/json',
  contentBase64: Buffer.from('{"profiles":[]}').toString('base64'),
};

describe('publishToGitHub — env guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Restore the auto-sync mock for downstream tests.
    (envMod as unknown as { catalogAppEnv: unknown }).catalogAppEnv = {
      GITHUB_APP_ID: '12345',
      GITHUB_APP_INSTALLATION_ID: 'inst-1',
      GITHUB_APP_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----',
      CATALOG_REPO_OWNER: 'foo',
      CATALOG_REPO_NAME: 'bar',
    };
    (envMod as unknown as { catalogAppEnvError: string | null }).catalogAppEnvError = null;
  });

  it('returns github_app_env_missing without any network call when catalogAppEnv is null', async () => {
    (envMod as unknown as { catalogAppEnv: unknown }).catalogAppEnv = null;
    (envMod as unknown as { catalogAppEnvError: string | null }).catalogAppEnvError = 'env_invalid';
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await publishToGitHub([ARTIFACT_A], 'catalog: auto-sync curve-save (test)');
    expect(res).toEqual({
      ok: false,
      filesCommitted: [],
      commitSha: null,
      prUrl: null,
      branchName: null,
      error: 'github_app_env_missing',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns no_artifacts when called with empty artifacts list', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const res = await publishToGitHub([], 'catalog: auto-sync manual (none)');
    expect(res.ok).toBe(false);
    expect(res.error).toBe('no_artifacts');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('publishToGitHub — happy path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (authMod.getInstallationToken as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      token: 'ghs_test_token_value_xxxxxxx',
      expiresAt: Date.now() + 60 * 60_000,
    });
  });

  it('completes the 7-stage pipeline and returns prUrl + prNumber + branchName', async () => {
    const artifacts = [ARTIFACT_A, ARTIFACT_INDEX];

    const { calls } = setupFetchSequence([
      { label: 'get_ref', match: (u, i) => u.endsWith('/git/ref/heads/main') && (i?.method ?? 'GET') === 'GET', status: 200, body: { object: { sha: 'HEAD_SHA' } } },
      { label: 'get_commit', match: (u) => u.endsWith('/git/commits/HEAD_SHA'), status: 200, body: { tree: { sha: 'BASE_TREE' } } },
      { label: 'blob_0', match: (u, i) => u.endsWith('/git/blobs') && i?.method === 'POST', status: 201, body: { sha: 'BLOB_0' } },
      { label: 'blob_1', match: (u, i) => u.endsWith('/git/blobs') && i?.method === 'POST', status: 201, body: { sha: 'BLOB_1' } },
      { label: 'tree', match: (u, i) => u.endsWith('/git/trees') && i?.method === 'POST', status: 201, body: { sha: 'NEW_TREE' } },
      { label: 'commit', match: (u, i) => u.endsWith('/git/commits') && i?.method === 'POST', status: 201, body: { sha: 'NEW_COMMIT' } },
      { label: 'branch_create', match: (u, i) => u.endsWith('/git/refs') && i?.method === 'POST', status: 201, body: {} },
      { label: 'pr_create', match: (u, i) => u.endsWith('/pulls') && i?.method === 'POST', status: 201, body: { number: 42, html_url: 'https://github.com/foo/bar/pull/42' } },
      { label: 'label_apply', match: (u, i) => u.endsWith('/issues/42/labels') && i?.method === 'POST', status: 200, body: [] },
    ]);

    const res = await publishToGitHub(artifacts, 'catalog: auto-sync curve-save (bosch-powertube)', { profileSlug: 'bosch-powertube-625' });

    expect(res.ok).toBe(true);
    expect(res.commitSha).toBe('NEW_COMMIT');
    expect(res.prUrl).toBe('https://github.com/foo/bar/pull/42');
    expect(res.prNumber).toBe(42);
    expect(res.branchName).toMatch(/^submissions\/bosch-powertube-625-\d{13}$/);
    expect(res.filesCommitted).toEqual(['catalog/profiles/abc123.json', 'catalog/INDEX.json']);

    // Anti-goal: assert no PATCH on refs/heads/main occurred.
    const directMainPatch = calls.find(
      (c) => c.url.endsWith('/git/refs/heads/main') && c.method === 'PATCH',
    );
    expect(directMainPatch).toBeUndefined();

    // Branch ref body contains submissions/<slug>-<msTs>.
    const branchCreate = calls.find(
      (c) => c.url.endsWith('/git/refs') && c.method === 'POST',
    );
    expect(branchCreate?.bodyText).toMatch(/"ref":"refs\/heads\/submissions\/bosch-powertube-625-\d{13}"/);
    expect(branchCreate?.bodyText).toContain('"sha":"NEW_COMMIT"');

    // PR title == message verbatim.
    const prCreate = calls.find((c) => c.url.endsWith('/pulls') && c.method === 'POST');
    expect(prCreate?.bodyText).toContain('"title":"catalog: auto-sync curve-save (bosch-powertube)"');
    // PR body has the machine-readable footer; syncLogId undefined => id=null.
    expect(prCreate?.bodyText).toContain('catalog-autosync: id=null reason=curve-save');
  });
});

describe('publishToGitHub — failure modes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns github_app_auth_failed when getInstallationToken returns ok:false', async () => {
    (authMod.getInstallationToken as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      error: 'github_app_unauthorized',
    });
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await publishToGitHub([ARTIFACT_A], 'catalog: auto-sync curve-save (x)');
    expect(res.ok).toBe(false);
    expect(res.error).toBe('github_app_auth_failed: github_app_unauthorized');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns pr_create_failed but preserves commitSha + branchName when PR step 422s', async () => {
    (authMod.getInstallationToken as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      token: 'ghs_test_token_value_xxxxxxx',
      expiresAt: Date.now() + 60 * 60_000,
    });
    setupFetchSequence([
      { match: (u) => u.endsWith('/git/ref/heads/main'), status: 200, body: { object: { sha: 'H' } } },
      { match: (u) => u.endsWith('/git/commits/H'), status: 200, body: { tree: { sha: 'T' } } },
      { match: (u) => u.endsWith('/git/blobs'), status: 201, body: { sha: 'B' } },
      { match: (u) => u.endsWith('/git/trees'), status: 201, body: { sha: 'NT' } },
      { match: (u) => u.endsWith('/git/commits'), status: 201, body: { sha: 'NC' } },
      { match: (u) => u.endsWith('/git/refs'), status: 201, body: {} },
      { match: (u) => u.endsWith('/pulls'), status: 422, body: { message: 'no commits between main and submissions/...' } },
    ]);

    const res = await publishToGitHub([ARTIFACT_A], 'catalog: auto-sync test (x)', { profileSlug: 'x' });
    expect(res.ok).toBe(false);
    expect(res.commitSha).toBe('NC');
    expect(res.branchName).toMatch(/^submissions\/x-\d{13}$/);
    expect(res.error).toMatch(/^pr_create_failed: 422/);
  });

  it('retries branch_create once on 422 "Reference already exists" with msTs+1', async () => {
    (authMod.getInstallationToken as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      token: 'ghs_test_token_value_xxxxxxx',
      expiresAt: Date.now() + 60 * 60_000,
    });
    const { calls } = setupFetchSequence([
      { match: (u) => u.endsWith('/git/ref/heads/main'), status: 200, body: { object: { sha: 'H' } } },
      { match: (u) => u.endsWith('/git/commits/H'), status: 200, body: { tree: { sha: 'T' } } },
      { match: (u) => u.endsWith('/git/blobs'), status: 201, body: { sha: 'B' } },
      { match: (u) => u.endsWith('/git/trees'), status: 201, body: { sha: 'NT' } },
      { match: (u) => u.endsWith('/git/commits'), status: 201, body: { sha: 'NC' } },
      { match: (u) => u.endsWith('/git/refs'), status: 422, body: { message: 'Reference already exists' } },
      { match: (u) => u.endsWith('/git/refs'), status: 201, body: {} },
      { match: (u) => u.endsWith('/pulls'), status: 201, body: { number: 7, html_url: 'https://github.com/foo/bar/pull/7' } },
      { match: (u) => u.endsWith('/issues/7/labels'), status: 200, body: [] },
    ]);

    const res = await publishToGitHub([ARTIFACT_A], 'catalog: auto-sync curve-save (y)', { profileSlug: 'y' });
    expect(res.ok).toBe(true);
    expect(res.prNumber).toBe(7);
    // Two POSTs to /git/refs (first 422 'Reference already exists', then 201)
    const refsCalls = calls.filter((c) => c.url.endsWith('/git/refs') && c.method === 'POST');
    expect(refsCalls).toHaveLength(2);
  });

  it('returns ok:true even if label_apply step fails (soft-fail)', async () => {
    (authMod.getInstallationToken as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      token: 'ghs_test_token_value_xxxxxxx',
      expiresAt: Date.now() + 60 * 60_000,
    });
    setupFetchSequence([
      { match: (u) => u.endsWith('/git/ref/heads/main'), status: 200, body: { object: { sha: 'H' } } },
      { match: (u) => u.endsWith('/git/commits/H'), status: 200, body: { tree: { sha: 'T' } } },
      { match: (u) => u.endsWith('/git/blobs'), status: 201, body: { sha: 'B' } },
      { match: (u) => u.endsWith('/git/trees'), status: 201, body: { sha: 'NT' } },
      { match: (u) => u.endsWith('/git/commits'), status: 201, body: { sha: 'NC' } },
      { match: (u) => u.endsWith('/git/refs'), status: 201, body: {} },
      { match: (u) => u.endsWith('/pulls'), status: 201, body: { number: 7, html_url: 'https://github.com/foo/bar/pull/7' } },
      { match: (u) => u.endsWith('/issues/7/labels'), status: 500, body: { message: 'oops' } },
    ]);

    // Silence the console.warn label_apply_failed during the test.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await publishToGitHub([ARTIFACT_A], 'catalog: auto-sync curve-save (z)', { profileSlug: 'z' });
    expect(res.ok).toBe(true);
    expect(res.prUrl).toBe('https://github.com/foo/bar/pull/7');
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
