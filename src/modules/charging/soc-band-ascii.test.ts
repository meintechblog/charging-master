/**
 * Snapshot + invariant tests for renderSocBandAscii.
 *
 * Output shape is LOCKED at exactly 3 lines (B5):
 *   line 0 — scale row  (tick glyphs)
 *   line 1 — bar row    (#/=/. for pushover, ▓/▒/░ for unicode)
 *   line 2 — markers row (^/T/X for pushover, ↑/▲/X for unicode; spaces elsewhere)
 *
 * Inline snapshots keep the locked output visible in code review. Per-line
 * glyph invariants (B5) prevent over-broad regex from missing glyph drift.
 */

import { describe, it, expect } from 'vitest';
import {
  renderSocBandAscii,
  DEFAULT_BAND_WIDTH,
  DEFAULT_BAND_MODE,
  type SocBandRenderInput,
} from './soc-band-ascii';

describe('renderSocBandAscii — pushover-mode snapshots (ASCII-only glyphs)', () => {
  it('Snapshot 1 — full uncertainty (socMin=0, socMax=100)', () => {
    const out = renderSocBandAscii({
      socMin: 0,
      socMax: 100,
      socBest: 50,
      targetSoc: 80,
      mode: 'pushover',
    });
    expect(out).toMatchInlineSnapshot(`
      "|---+---+---+---+---+---+---+---+---+--|
      ==================####==================
                          ^          T        "
    `);
  });

  it('Snapshot 2 — narrow band (best±5)', () => {
    const out = renderSocBandAscii({
      socMin: 45,
      socMax: 55,
      socBest: 50,
      targetSoc: 80,
      mode: 'pushover',
    });
    expect(out).toMatchInlineSnapshot(`
      "|---+---+---+---+---+---+---+---+---+--|
      ..................####..................
                          ^          T        "
    `);
  });

  it('Snapshot 3 — exact target (socBest === targetSoc → X overlap glyph)', () => {
    const out = renderSocBandAscii({
      socMin: 78,
      socMax: 82,
      socBest: 80,
      targetSoc: 80,
      mode: 'pushover',
    });
    expect(out).toMatchInlineSnapshot(`
      "|---+---+---+---+---+---+---+---+---+--|
      ..............................###.......
                                     X        "
    `);
    // Overlap glyph 'X' is emitted exactly once when bestCol === targetCol.
    const markersRow = out.split('\n')[2];
    expect(markersRow.split('X')).toHaveLength(2);
  });

  it('Snapshot 4 — band crossing target (target inside band)', () => {
    const out = renderSocBandAscii({
      socMin: 75,
      socMax: 85,
      socBest: 78,
      targetSoc: 80,
      mode: 'pushover',
    });
    expect(out).toMatchInlineSnapshot(`
      "|---+---+---+---+---+---+---+---+---+--|
      .............................####=......
                                    ^T        "
    `);
  });

  it('Snapshot 5 — collapsed band (socMin === socMax === socBest)', () => {
    const out = renderSocBandAscii({
      socMin: 60,
      socMax: 60,
      socBest: 60,
      targetSoc: 80,
      mode: 'pushover',
    });
    expect(out).toMatchInlineSnapshot(`
      "|---+---+---+---+---+---+---+---+---+--|
      .......................#................
                             ^       T        "
    `);
    // Collapsed band → exactly ONE '#' column (no '=' anywhere on bar row).
    const barRow = out.split('\n')[1];
    expect(barRow.split('#')).toHaveLength(2);
    expect(barRow.includes('=')).toBe(false);
  });

  it('Snapshot 6 — target at left edge (targetSoc=0)', () => {
    const out = renderSocBandAscii({
      socMin: 5,
      socMax: 15,
      socBest: 10,
      targetSoc: 0,
      mode: 'pushover',
    });
    expect(out).toMatchInlineSnapshot(`
      "|---+---+---+---+---+---+---+---+---+--|
      ..#####.................................
      T   ^                                   "
    `);
    // 'T' lands at column 0.
    const markersRow = out.split('\n')[2];
    expect(markersRow[0]).toBe('T');
  });
});

describe('renderSocBandAscii — unicode-mode snapshot (dashboard / server log)', () => {
  it('Snapshot 7 — Unicode parity (same input as Snapshot 2, mode=unicode)', () => {
    const out = renderSocBandAscii({
      socMin: 45,
      socMax: 55,
      socBest: 50,
      targetSoc: 80,
      mode: 'unicode',
    });
    expect(out).toMatchInlineSnapshot(`
      "├───┼───┼───┼───┼───┼───┼───┼───┼───┼──├
      ░░░░░░░░░░░░░░░░░░▓▓▓▓░░░░░░░░░░░░░░░░░░
                          ↑          ▲        "
    `);
  });
});

