// GitHub App JWT-mint + Installation-Token Cache.
//
// WHY no `import 'server-only'` here: this module lives under `src/lib/`,
// which is in `server.ts`' import chain (server.ts imports `@/lib/env`).
// Adding `server-only` would crash the custom Node server at boot — see
// memory `feedback_server_only_with_custom_server.md`. Safety is preserved
// because this module is only consumed by `src/modules/catalog/github-publish.ts`
// (which DOES have `server-only` and is not reachable from server.ts).
//
// Contract:
//   - mintJwt() returns a 3-part base64url string. iat = now-60s, exp = now+540s.
//   - getInstallationToken() never throws — always returns a TokenResult.
//   - Tokens are cached module-wide keyed by installationId; refreshed at T-5min.
//   - Tokens are NEVER persisted (no DB write, no disk write).

import crypto from 'node:crypto';
import fs from 'node:fs';
import { z } from 'zod/v4';

const API_BASE = 'https://api.github.com';
const USER_AGENT = 'charging-master-catalog';
const TOKEN_REFRESH_BUFFER_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

export type TokenResult =
  | { ok: true; token: string; expiresAt: number }
  | { ok: false; error: string };

const InstallationTokenResponseSchema = z.object({
  token: z.string().min(20),
  expires_at: z.string(),
});

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

function base64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf.toString('base64').replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

type LoadKeyOk = { ok: true; pem: string };
type LoadKeyErr = { ok: false; error: string };

function loadPrivateKey(opts: { privateKey?: string; privateKeyPath?: string }): LoadKeyOk | LoadKeyErr {
  const literal = opts.privateKey?.trim();
  if (literal && literal.length > 0) return { ok: true, pem: literal };
  const filePath = opts.privateKeyPath?.trim();
  if (filePath && filePath.length > 0) {
    try {
      const pem = fs.readFileSync(filePath, 'utf8');
      return { ok: true, pem };
    } catch (err) {
      return { ok: false, error: `github_app_private_key_unreadable: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  return { ok: false, error: 'github_app_private_key_missing' };
}

export function mintJwt(appId: string, privateKeyPem: string): string {
  const header = { alg: 'RS256', typ: 'JWT' };
  const nowSec = Math.floor(Date.now() / 1000);
  const payload = { iat: nowSec - 60, exp: nowSec + 540, iss: appId };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), privateKeyPem);
  return `${signingInput}.${base64url(signature)}`;
}

export type GetInstallationTokenOpts = {
  appId: string;
  installationId: string;
  privateKey?: string;
  privateKeyPath?: string;
};

export async function getInstallationToken(opts: GetInstallationTokenOpts): Promise<TokenResult> {
  const { appId, installationId } = opts;

  const cached = tokenCache.get(installationId);
  if (cached && Date.now() < cached.expiresAt - TOKEN_REFRESH_BUFFER_MS) {
    return { ok: true, token: cached.token, expiresAt: cached.expiresAt };
  }

  const keyResult = loadPrivateKey({ privateKey: opts.privateKey, privateKeyPath: opts.privateKeyPath });
  if (!keyResult.ok) return { ok: false, error: keyResult.error };

  let jwt: string;
  try {
    jwt = mintJwt(appId, keyResult.pem);
  } catch (err) {
    return { ok: false, error: `github_app_jwt_mint_failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${API_BASE}/app/installations/${installationId}/access_tokens`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': USER_AGENT,
      },
      signal: controller.signal,
    });

    if (response.status === 401) return { ok: false, error: 'github_app_unauthorized' };
    if (response.status === 404) return { ok: false, error: 'installation_not_found' };
    if (response.status === 403 || response.status === 429) return { ok: false, error: 'github_rate_limited' };
    if (!response.ok) {
      const body = await response.text().then((t) => t.slice(0, 200)).catch(() => '');
      return { ok: false, error: `github_app_token_exchange_failed: ${response.status} ${body}`.trim() };
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch (err) {
      return { ok: false, error: `token_response_not_json: ${err instanceof Error ? err.message : String(err)}` };
    }

    const parsed = InstallationTokenResponseSchema.safeParse(json);
    if (!parsed.success) {
      return { ok: false, error: `token_response_shape_unexpected: ${parsed.error.issues[0]?.message ?? 'parse failed'}` };
    }

    const expiresAt = new Date(parsed.data.expires_at).getTime();
    tokenCache.set(installationId, { token: parsed.data.token, expiresAt });
    return { ok: true, token: parsed.data.token, expiresAt };
  } catch (err) {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    if (isAbort) return { ok: false, error: 'github_app_token_exchange_timed_out' };
    return { ok: false, error: `github_app_token_exchange_failed: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    clearTimeout(timer);
  }
}

// Test-only helper. Production code MUST NOT call this — token freshness is
// the contract.
export function __clearTokenCacheForTests(): void {
  tokenCache.clear();
}
