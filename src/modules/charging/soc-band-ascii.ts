/**
 * Pure ASCII renderer for the SOC confidence band.
 *
 * Maps {socMin, socMax, socBest, targetSoc, width, mode} → a deterministic
 * monospace string of exactly 3 lines:
 *
 *   scaleRow   ← tick glyphs at 0/10/.../100 columns
 *   barRow     ← band glyphs (#/=/. for pushover, ▓/▒/░ for unicode)
 *   markersRow ← best (^/↑) and target (T/▲) markers; X for overlap
 *
 * Two glyph sets:
 *   - 'pushover': ASCII-only (#, =, ., ^, T, X, |, +, -). Defensive choice
 *     for Pushover lock-screen rendering (RESEARCH.md Pitfall 3 — monospace
 *     is "messages, not notifications" on iOS/Android).
 *   - 'unicode':  Richer glyphs (▓, ▒, ░, ↑, ▲, X, ├, ┼, ─) for the dashboard
 *     and server logs.
 *
 * The function is pure — no I/O, no Date.now, no Math.random. Every call with
 * the same input produces byte-identical output. Snapshot-tested in
 * soc-band-ascii.test.ts.
 */

export type SocBandRenderMode = 'pushover' | 'unicode';

export interface SocBandRenderInput {
  socMin: number;
  socMax: number;
  socBest: number;
  targetSoc: number;
  width?: number;
  mode?: SocBandRenderMode;
}

export const DEFAULT_BAND_WIDTH = 40;
export const DEFAULT_BAND_MODE: SocBandRenderMode = 'unicode';

interface GlyphTable {
  core: string;
  band: string;
  outside: string;
  best: string;
  target: string;
  both: string;
  tickStart: string;
  tickMid: string;
  tickFill: string;
}

const GLYPHS_PUSHOVER: GlyphTable = {
  core: '#',
  band: '=',
  outside: '.',
  best: '^',
  target: 'T',
  both: 'X',
  tickStart: '|',
  tickMid: '+',
  tickFill: '-',
};

const GLYPHS_UNICODE: GlyphTable = {
  core: '▓',
  band: '▒',
  outside: '░',
  best: '↑',
  target: '▲',
  both: 'X',
  tickStart: '├',
  tickMid: '┼',
  tickFill: '─',
};

function clampPct(v: number): number {
  if (Number.isNaN(v)) return 0;
  if (v < 0) return 0;
  if (v > 100) return 100;
  return v;
}

export function renderSocBandAscii(input: SocBandRenderInput): string {
  const width = Math.max(1, Math.floor(input.width ?? DEFAULT_BAND_WIDTH));
  const mode = input.mode ?? DEFAULT_BAND_MODE;
  const g = mode === 'pushover' ? GLYPHS_PUSHOVER : GLYPHS_UNICODE;

  const socMin = clampPct(input.socMin);
  const socMax = clampPct(input.socMax);
  const socBest = clampPct(input.socBest);
  const targetSoc = clampPct(input.targetSoc);

  const lastCol = width - 1;
  const toCol = (pct: number): number => {
    if (lastCol <= 0) return 0;
    return Math.max(0, Math.min(lastCol, Math.round((pct / 100) * lastCol)));
  };

  const minCol = toCol(Math.min(socMin, socMax));
  const maxCol = toCol(Math.max(socMin, socMax));
  const bestCol = toCol(socBest);
  const targetCol = toCol(targetSoc);
  const coreLo = toCol(Math.max(0, socBest - 5));
  const coreHi = toCol(Math.min(100, socBest + 5));

  const tickStep = Math.max(1, Math.round(lastCol / 10));

  const scale: string[] = new Array(width);
  const bar: string[] = new Array(width);
  const markers: string[] = new Array(width);

  for (let i = 0; i < width; i++) {
    // Scale row — tick glyphs at 0, every 10%, and 100%.
    if (i === 0 || i === lastCol) {
      scale[i] = g.tickStart;
    } else if (i % tickStep === 0) {
      scale[i] = g.tickMid;
    } else {
      scale[i] = g.tickFill;
    }

    // Bar row — core (best±5) > band (min..max) > outside.
    if (i >= coreLo && i <= coreHi && minCol <= maxCol && i >= minCol && i <= maxCol) {
      bar[i] = g.core;
    } else if (i >= minCol && i <= maxCol) {
      bar[i] = g.band;
    } else {
      bar[i] = g.outside;
    }

    // Markers row — best/target/overlap; spaces elsewhere.
    if (i === bestCol && i === targetCol) {
      markers[i] = g.both;
    } else if (i === bestCol) {
      markers[i] = g.best;
    } else if (i === targetCol) {
      markers[i] = g.target;
    } else {
      markers[i] = ' ';
    }
  }

  return `${scale.join('')}\n${bar.join('')}\n${markers.join('')}`;
}
