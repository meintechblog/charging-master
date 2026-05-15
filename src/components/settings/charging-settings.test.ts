/**
 * Constant-parity guard for the client-bundle defaults inlined in
 * charging-settings.tsx. The component cannot import from stop-mode.ts
 * (would drag better-sqlite3 → fs into the client bundle), so the values
 * are duplicated. This test re-reads the inlined constants from the
 * component file as text and asserts they match the canonical server-side
 * defaults — drift between the two fails CI loudly.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  DEFAULT_STALE_POWER_THRESHOLD_W,
  DEFAULT_STALE_POWER_WINDOW_SEC,
  DEFAULT_MATCHER_REFRESH_READINGS,
  DEFAULT_LOW_CONFIDENCE_THRESHOLD,
  DEFAULT_MAX_SESSION_HOURS,
} from '@/modules/charging/stop-mode';

const here = dirname(fileURLToPath(import.meta.url));
const componentPath = join(here, 'charging-settings.tsx');
const source = readFileSync(componentPath, 'utf8');

function readInlinedConst(name: string): number {
  const match = source.match(new RegExp(`^const ${name} = ([0-9.]+);`, 'm'));
  if (!match) throw new Error(`could not find inlined const ${name}`);
  return Number.parseFloat(match[1]);
}

describe('charging-settings inlined constants parity', () => {
  it('client-bundle defaults match server-side stop-mode.ts', () => {
    expect(readInlinedConst('DEFAULT_STALE_POWER_THRESHOLD_W')).toBe(DEFAULT_STALE_POWER_THRESHOLD_W);
    expect(readInlinedConst('DEFAULT_STALE_POWER_WINDOW_SEC')).toBe(DEFAULT_STALE_POWER_WINDOW_SEC);
    expect(readInlinedConst('DEFAULT_MATCHER_REFRESH_READINGS')).toBe(DEFAULT_MATCHER_REFRESH_READINGS);
    expect(readInlinedConst('DEFAULT_LOW_CONFIDENCE_THRESHOLD')).toBe(DEFAULT_LOW_CONFIDENCE_THRESHOLD);
    expect(readInlinedConst('DEFAULT_MAX_SESSION_HOURS')).toBe(DEFAULT_MAX_SESSION_HOURS);
  });
});
