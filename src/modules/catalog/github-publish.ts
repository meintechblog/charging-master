import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { catalogAppEnv, catalogAppEnvError } from '@/lib/env';
import { getInstallationToken } from '@/lib/github-app-auth';
import type { PublishArtifact } from './publish';

const API_BASE = 'https://api.github.com';
const USER_AGENT = 'charging-master-catalog';
const LABEL = 'auto-sync';

export type GitHubPublishResult = {
  ok: boolean;
  filesCommitted: string[];
  commitSha: string | null;
  prUrl?: string | null;
  prNumber?: number | null;
  branchName?: string | null;
  error?: string;
};
// Backward-compat alias — auto-sync.ts and sync-status read push.commitSha,
// push.filesCommitted, push.error. All preserved.
export type GitHubPushResult = GitHubPublishResult;

export type PublishMeta = {
  profileSlug?: string;
  syncLogId?: number | null;
};

export function getGitHubPublishStatus(): { configured: boolean; disabledReason: string | null } {
  if (!catalogAppEnv) {
    return { configured: false, disabledReason: catalogAppEnvError ?? 'github_app_env_missing' };
  }
  return { configured: true, disabledReason: null };
}

// Backward-compat boolean shim — existing callers only need the boolean.
export function isGitHubPublishConfigured(): boolean {
  return getGitHubPublishStatus().configured;
}

async function ghFetch(token: string, urlPath: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${API_BASE}${urlPath}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': USER_AGENT,
      ...(init.headers ?? {}),
    },
  });
}

function buildBranchName(profileSlug: string | undefined, msTs: number): string {
  const slug = (profileSlug ?? 'profile')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'profile';
  return `submissions/${slug}-${msTs}`;
}

function buildPrBody(message: string, meta: PublishMeta, artifactPaths: string[]): string {
  const syncId = meta.syncLogId ?? null;
  const reason = message.replace(/^catalog: auto-sync /, '').split(' (')[0] ?? 'unknown';
  const fileList = artifactPaths.map((p) => `- \`${p}\``).join('\n');
  return [
    `Trigger: ${reason}`,
    `Sync log: ${syncId}`,
    '',
    '**Files in this submission:**',
    fileList,
    '',
    `<!-- catalog-autosync: id=${syncId} reason=${reason} -->`,
  ].join('\n');
}

async function bodySnippet(res: Response): Promise<string> {
  try {
    const t = await res.text();
    return t.slice(0, 200);
  } catch {
    return '';
  }
}

/**
 * Publish a batch of artifacts via the v2 PR-flow: mint an installation
 * token, create a `submissions/<slug>-<ts>` branch off main, commit the
 * artifacts via the Data API onto THAT branch, open a PR against main,
 * and label it `auto-sync`. Never writes to `refs/heads/main` directly —
 * branch protection on main is the enforcement boundary.
 */
