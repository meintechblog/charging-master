// src/modules/self-update/github-client.ts
// Native fetch + zod client for the GitHub /commits/main endpoint.
// Spec locked in .planning/phases/08-github-polling-detection/08-CONTEXT.md.
//
// Contract:
//   - NEVER throws. Transient failures must not crash the scheduler tick.
//   - Always returns a LastCheckResult discriminated union.
//   - Sends If-None-Match when an ETag is provided (P8 — rate-limit defense).
//   - 10s AbortController timeout.
//   - Zod-validates the 200 payload so shape drift fails loud (as status:'error').

import { z } from 'zod';
import { CURRENT_SHA_SHORT } from '@/lib/version';
import type { LastCheckResult } from './types';

const GITHUB_COMMITS_URL =
  'https://api.github.com/repos/meintechblog/charging-master/commits/main';

const DEFAULT_TIMEOUT_MS = 10_000;

// Minimal shape — only the fields we consume. We DO NOT validate the full
// commit payload because GitHub reserves the right to add fields.
const CommitResponseSchema = z.object({
  sha: z.string().min(7),
  commit: z.object({
    message: z.string(),
    author: z.object({
      name: z.string(),
      date: z.string(), // ISO 8601
    }),
  }),
});

export type GitHubClientOptions = {
  /** Value of lastCheckEtag from state.json. Sent verbatim in If-None-Match. */
  etag?: string | null;
  /** Override for testing; defaults to 10s. */
  timeoutMs?: number;
};

export class GitHubClient {
  /**
   * Performs a conditional GET against /commits/main.
   *
   * Return shape is intentionally NOT a tuple of (result, newEtag) — callers
   * that need the ETag read it from `etag` on the return object for the 'ok'
   * case (since only 200 responses carry a new ETag that should be persisted).
   * For 304 responses the caller should preserve the previously-stored ETag;
   * for all other responses the ETag should be left as-is.
   */
  async checkLatestCommit(
    options: GitHubClientOptions = {},
  ): Promise<{ result: LastCheckResult; etag: string | null }> {
    const { etag = null, timeoutMs = DEFAULT_TIMEOUT_MS } = options;

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const headers: Record<string, string> = {
        Accept: 'application/vnd.github+json',
        // GitHub requires a User-Agent. Tagging it with our short SHA lets
        // them (and us) trace which build made the call if something odd
        // shows up in their logs.
        'User-Agent': `charging-master-self-update/${CURRENT_SHA_SHORT}`,
        'X-GitHub-Api-Version': '2022-11-28',
      };
      if (etag !== null && etag !== '') {
        headers['If-None-Match'] = etag;
      }

      const response = await fetch(GITHUB_COMMITS_URL, {
        method: 'GET',
        headers,
        signal: controller.signal,
        // No caching — every call hits GitHub. ETag is the sole cache mechanism.
        cache: 'no-store',
      });

      // 304 — ETag matched. No body. Preserve previous ETag (return null to
      // signal "do not change lastCheckEtag"; caller treats null as "keep what
      // you have" for the unchanged branch).
      if (response.status === 304) {
        return { result: { status: 'unchanged' }, etag: null };
      }

      // 403/429 — rate limited. GitHub returns x-ratelimit-reset as epoch seconds.
      if (response.status === 403 || response.status === 429) {
        const resetRaw = response.headers.get('x-ratelimit-reset');
        const resetAt = resetRaw ? Number(resetRaw) : 0;
        return {
          result: { status: 'rate_limited', resetAt: Number.isFinite(resetAt) ? resetAt : 0 },
          etag: null,
        };
      }

      // Any other non-200 → error.
      if (!response.ok) {
        return {
          result: {
            status: 'error',
            error: `GitHub HTTP ${response.status} ${response.statusText || ''}`.trim(),
          },
          etag: null,
        };
      }

      // 200 — parse, validate, map.
      let json: unknown;
      try {
        json = await response.json();
      } catch (err) {
        return {
          result: {
            status: 'error',
            error: `GitHub response not JSON: ${err instanceof Error ? err.message : String(err)}`,
          },
          etag: null,
        };
      }

      const parsed = CommitResponseSchema.safeParse(json);
      if (!parsed.success) {
        return {
          result: {
            status: 'error',
            error: `GitHub response shape unexpected: ${parsed.error.issues[0]?.message ?? 'zod parse failed'}`,
          },
          etag: null,
        };
      }

      const newEtag = response.headers.get('etag');
      const { sha, commit } = parsed.data;

      return {
        result: {
          status: 'ok',
          remoteSha: sha,
          remoteShaShort: sha.slice(0, 7),
          message: commit.message,
          author: commit.author.name,
          date: commit.author.date,
        },
        etag: newEtag,
      };
    } catch (err) {
      // AbortError (timeout), network error, DNS failure, etc.
      const isAbort = err instanceof Error && err.name === 'AbortError';
      return {
        result: {
          status: 'error',
          error: isAbort
            ? `GitHub request timed out after ${timeoutMs}ms`
            : `GitHub fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        },
        etag: null,
      };
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}
