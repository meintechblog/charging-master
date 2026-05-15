/// <reference types="@testing-library/jest-dom" />
//
// src/app/settings/update-banner.test.tsx
//
// Coverage for the PIPE-03 UI slice on the existing UpdateBanner (Plan 13-04):
// - Stacked quarantine banner renders when info.lastQuarantine is non-null
// - Stacked quarantine banner does NOT render when null/undefined
// - DOM ordering: quarantine banner sits ABOVE the primary banner
// - Rollback red banner (priority 1) trumps the quarantine banner

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// next/link renders as an anchor in jsdom; no mock needed.

// jsdom in vitest's default jsdom environment does NOT implement EventSource.
// UpdateBanner constructs one on mount only when flow.kind transitions into
// 'triggered' or 'streaming'; the test paths exercised here never trigger that
// effect, but we polyfill anyway to be defensive against future refactors.
beforeEach(() => {
  globalThis.EventSource = vi.fn().mockImplementation(() => ({
    onopen: null,
    onmessage: null,
    onerror: null,
    close: vi.fn(),
    addEventListener: vi.fn(),
  })) as unknown as typeof EventSource;
});

import { UpdateBanner } from './update-banner';
import type { UpdateInfoView } from '@/modules/self-update/types';

const QUARANTINE_PATH = '/opt/charging-master/.update-state/quarantine-20260515-221500';

const baseInfo: UpdateInfoView = {
  currentSha: 'abc1234567890abc1234567890abc1234567890a',
  currentShaShort: 'abc1234',
  lastCheckAt: null,
  lastCheckStatus: 'never',
  updateAvailable: false,
};

const infoWithQuarantine: UpdateInfoView = {
  ...baseInfo,
  lastQuarantine: { timestamp: 1_700_000_000_000, fileCount: 3, path: QUARANTINE_PATH },
};

describe('UpdateBanner — quarantine info banner (PIPE-03 UI)', () => {
  it('renders the quarantine info banner when info.lastQuarantine is non-null', () => {
    render(<UpdateBanner initialInfo={infoWithQuarantine} />);

    expect(screen.queryByText(/Letztes Preflight:/)).not.toBeNull();
    // File count is rendered inline as plain text alongside the prefix; matching
    // a substring rather than the full text node tolerates whitespace variation.
    expect(screen.queryByText(/3 Datei\(en\) in Quarantäne/)).not.toBeNull();

    const link = screen.getByRole('link', { name: /Details ansehen/ });
    expect(link.getAttribute('href')).toBe('/settings/update-state');
  });

  it('does NOT render the quarantine info banner when info.lastQuarantine is null', () => {
    const info: UpdateInfoView = { ...baseInfo, lastQuarantine: null };
    render(<UpdateBanner initialInfo={info} />);
    expect(screen.queryByText(/Letztes Preflight:/)).toBeNull();
  });

  it('does NOT render the quarantine info banner when info.lastQuarantine is undefined (legacy state.json shape)', () => {
    render(<UpdateBanner initialInfo={baseInfo} />);
    expect(screen.queryByText(/Letztes Preflight:/)).toBeNull();
  });

  it('stacks the quarantine banner ABOVE the "Update verfügbar" banner when both apply', () => {
    const info: UpdateInfoView = {
      ...infoWithQuarantine,
      updateAvailable: true,
      remote: {
        sha: 'def4567890abcdef4567890abcdef4567890abcd',
        shaShort: 'def4567',
        message: 'Some new commit',
        author: 'Hulki',
        date: new Date('2026-05-15T12:00:00Z').toISOString(),
      },
    };
    render(<UpdateBanner initialInfo={info} />);

    const quarantineEl = screen.getByText(/Letztes Preflight:/);
    const updateEl = screen.getByText(/Update verfügbar/);
    expect(quarantineEl).not.toBeNull();
    expect(updateEl).not.toBeNull();

    // Node.DOCUMENT_POSITION_FOLLOWING = 4 — set when the argument comes AFTER
    // the reference node in document order. compareDocumentPosition(updateEl)
    // returning a value with bit 4 set means quarantineEl precedes updateEl.
    const pos = quarantineEl.compareDocumentPosition(updateEl);
    expect(pos & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('does NOT stack the quarantine banner on the rollback red banner (rollback trumps)', () => {
    const info: UpdateInfoView = {
      ...infoWithQuarantine,
      rollbackHappened: true,
      rollbackReason: 'preflight_disk: not enough free space',
      rollbackStage: 'stage1',
    };
    render(<UpdateBanner initialInfo={info} />);

    expect(screen.queryByText(/Letztes Update fehlgeschlagen/)).not.toBeNull();
    expect(screen.queryByText(/Letztes Preflight:/)).toBeNull();
  });
});
