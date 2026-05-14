/// <reference types="@testing-library/jest-dom" />
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import type { ChargeStateEvent } from '@/modules/charging/types';
import type { ChargeCallback } from '@/hooks/use-charge-stream';

// Mock the SSE hook BEFORE importing the component. The mock captures the
// component's callback so each test can drive it synthetically.
let capturedCb: ChargeCallback | null = null;
vi.mock('@/hooks/use-charge-stream', () => ({
  useChargeStream: (_plugId: string, cb: ChargeCallback) => {
    capturedCb = cb;
  },
}));

import { SocBandIndicator } from './soc-band-indicator';

function emit(event: Partial<ChargeStateEvent>) {
  if (!capturedCb) throw new Error('useChargeStream mock callback not captured');
  act(() => {
    capturedCb!({
      plugId: 'abc',
      state: 'charging',
      ...event,
    } as ChargeStateEvent);
  });
}

describe('SocBandIndicator', () => {
  beforeEach(() => {
    capturedCb = null;
  });

  it('renders <pre> ASCII fallback when no live event arrives (initialAsciiBar provided)', () => {
    render(<SocBandIndicator plugId="abc" initialAsciiBar={'LINE1\nLINE2'} />);
    // <pre> with the ASCII content is in the DOM. Match the visible <pre> in
    // the SSR-default state (band-container not shown until a live event).
    const pre = screen.getByTestId('soc-band-ascii');
    expect(pre.tagName).toBe('PRE');
    expect(pre.textContent).toBe('LINE1\nLINE2');
  });

  it('renders nothing (no display) when no event and no initialAsciiBar', () => {
    const { container } = render(<SocBandIndicator plugId="abc" />);
    // The component MAY render a noscript wrapper but no visible content.
    // Assert no band-container and no visible <pre data-testid=...> outside <noscript>.
    expect(container.querySelector('[data-testid="band-container"]')).toBeNull();
    expect(container.querySelector('[data-testid="soc-band-ascii"]')).toBeNull();
  });

  it('drives --soc-min / --soc-max CSS variables on the band container from a live event', () => {
    render(<SocBandIndicator plugId="abc" />);
    emit({
      socMin: 20,
      socMax: 80,
      estimatedSoc: 50,
      targetSoc: 80,
      socAsciiBar: 'X',
    });

    const container = screen.getByTestId('band-container');
    expect(container.style.getPropertyValue('--soc-min')).toBe('20%');
    expect(container.style.getPropertyValue('--soc-max')).toBe('80%');
    expect(container.style.getPropertyValue('--soc-best')).toBe('50%');
    expect(container.style.getPropertyValue('--soc-target')).toBe('80%');
  });

  it('skips the CSS-band layer when band fields are missing on the live event', () => {
    // Render with no initial ASCII so we can detect "nothing rendered".
    const { container } = render(<SocBandIndicator plugId="abc" />);
    emit({
      // socMin intentionally undefined
      estimatedSoc: 50,
      targetSoc: 80,
    });
    expect(container.querySelector('[data-testid="band-container"]')).toBeNull();
  });

  it('band-fill has transition-all duration-700 classes so CSS interpolation runs', () => {
    render(<SocBandIndicator plugId="abc" />);
    emit({
      socMin: 30,
      socMax: 70,
      estimatedSoc: 50,
      targetSoc: 80,
    });
    const fill = screen.getByTestId('band-fill');
    expect(fill.className).toContain('transition-all');
    expect(fill.className).toContain('duration-700');
  });
});
