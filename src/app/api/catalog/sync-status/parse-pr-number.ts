/**
 * Extract the PR number from a github.com pull-request URL.
 *
 * Defensive: any URL that doesn't end in `/pull/<digits>` returns null so
 * the UI just hides the "Letzter PR" line instead of rendering a broken
 * link. Anchored to end-of-string ($) so fragments and query strings after
 * the number also yield null — we'd rather under-render than mis-render.
 *
 * Lives in a separate file because Next.js's route.ts file may only export
 * a specific set of HTTP-handler / config symbols; adding a helper export
 * to route.ts breaks the typed-routes generator.
 */
export function parsePrNumber(url: string | null | undefined): number | null {
  if (!url) return null;
  const m = url.match(/\/pull\/(\d+)$/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}
