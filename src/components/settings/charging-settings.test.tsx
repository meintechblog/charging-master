/// <reference types="@testing-library/jest-dom" />
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// Stub the fetch the useAutoSave hook fires off — no real network in the test.
beforeEach(() => {
  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch;
});

import { ChargingSettings } from './charging-settings';
import { DEFAULT_BAND_THRESHOLD_PCT } from '@/modules/charging/curve-matcher';

describe('ChargingSettings', () => {
  it('renders both stop-mode radio options; aggressive is the default when initialSettings is empty', () => {
    render(<ChargingSettings initialSettings={{}} />);

    const aggressive = screen.getByRole('radio', { name: /aggressiv/i }) as HTMLInputElement;
    const conservative = screen.getByRole('radio', { name: /konservativ/i }) as HTMLInputElement;

    expect(aggressive).toBeInTheDocument();
    expect(conservative).toBeInTheDocument();
    expect(aggressive.checked).toBe(true);
    expect(conservative.checked).toBe(false);
  });

  it('advanced toggle reveals the band-threshold number input with the empirical default placeholder', () => {
    render(<ChargingSettings initialSettings={{}} />);

    // Threshold input is NOT in the DOM on initial render.
    expect(screen.queryByLabelText(/Band-Schwellenwert/i)).toBeNull();

    // Click the toggle button.
    const toggle = screen.getByRole('button', { name: /Erweitert anzeigen/i });
    fireEvent.click(toggle);

    // Threshold input is now in the DOM, placeholder = DEFAULT_BAND_THRESHOLD_PCT (0.05).
    const input = screen.getByLabelText(/Band-Schwellenwert/i) as HTMLInputElement;
    expect(input).toBeInTheDocument();
    expect(input.placeholder).toBe(String(DEFAULT_BAND_THRESHOLD_PCT));
    expect(input.type).toBe('number');
  });

  it('hydrates from initialSettings: conservative radio is checked, threshold input shows persisted value', () => {
    render(
      <ChargingSettings
        initialSettings={{
          'charging.stopMode': 'conservative',
          'charging.bandThreshold': '0.20',
        }}
      />,
    );

    const aggressive = screen.getByRole('radio', { name: /aggressiv/i }) as HTMLInputElement;
    const conservative = screen.getByRole('radio', { name: /konservativ/i }) as HTMLInputElement;
    expect(aggressive.checked).toBe(false);
    expect(conservative.checked).toBe(true);

    // Expand advanced section.
    fireEvent.click(screen.getByRole('button', { name: /Erweitert anzeigen/i }));
    const input = screen.getByLabelText(/Band-Schwellenwert/i) as HTMLInputElement;
    expect(input.value).toBe('0.20');
  });
});