export async function publishToGitHub(
  artifacts: PublishArtifact[],
  message: string,
  meta: PublishMeta = {},
): Promise<GitHubPublishResult> {
  if (!catalogAppEnv) {
    return {
      ok: false,
      filesCommitted: [],
      commitSha: null,
      prUrl: null,
      branchName: null,
      error: 'github_app_env_missing',
    };
  }

  if (artifacts.length === 0) {
    return { ok: false, filesCommitted: [], commitSha: null, prUrl: null, branchName: null, error: 'no_artifacts' };
  }

  const {
    GITHUB_APP_ID,
    GITHUB_APP_INSTALLATION_ID,
    GITHUB_APP_PRIVATE_KEY,
    GITHUB_APP_PRIVATE_KEY_PATH,
    CATALOG_REPO_OWNER,
    CATALOG_REPO_NAME,
  } = catalogAppEnv;
  const repo = `${CATALOG_REPO_OWNER}/${CATALOG_REPO_NAME}`;

  const tokenResult = await getInstallationToken({
    appId: GITHUB_APP_ID,
    installationId: GITHUB_APP_INSTALLATION_ID,
    privateKey: GITHUB_APP_PRIVATE_KEY,
    privateKeyPath: GITHUB_APP_PRIVATE_KEY_PATH,
  });
  if (!tokenResult.ok) {
    return {
      ok: false,
      filesCommitted: [],
      commitSha: null,
      prUrl: null,
      branchName: null,
      error: `github_app_auth_failed: ${tokenResult.error}`,
    };
  }
  const token = tokenResult.token;

  try {
    // 1. Resolve main → head sha.
    const refRes = await ghFetch(token, `/repos/${repo}/git/ref/heads/main`);
    if (!refRes.ok) {
      return {
        ok: false,
        filesCommitted: [],
        commitSha: null,
        prUrl: null,
        branchName: null,
        error: `get_ref_failed: ${refRes.status} ${await bodySnippet(refRes)}`,
      };
    }
    const ref = (await refRes.json()) as { object: { sha: string } };
    const headSha = ref.object.sha;

    // 2. Get head commit → base-tree sha.
    const commitRes = await ghFetch(token, `/repos/${repo}/git/commits/${headSha}`);
    if (!commitRes.ok) {
      return {
        ok: false,
        filesCommitted: [],
        commitSha: null,
        prUrl: null,
        branchName: null,
        error: `get_commit_failed: ${commitRes.status} ${await bodySnippet(commitRes)}`,
      };
    }
    const headCommit = (await commitRes.json()) as { tree: { sha: string } };
    const baseTreeSha = headCommit.tree.sha;

    // 3. Create one blob per artifact.
    type TreeEntry = { path: string; mode: '100644'; type: 'blob'; sha: string };
    const treeEntries: TreeEntry[] = [];
    for (const a of artifacts) {
      const blobRes = await ghFetch(token, `/repos/${repo}/git/blobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: a.contentBase64, encoding: 'base64' }),
      });
      if (!blobRes.ok) {
        return {
          ok: false,
          filesCommitted: [],
          commitSha: null,
          prUrl: null,
          branchName: null,
          error: `blob_failed for ${a.path}: ${blobRes.status} ${await bodySnippet(blobRes)}`,
        };
      }
      const blob = (await blobRes.json()) as { sha: string };
      treeEntries.push({ path: a.path, mode: '100644', type: 'blob', sha: blob.sha });
    }

    // 4. Create the new tree on top of main's base tree.
    const treeRes = await ghFetch(token, `/repos/${repo}/git/trees`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base_tree: baseTreeSha, tree: treeEntries }),
    });
    if (!treeRes.ok) {
      return {
        ok: false,
        filesCommitted: [],
        commitSha: null,
        prUrl: null,
        branchName: null,
        error: `tree_failed: ${treeRes.status} ${await bodySnippet(treeRes)}`,
      };
    }
    const tree = (await treeRes.json()) as { sha: string };

    // 5. Create the commit object.
    const newCommitRes = await ghFetch(token, `/repos/${repo}/git/commits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, tree: tree.sha, parents: [headSha] }),
    });
    if (!newCommitRes.ok) {
      return {
        ok: false,
        filesCommitted: [],
        commitSha: null,
        prUrl: null,
        branchName: null,
        error: `commit_failed: ${newCommitRes.status} ${await bodySnippet(newCommitRes)}`,
      };
    }
    const newCommit = (await newCommitRes.json()) as { sha: string };

    // 6. Create the submission branch. We POST a NEW ref (`/git/refs`),
    //    NEVER PATCH `refs/heads/main`. Branch protection on main is the
    //    enforcement boundary; this code path has no fallback that touches
    //    main directly.
    let branchName = buildBranchName(meta.profileSlug, Date.now());
    // Belt+suspenders: buildBranchName cannot structurally produce 'main',
    // but assert it anyway to make accidental future regressions loud.
    if (branchName === 'main' || branchName.endsWith('/main')) {
      throw new Error('refuse_to_write_main');
    }
    let branchRes = await ghFetch(token, `/repos/${repo}/git/refs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: newCommit.sha }),
    });
    if (!branchRes.ok && branchRes.status === 422) {
      const snip = await bodySnippet(branchRes);
      if (snip.includes('Reference already exists')) {
        // Single retry with +1ms suffix.
        branchName = buildBranchName(meta.profileSlug, Date.now() + 1);
        if (branchName === 'main' || branchName.endsWith('/main')) {
          throw new Error('refuse_to_write_main');
        }
        branchRes = await ghFetch(token, `/repos/${repo}/git/refs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: newCommit.sha }),
        });
        if (!branchRes.ok) {
          return {
            ok: false,
            filesCommitted: [],
            commitSha: newCommit.sha,
            prUrl: null,
            branchName: null,
            error: `branch_create_failed: ${branchRes.status} ${await bodySnippet(branchRes)}`,
          };
        }
      } else {
        return {
          ok: false,
          filesCommitted: [],
          commitSha: newCommit.sha,
          prUrl: null,
          branchName: null,
          error: `branch_create_failed: ${branchRes.status} ${snip}`,
        };
      }
    } else if (!branchRes.ok) {
      return {
        ok: false,
        filesCommitted: [],
        commitSha: newCommit.sha,
        prUrl: null,
        branchName: null,
        error: `branch_create_failed: ${branchRes.status} ${await bodySnippet(branchRes)}`,
      };
    }

    // 7. Open PR against main.
    const prRes = await ghFetch(token, `/repos/${repo}/pulls`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: message,
        body: buildPrBody(message, meta, artifacts.map((a) => a.path)),
        head: branchName,
        base: 'main',
        draft: false,
      }),
    });
    if (!prRes.ok) {
      return {
        ok: false,
        filesCommitted: [],
        commitSha: newCommit.sha,
        prUrl: null,
        branchName,
        error: `pr_create_failed: ${prRes.status} ${await bodySnippet(prRes)}`,
      };
    }
    const pr = (await prRes.json()) as { number: number; html_url: string };
    const prNumber = pr.number;
    const prUrl = pr.html_url;

    // 8. Add the `auto-sync` label. Soft-fail: PR exists, label is cosmetic.
    try {
      const labelRes = await ghFetch(token, `/repos/${repo}/issues/${prNumber}/labels`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ labels: [LABEL] }),
      });
      if (!labelRes.ok) {
        console.warn(`label_apply_failed: ${labelRes.status} ${await bodySnippet(labelRes)}`);
      }
    } catch (err) {
      console.warn(`label_apply_failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 9. Local mirror — so this box's /api/catalog/index sees the new entries
    //    immediately (before the PR is merged + the next self-update pulls).
    for (const a of artifacts) {
      try {
        const full = path.join(process.cwd(), a.path);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, Buffer.from(a.contentBase64, 'base64'));
      } catch {
        /* non-fatal */
      }
    }

    return {
      ok: true,
      filesCommitted: artifacts.map((a) => a.path),
      commitSha: newCommit.sha,
      prUrl,
      prNumber,
      branchName,
    };
  } catch (err) {
    return {
      ok: false,
      filesCommitted: [],
      commitSha: null,
      prUrl: null,
      branchName: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
