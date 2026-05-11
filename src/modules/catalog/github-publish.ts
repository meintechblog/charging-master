import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { config } from '@/db/schema';
import type { PublishArtifact } from './publish';

const REPO_DEFAULT = 'meintechblog/charging-master';
const API_BASE = 'https://api.github.com';

export type GitHubPushResult = {
  ok: boolean;
  filesCommitted: string[];
  commitSha: string | null;
  error?: string;
};

function readToken(): string | null {
  const row = db.select().from(config).where(eq(config.key, 'github.contentsToken')).get();
  const t = row?.value?.trim();
  return t && t.length > 0 ? t : null;
}

function readRepo(): string {
  const row = db.select().from(config).where(eq(config.key, 'github.repo')).get();
  return row?.value?.trim() || REPO_DEFAULT;
}

export function isGitHubPublishConfigured(): boolean {
  return readToken() !== null;
}

async function ghFetch(token: string, urlPath: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${API_BASE}${urlPath}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'charging-master-catalog',
      ...(init.headers ?? {}),
    },
  });
}

/**
 * Commit a batch of artifacts to the repo in ONE atomic git commit via the
 * Data API (blobs + tree + commit + ref update). All artifacts share one
 * commit message. On any failure mid-stream, the local main ref is not
 * advanced — the partial blobs become unreachable garbage that GitHub gcs
 * eventually.
 */
export async function publishToGitHub(
  artifacts: PublishArtifact[],
  message: string
): Promise<GitHubPushResult> {
  const token = readToken();
  if (!token) {
    return { ok: false, filesCommitted: [], commitSha: null, error: 'github_token_not_configured' };
  }
  const repo = readRepo();
  if (artifacts.length === 0) {
    return { ok: false, filesCommitted: [], commitSha: null, error: 'no_artifacts' };
  }

  try {
    // 1. Resolve current main ref → head commit sha
    const refRes = await ghFetch(token, `/repos/${repo}/git/ref/heads/main`);
    if (!refRes.ok) {
      return { ok: false, filesCommitted: [], commitSha: null, error: `get_ref_failed: ${refRes.status} ${await refRes.text().then((t) => t.slice(0, 200))}` };
    }
    const ref = (await refRes.json()) as { object: { sha: string } };
    const headSha = ref.object.sha;

    // 2. Get head commit → tree sha
    const commitRes = await ghFetch(token, `/repos/${repo}/git/commits/${headSha}`);
    if (!commitRes.ok) {
      return { ok: false, filesCommitted: [], commitSha: null, error: `get_commit_failed: ${commitRes.status}` };
    }
    const commit = (await commitRes.json()) as { tree: { sha: string } };
    const baseTreeSha = commit.tree.sha;

    // 3. Create blobs for each artifact
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
          error: `blob_failed for ${a.path}: ${blobRes.status} ${await blobRes.text().then((t) => t.slice(0, 200))}`,
        };
      }
      const blob = (await blobRes.json()) as { sha: string };
      treeEntries.push({ path: a.path, mode: '100644', type: 'blob', sha: blob.sha });
    }

    // 4. Create a tree based on the current head's tree
    const treeRes = await ghFetch(token, `/repos/${repo}/git/trees`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base_tree: baseTreeSha, tree: treeEntries }),
    });
    if (!treeRes.ok) {
      return { ok: false, filesCommitted: [], commitSha: null, error: `tree_failed: ${treeRes.status} ${await treeRes.text().then((t) => t.slice(0, 200))}` };
    }
    const tree = (await treeRes.json()) as { sha: string };

    // 5. Create the commit
    const newCommitRes = await ghFetch(token, `/repos/${repo}/git/commits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, tree: tree.sha, parents: [headSha] }),
    });
    if (!newCommitRes.ok) {
      return { ok: false, filesCommitted: [], commitSha: null, error: `commit_failed: ${newCommitRes.status}` };
    }
    const newCommit = (await newCommitRes.json()) as { sha: string };

    // 6. Fast-forward main
    const patchRes = await ghFetch(token, `/repos/${repo}/git/refs/heads/main`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sha: newCommit.sha }),
    });
    if (!patchRes.ok) {
      return {
        ok: false,
        filesCommitted: [],
        commitSha: null,
        error: `ref_update_failed: ${patchRes.status} ${await patchRes.text().then((t) => t.slice(0, 200))}`,
      };
    }

    // 7. Also write to local catalog/ so this box's next /api/catalog/index
    //    shows the new entries WITHOUT waiting for the next self-update.
    for (const a of artifacts) {
      try {
        const full = path.join(process.cwd(), a.path);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, Buffer.from(a.contentBase64, 'base64'));
      } catch { /* non-fatal */ }
    }

    return { ok: true, filesCommitted: artifacts.map((a) => a.path), commitSha: newCommit.sha };
  } catch (err) {
    return {
      ok: false,
      filesCommitted: [],
      commitSha: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
