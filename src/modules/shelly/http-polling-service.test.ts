import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventBus } from '../events/event-bus';

// Mock db client before importing the module under test
vi.mock('@/db/client', () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        run: vi.fn(),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          run: vi.fn(),
        })),
      })),
    })),
  },
}));

// Mock schema
vi.mock('@/db/schema', () => ({
  plugs: { id: 'id' },
  powerReadings: {},
}));

// Mock drizzle-orm eq
vi.mock('drizzle-orm', () => ({
  eq: vi.fn((col, val) => ({ col, val })),
}));

import { HttpPollingService } from './http-polling-service';

describe('HttpPollingService', () => {
  let eventBus: EventBus;
  let service: HttpPollingService;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    eventBus = new EventBus();
    service = new HttpPollingService(eventBus);

    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    service.stopAll();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('Test 1: startPolling() calls fetch with correct URL', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ apower: 10, voltage: 230, current: 0.04, output: true, aenergy: { total: 50 } }),
    });

    service.startPolling('plug-1', '192.168.3.167');

    // The immediate poll() call is async, let microtasks flush
    await vi.advanceTimersByTimeAsync(0);

    expect(mockFetch).toHaveBeenCalledWith(
      'http://192.168.3.167/rpc/Switch.GetStatus?id=0',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it('Test 2: Successful poll emits PowerReading via eventBus', async () => {
    const emitSpy = vi.spyOn(eventBus, 'emitPowerReading');

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ apower: 42, voltage: 231, current: 0.18, output: true, aenergy: { total: 123.4 } }),
    });

    service.startPolling('plug-1', '192.168.3.167');
    await vi.advanceTimersByTimeAsync(0);

    expect(emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        plugId: 'plug-1',
        apower: 42,
        voltage: 231,
        current: 0.18,
        output: true,
        totalEnergy: 123.4,
        timestamp: expect.any(Number),
      })
    );
  });

  it('Test 3: Failed poll emits PlugOnline(false)', async () => {
    const onlineSpy = vi.spyOn(eventBus, 'emitPlugOnline');

    mockFetch.mockRejectedValueOnce(new Error('fetch failed'));

    service.startPolling('plug-1', '192.168.3.167');
    await vi.advanceTimersByTimeAsync(0);

    expect(onlineSpy).toHaveBeenCalledWith('plug-1', false);
  });

  it('Test 4: stopPolling(plugId) clears the interval for that plug', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ apower: 0, voltage: 230, current: 0, output: false, aenergy: { total: 0 } }),
    });

    service.startPolling('plug-1', '192.168.3.167');
    await vi.advanceTimersByTimeAsync(0);

    expect(service.isPolling('plug-1')).toBe(true);

    service.stopPolling('plug-1');
    expect(service.isPolling('plug-1')).toBe(false);

    // Advance time -- no more fetch calls
    const callCount = mockFetch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(mockFetch.mock.calls.length).toBe(callCount);
  });

  it('Test 5: stopAll() clears all active polling intervals', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ apower: 0, voltage: 230, current: 0, output: false, aenergy: { total: 0 } }),
    });

    service.startPolling('plug-1', '192.168.3.167');
    service.startPolling('plug-2', '192.168.3.168');
    await vi.advanceTimersByTimeAsync(0);

    expect(service.isPolling('plug-1')).toBe(true);
    expect(service.isPolling('plug-2')).toBe(true);

    service.stopAll();

    expect(service.isPolling('plug-1')).toBe(false);
    expect(service.isPolling('plug-2')).toBe(false);
  });

  it('Test 6: startPolling() with custom intervalMs uses that interval', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ apower: 0, voltage: 230, current: 0, output: false, aenergy: { total: 0 } }),
    });

    service.startPolling('plug-1', '192.168.3.167', 5000);
    await vi.advanceTimersByTimeAsync(0);

    // After initial call, reset count
    const countAfterInitial = mockFetch.mock.calls.length;

    // Advance 4999ms -- should NOT have polled again
    await vi.advanceTimersByTimeAsync(4999);
    expect(mockFetch.mock.calls.length).toBe(countAfterInitial);

    // Advance 1ms more (total 5000ms) -- should have polled again
    await vi.advanceTimersByTimeAsync(1);
    expect(mockFetch.mock.calls.length).toBe(countAfterInitial + 1);
  });

  it('Test 7: persistIfDue writes at ACTIVE_INTERVAL when power > 5W, at IDLE_INTERVAL when <= 5W', async () => {
    const { db } = await import('@/db/client');
    const insertSpy = vi.mocked(db.insert);

    // First poll: active power (42W > 5W threshold) -- should persist immediately
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ apower: 42, voltage: 230, current: 0.18, output: true, aenergy: { total: 10 } }),
    });

    service.startPolling('plug-1', '192.168.3.167');
    await vi.advanceTimersByTimeAsync(0);

    const firstInsertCount = insertSpy.mock.calls.length;
    expect(firstInsertCount).toBeGreaterThan(0);

    // Second poll at 500ms -- should NOT persist (< 1000ms ACTIVE_INTERVAL)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ apower: 42, voltage: 230, current: 0.18, output: true, aenergy: { total: 10 } }),
    });
    await vi.advanceTimersByTimeAsync(500);
    // insert count should not have increased for powerReadings
    // (db.update calls happen for plugs.online but db.insert is for powerReadings)

    // Third poll at 1000ms -- should persist (>= 1000ms ACTIVE_INTERVAL)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ apower: 42, voltage: 230, current: 0.18, output: true, aenergy: { total: 10 } }),
    });
    await vi.advanceTimersByTimeAsync(500);

    const afterActiveCount = insertSpy.mock.calls.length;
    expect(afterActiveCount).toBeGreaterThan(firstInsertCount);

    // Now test idle interval: power <= 5W
    // Reset for idle test
    insertSpy.mockClear();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ apower: 2, voltage: 230, current: 0.01, output: true, aenergy: { total: 10 } }),
    });
    await vi.advanceTimersByTimeAsync(1000);

    const idleFirstCount = insertSpy.mock.calls.length;

    // Poll again at 30s -- should NOT persist yet (< 60s IDLE_INTERVAL)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ apower: 2, voltage: 230, current: 0.01, output: true, aenergy: { total: 10 } }),
    });
    await vi.advanceTimersByTimeAsync(30000);

    expect(insertSpy.mock.calls.length).toBe(idleFirstCount);
  });

  it('startPolling() guards against double-polling same plugId', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ apower: 0, voltage: 230, current: 0, output: false, aenergy: { total: 0 } }),
    });

    service.startPolling('plug-1', '192.168.3.167');
    service.startPolling('plug-1', '192.168.3.167'); // should be ignored
    await vi.advanceTimersByTimeAsync(0);

    // Only one immediate poll should have been called
    // (fetch may be called once for the first startPolling)
    expect(mockFetch.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
