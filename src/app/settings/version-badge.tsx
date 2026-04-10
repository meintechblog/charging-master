'use client';

import { useState } from 'react';
import { CURRENT_SHA, CURRENT_SHA_SHORT, BUILD_TIME } from '@/lib/version';

// Format build time as YYYY-MM-DD for compact display.
// Keep it dumb: no timezone magic, no locale formatting — BUILD_TIME is ISO UTC.
function formatBuildDate(iso: string): string {
  // '2026-04-10T12:34:56.789Z' -> '2026-04-10'
  return iso.slice(0, 10);
}

export function VersionBadge() {
  const [copied, setCopied] = useState(false);

  const buildDate = formatBuildDate(BUILD_TIME);
  // Cast to string to widen the literal type inferred from the generated
  // src/lib/version.ts — at build time the generator may write either a
  // 7-char SHA or the literal "unknown", and TS narrows to whichever is
  // current on disk. We need the comparison to remain valid for both.
  const isUnknown = (CURRENT_SHA_SHORT as string) === 'unknown';

  async function handleCopy() {
    if (isUnknown) return;
    try {
      await navigator.clipboard.writeText(CURRENT_SHA);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // navigator.clipboard requires secure context (HTTPS or localhost).
      // On a LAN IP like http://charging-master.local:3000 modern browsers
      // may refuse. Fall through silently — the full SHA is still visible
      // via the native title tooltip on hover, which is good enough.
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={
        isUnknown
          ? 'Version unbekannt — Build ohne Git-Kontext'
          : `Vollständiger SHA: ${CURRENT_SHA}\nKlicken zum Kopieren`
      }
      className="inline-flex items-center gap-2 rounded border border-neutral-800 bg-neutral-900 px-3 py-1.5 font-mono text-xs text-neutral-300 transition-colors hover:border-neutral-700 hover:bg-neutral-800"
    >
      <span className="text-neutral-500">v</span>
      <span className="text-neutral-100">{CURRENT_SHA_SHORT}</span>
      <span className="text-neutral-500">·</span>
      <span className="text-neutral-400">{buildDate}</span>
      {copied && <span className="ml-1 text-emerald-400">Kopiert ✓</span>}
    </button>
  );
}
