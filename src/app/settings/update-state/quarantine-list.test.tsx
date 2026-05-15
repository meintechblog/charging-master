/// <reference types="@testing-library/jest-dom" />
//
// src/app/settings/update-state/quarantine-list.test.tsx
//
// Coverage for the QuarantineList client component (Plan 13-04 Task 3):
// - Empty-state when quarantine === null
// - File list renders RELATIVE paths preserving directory structure
// - "Alle löschen" click triggers DELETE fetch + router.refresh()
// - HTTP-error path surfaces inline message and re-enables the button
// - Network-error path surfaces the rejection message inline

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// vi.mock factories are hoisted; vi.hoisted ensures the refs exist before the
// factory runs (otherwise the closure would capture an undefined symbol).
const { refreshFn } = vi.hoisted(() => ({
  refreshFn: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    refresh: refreshFn,
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

beforeEach(() => {
  refreshFn.mockClear();
});

import { QuarantineList } from './quarantine-list';

const QUARANTINE = {
  timestamp: 1_700_000_000_000,
  fileCount: 2,
  path: '/opt/charging-master/.update-state/quarantine-20260515-221500',
};

describe('QuarantineList', () => {
  it('renders the empty-state message when quarantine is null', () => {
    render(<QuarantineList quarantine={null} files={[]} />);
    expect(screen.queryByText('Keine Quarantäne-Dateien.')).not.toBeNull();
    expect(screen.queryByRole('button', { name: /Alle löschen/ })).toBeNull();
  });

  it('renders file paths relative to the quarantine root (preserves directory structure)', () => {
    render(
      <QuarantineList
        quarantine={QUARANTINE}
        files={['scripts/calibration-sweep-real.ts', 'data/junk.json']}
      />,
    );
    // Both relative paths visible; basenames alone would NOT contain "scripts/"
    expect(screen.queryByText('scripts/calibration-sweep-real.ts')).not.toBeNull();
    expect(screen.queryByText('data/junk.json')).not.toBeNull();
    // File count from props shows in the header
    expect(screen.queryByText(/2 Datei\(en\)/)).not.toBeNull();
  });

  it('"Alle löschen" click triggers DELETE fetch then router.refresh()', async () => {
    const fetchFn = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    globalThis.fetch = fetchFn as unknown as typeof fetch;

    render(<QuarantineList quarantine={QUARANTINE} files={['scripts/junk.ts']} />);

    const button = screen.getByRole('button', { name: /Alle löschen/ });
    fireEvent.click(button);

    await waitFor(() => expect(refreshFn).toHaveBeenCalledTimes(1));

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const call = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe('/api/admin/update-state/quarantine');
    expect(call[1].method).toBe('DELETE');
  });

  it('non-OK HTTP response shows inline error and re-enables the button', async () => {
    const fetchFn = vi.fn(async () => new Response('{"error":"rm_failed"}', { status: 500 }));
    globalThis.fetch = fetchFn as unknown as typeof fetch;

    render(<QuarantineList quarantine={QUARANTINE} files={['scripts/junk.ts']} />);

    const button = screen.getByRole('button', { name: /Alle löschen/ }) as HTMLButtonElement;
    fireEvent.click(button);

    await waitFor(() => expect(screen.queryByText(/HTTP 500/)).not.toBeNull());
    expect(refreshFn).not.toHaveBeenCalled();
    // Button label flips back to "Alle löschen" and is enabled.
    const buttonAfter = screen.getByRole('button', { name: /Alle löschen/ }) as HTMLButtonElement;
    expect(buttonAfter.disabled).toBe(false);
  });

  it('network rejection surfaces the rejection message inline', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('connection refused');
    });
    globalThis.fetch = fetchFn as unknown as typeof fetch;

    render(<QuarantineList quarantine={QUARANTINE} files={['scripts/junk.ts']} />);

    const button = screen.getByRole('button', { name: /Alle löschen/ }) as HTMLButtonElement;
    fireEvent.click(button);

    await waitFor(() => expect(screen.queryByText(/connection refused/)).not.toBeNull());
    expect(refreshFn).not.toHaveBeenCalled();
    const buttonAfter = screen.getByRole('button', { name: /Alle löschen/ }) as HTMLButtonElement;
    expect(buttonAfter.disabled).toBe(false);
  });
});