describe('renderSocBandAscii — width parameter, clamping, degenerate cases', () => {
  it('width parameter — produces exactly N chars per line', () => {
    const out = renderSocBandAscii({
      socMin: 30,
      socMax: 70,
      socBest: 50,
      targetSoc: 80,
      width: 20,
      mode: 'pushover',
    });
    const lines = out.split('\n');
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line.length).toBe(20);
    }
  });

  it('width parameter — width=80', () => {
    const out = renderSocBandAscii({
      socMin: 30,
      socMax: 70,
      socBest: 50,
      targetSoc: 80,
      width: 80,
      mode: 'pushover',
    });
    const lines = out.split('\n');
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line.length).toBe(80);
    }
  });

  it('clamping — out-of-range inputs do not throw and clamp to [0, 100]', () => {
    expect(() =>
      renderSocBandAscii({
        socMin: -10,
        socMax: 110,
        socBest: -5,
        targetSoc: 200,
        mode: 'pushover',
      })
    ).not.toThrow();
    const out = renderSocBandAscii({
      socMin: -10,
      socMax: 110,
      socBest: -5,
      targetSoc: 200,
      mode: 'pushover',
    });
    const lines = out.split('\n');
    expect(lines).toHaveLength(3);
    // socMin=-10 clamped to 0 → leftmost col; socMax=110 clamped to 100 → rightmost col.
    // socBest=-5 clamped to 0; targetSoc=200 clamped to 100.
    const markersRow = lines[2];
    expect(markersRow[0]).toBe('^');                       // best at col 0
    expect(markersRow[markersRow.length - 1]).toBe('T');   // target at last col
  });

  it('degenerate width (1) — produces a single-column bar (every row 1 char)', () => {
    expect(() =>
      renderSocBandAscii({
        socMin: 0,
        socMax: 100,
        socBest: 50,
        targetSoc: 80,
        width: 1,
        mode: 'pushover',
      })
    ).not.toThrow();
    const out = renderSocBandAscii({
      socMin: 0,
      socMax: 100,
      socBest: 50,
      targetSoc: 80,
      width: 1,
      mode: 'pushover',
    });
    const lines = out.split('\n');
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line.length).toBe(1);
    }
  });

  it('defaults — width defaults to DEFAULT_BAND_WIDTH (40), mode defaults to DEFAULT_BAND_MODE (unicode)', () => {
    expect(DEFAULT_BAND_WIDTH).toBe(40);
    expect(DEFAULT_BAND_MODE).toBe('unicode');

    const out = renderSocBandAscii({
      socMin: 45,
      socMax: 55,
      socBest: 50,
      targetSoc: 80,
    });
    const lines = out.split('\n');
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line.length).toBe(40);
    }
    // Unicode default → bar row uses ▓/▒/░, NOT #/=/.
    expect(lines[1]).toMatch(/^[▓▒░]+$/);
  });
});

describe('renderSocBandAscii — per-line invariants (B5 closed)', () => {
  // Per B5: scope the bar-row regex to the bar row only; test scale and
  // markers rows with their own narrower regexes so a glyph regression is
  // immediately visible without an over-broad union regex.

  const samples: Array<{ name: string; input: SocBandRenderInput }> = [
    { name: 'pushover full', input: { socMin: 0, socMax: 100, socBest: 50, targetSoc: 80, mode: 'pushover' } },
    { name: 'pushover narrow', input: { socMin: 45, socMax: 55, socBest: 50, targetSoc: 80, mode: 'pushover' } },
    { name: 'pushover collapsed', input: { socMin: 60, socMax: 60, socBest: 60, targetSoc: 80, mode: 'pushover' } },
    { name: 'pushover overlap', input: { socMin: 78, socMax: 82, socBest: 80, targetSoc: 80, mode: 'pushover' } },
    { name: 'unicode narrow', input: { socMin: 45, socMax: 55, socBest: 50, targetSoc: 80, mode: 'unicode' } },
    { name: 'unicode collapsed', input: { socMin: 60, socMax: 60, socBest: 60, targetSoc: 80, mode: 'unicode' } },
  ];

  for (const s of samples) {
    it(`output is exactly 3 lines and width=40 — ${s.name}`, () => {
      const lines = renderSocBandAscii(s.input).split('\n');
      expect(lines).toHaveLength(3);
      expect(lines[0].length).toBe(40);
      expect(lines[1].length).toBe(40);
      expect(lines[2].length).toBe(40);
    });
  }

  it('pushover — scale row glyphs are {|, +, -} only', () => {
    const out = renderSocBandAscii({ socMin: 0, socMax: 100, socBest: 50, targetSoc: 80, mode: 'pushover' });
    const scaleRow = out.split('\n')[0];
    expect(scaleRow).toMatch(/^[|+\-]+$/);
  });

  it('pushover — bar row glyphs are {#, =, .} only', () => {
    for (const s of samples.filter((x) => x.input.mode === 'pushover')) {
      const barRow = renderSocBandAscii(s.input).split('\n')[1];
      expect(barRow).toMatch(/^[#=.]+$/);
    }
  });

  it('pushover — markers row glyphs are {^, T, X, space} only', () => {
    for (const s of samples.filter((x) => x.input.mode === 'pushover')) {
      const markersRow = renderSocBandAscii(s.input).split('\n')[2];
      expect(markersRow).toMatch(/^[\^TX ]+$/);
    }
  });

  it('unicode — scale row glyphs are {├, ┼, ─} only', () => {
    const out = renderSocBandAscii({ socMin: 0, socMax: 100, socBest: 50, targetSoc: 80, mode: 'unicode' });
    const scaleRow = out.split('\n')[0];
    expect(scaleRow).toMatch(/^[├┼─]+$/);
  });

  it('unicode — bar row glyphs are {▓, ▒, ░} only', () => {
    for (const s of samples.filter((x) => x.input.mode === 'unicode')) {
      const barRow = renderSocBandAscii(s.input).split('\n')[1];
      expect(barRow).toMatch(/^[▓▒░]+$/);
    }
  });

  it('unicode — markers row glyphs are {↑, ▲, X, space} only', () => {
    for (const s of samples.filter((x) => x.input.mode === 'unicode')) {
      const markersRow = renderSocBandAscii(s.input).split('\n')[2];
      expect(markersRow).toMatch(/^[↑▲X ]+$/);
    }
  });

  it('determinism — same input produces byte-identical output across repeated calls', () => {
    const input: SocBandRenderInput = {
      socMin: 45,
      socMax: 55,
      socBest: 50,
      targetSoc: 80,
      mode: 'pushover',
    };
    const a = renderSocBandAscii(input);
    const b = renderSocBandAscii(input);
    const c = renderSocBandAscii(input);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });
});
