/// <reference types="@testing-library/jest-dom" />
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import type { ChargeStateEvent } from '@/modules/charging/types';
import type { ChargeCallback } from '@/hooks/use-charge-stream';

let capturedCb: ChargeCallback | null = null;
vi.mock('@/hooks/use-charge-stream', () => ({
  useChargeStream: (_plugId: string, cb: ChargeCallback) => {
    capturedCb = cb;
  },
}));

// /api/profiles is fetched on mount; stub it so the banner is not noisy.
beforeEach(() => {
  capturedCb = null;
  localStorage.clear();
  vi.spyOn(global, 'fetch').mockImplementation((async () =>
    new Response(JSON.stringify([]), { status: 200 })) as typeof fetch);
});

import { ChargeBanner, deriveWatchdogFraction } from './charge-banner';

function emit(event: Partial<ChargeStateEvent>) {
  if (!capturedCb) throw new Error('useChargeStream mock callback not captured');
  act(() => {
    capturedCb!({
      plugId: 'plug-1',
      state: 'charging',
      ...event,
    } as ChargeStateEvent);
  });
}

describe('deriveWatchdogFraction (helper)', () => {
  it('returns 0 when kind is not warning, regardless of inputs', () => {
    const now = 1_000_000;
    expect(deriveWatchdogFraction('none', 60, now + 240_000, now)).toBe(0);
    expect(deriveWatchdogFraction('fired', 60, now + 240_000, now)).toBe(0);
    expect(deriveWatchdogFraction('none', undefined, undefined, now)).toBe(0);
  });

  it('returns fraction in [0,1] for warning state across all edges', () => {
    const now = 1_000_000;
    // Mid-window: 60s of 300s elapsed (firesAt = now + 240_000)
    const mid = deriveWatchdogFraction('warning', 60, now + 240_000, now);
    expect(mid).toBeGreaterThanOrEqual(0);
    expect(mid).toBeLessThanOrEqual(1);
    expect(mid).toBeCloseTo(0.2, 5);

    // firesAt in the past → fraction = 1 (about to fire / overdue)
    const past = deriveWatchdogFraction('warning', 60, now - 1000, now);
    expect(past).toBe(1);

    // firesAt === now → fraction = 1
    const zero = deriveWatchdogFraction('warning', 60, now, now);
    expect(zero).toBe(1);

    // secondsAtZero === 0 and firesAt > now → fraction = 0
    const noZeros = deriveWatchdogFraction('warning', 0, now + 60_000, now);
    expect(noZeros).toBe(0);

    // both at zero → defensive 0 (avoid NaN)
    const bothZero = deriveWatchdogFraction('warning', 0, now, now);
    expect(bothZero).toBeGreaterThanOrEqual(0);
    expect(bothZero).toBeLessThanOrEqual(1);
    expect(Number.isFinite(bothZero)).toBe(true);

    // firesAt undefined while in warning (defensive) → finite, in [0,1]
    const noFiresAt = deriveWatchdogFraction('warning', 60, undefined, now);
    expect(Number.isFinite(noFiresAt)).toBe(true);
    expect(noFiresAt).toBeGreaterThanOrEqual(0);
    expect(noFiresAt).toBeLessThanOrEqual(1);
  });
});

describe('ChargeBanner watchdog UI', () => {
  it('renders no watchdog markup when watchdogKind is "none" during charging', () => {
    render(<ChargeBanner plugId="plug-1" />);
    emit({
      state: 'charging',
      sessionId: 42,
      profileId: 1,
      profileName: 'Bike',
      estimatedSoc: 50,
      targetSoc: 80,
      watchdogKind: 'none',
    });
    expect(screen.queryByTestId('watchdog-warning')).toBeNull();
    expect(screen.queryByTestId('watchdog-fired')).toBeNull();
  });

  it('renders yellow warning banner with bar width ~20% on warning kind', () => {
    render(<ChargeBanner plugId="plug-1" />);
    const now = Date.now();
    // 60s elapsed, fires in 240s → fraction = 60 / 300 = 0.2
    emit({
      state: 'charging',
      sessionId: 42,
      profileId: 1,
      profileName: 'Bike',
      estimatedSoc: 50,
      targetSoc: 80,
      watchdogKind: 'warning',
      stalePowerSeconds: 60,
      stalePowerFiresAt: now + 240_000,
    });
    const warning = screen.getByTestId('watchdog-warning');
    expect(warning).toBeInTheDocument();
    expect(warning.textContent ?? '').toMatch(/60\s*s/);

    const fill = screen.getByTestId('watchdog-warning-fill');
    // Width style should be roughly 20% — allow some rounding/derivation slack.
    const widthStr = (fill as HTMLElement).style.width;
    const widthNum = Number.parseFloat(widthStr.replace('%', ''));
    expect(widthNum).toBeGreaterThan(15);
    expect(widthNum).toBeLessThan(25);
  });

  it('does NOT render warning during detecting/idle/matched states even if kind=warning', () => {
    render(<ChargeBanner plugId="plug-1" />);
    emit({
      state: 'detecting',
      sessionId: 42,
      detectionSamples: 5,
      detectionTargetSamples: 60,
      watchdogKind: 'warning',
      stalePowerSeconds: 60,
      stalePowerFiresAt: Date.now() + 240_000,
    });
    expect(screen.queryByTestId('watchdog-warning')).toBeNull();
  });

  it('renders red fired banner with Acknowledge button when watchdogKind=fired', () => {
    render(<ChargeBanner plugId="plug-1" />);
    emit({
      state: 'aborted',
      sessionId: 7,
      profileId: 1,
      profileName: 'iPad',
      watchdogKind: 'fired',
    });
    expect(screen.getByTestId('watchdog-fired')).toBeInTheDocument();
    expect(screen.getByTestId('watchdog-ack')).toBeInTheDocument();
  });

  it('Acknowledge click hides the fired banner and persists key in localStorage', () => {
    render(<ChargeBanner plugId="plug-1" />);
    emit({
      state: 'aborted',
      sessionId: 7,
      watchdogKind: 'fired',
    });
    expect(screen.getByTestId('watchdog-fired')).toBeInTheDocument();
    act(() => {
      fireEvent.click(screen.getByTestId('watchdog-ack'));
    });
    expect(screen.queryByTestId('watchdog-fired')).toBeNull();
    expect(localStorage.getItem('charging-watchdog-ack-7')).toBe('1');
  });

  it('honors pre-set localStorage ack: fired event does not re-render banner', () => {
    localStorage.setItem('charging-watchdog-ack-7', '1');
    render(<ChargeBanner plugId="plug-1" />);
    emit({
      state: 'aborted',
      sessionId: 7,
      watchdogKind: 'fired',
    });
    expect(screen.queryByTestId('watchdog-fired')).toBeNull();
  });

  it('new sessionId re-arms banner via useEffect re-read of localStorage', () => {
    // Pre-ack session 7.
    localStorage.setItem('charging-watchdog-ack-7', '1');
    render(<ChargeBanner plugId="plug-1" />);
    // Fire on session 7 → suppressed.
    emit({
      state: 'aborted',
      sessionId: 7,
      watchdogKind: 'fired',
    });
    expect(screen.queryByTestId('watchdog-fired')).toBeNull();
    // Now a new session (id=8) fires — different key not in storage → banner visible.
    emit({
      state: 'aborted',
      sessionId: 8,
      watchdogKind: 'fired',
    });
    expect(screen.getByTestId('watchdog-fired')).toBeInTheDocument();
  });
});
