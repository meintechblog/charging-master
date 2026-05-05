// src/lib/host-guard.ts
// Host-header guard shared by browser-facing self-update endpoints
// (/api/update/trigger, /api/update/log, /api/update/ack-rollback).
//
// SECURITY MODEL: Defense-in-depth on top of LAN-only deployment. The Host
// header is trivially LAN-spoofable, so this guard's actual job is "make sure
// only browsers reaching the configured deployment hostnames can hit these
// endpoints" — not real auth. Real protection comes from network segmentation.
//
// Server-to-server endpoints called via 127.0.0.1 (e.g.
// /api/internal/prepare-for-shutdown invoked by the updater script) keep
// their own narrower localhost-only allowlist and do NOT use this helper.

const DEFAULT_ALLOWED_HOSTS = [
  '127.0.0.1',
  'localhost',
  '::1',
  '[::1]',
  'charging-master.local',
] as const;

/**
 * Build the allowed-host set. Includes the defaults plus any comma-separated
 * hostnames from UPDATE_ALLOWED_HOSTS so a different deployment can override
 * without code changes (e.g. an IP fallback when mDNS misbehaves).
 */
function buildAllowedHosts(): Set<string> {
  const extra = (process.env.UPDATE_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  return new Set<string>([...DEFAULT_ALLOWED_HOSTS, ...extra]);
}

const ALLOWED_HOSTS = buildAllowedHosts();

/**
 * True iff the request's Host header (port stripped, lowercased) is in the
 * allowlist. Handles bracketed IPv6 (`[::1]:80`) and bare hostnames.
 */
export function isAllowedBrowserHost(request: Request): boolean {
  const raw = request.headers.get('host');
  if (raw === null) return false;
  const lowered = raw.toLowerCase();
  const host = lowered.startsWith('[')
    ? lowered.slice(0, lowered.indexOf(']') + 1)
    : lowered.split(':')[0];
  return ALLOWED_HOSTS.has(host);
}
