import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type os from 'node:os';

// Mock db + drizzle for NotificationService unit tests. The
// resolveInstanceLabel tests below use the pure exported function and are
// unaffected by these mocks.
interface FakeRow {
  [k: string]: unknown;
}

const fakeState = {
  configRows: [] as FakeRow[],
  plugRows: [] as FakeRow[],
  chargeSessionRows: [] as FakeRow[],
  deviceProfileRows: [] as FakeRow[],
  chargerRows: [] as FakeRow[],
  powerReadingRows: [] as FakeRow[],
};

function tableToRows(table: unknown): FakeRow[] {
  switch (table) {
    case 'config': return fakeState.configRows;
    case 'plugs': return fakeState.plugRows;
    case 'chargeSessions': return fakeState.chargeSessionRows;
    case 'deviceProfiles': return fakeState.deviceProfileRows;
    case 'chargers': return fakeState.chargerRows;
    case 'powerReadings': return fakeState.powerReadingRows;
    default: return [];
  }
}

vi.mock('@/db/client', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn((pred: { col: unknown; val: unknown }) => ({
          get: vi.fn(() => {
            const rows = tableToRows(table);
            const val = pred.val;
            return rows.find((r) => r.id === val) ??
                   rows.find((r) => r.key === val) ??
                   rows.find((r) => r.plugId === val) ??
                   undefined;
          }),
          orderBy: vi.fn(() => ({
            limit: vi.fn(() => ({
              get: vi.fn(() => undefined),
            })),
          })),
        })),
      })),
    })),
  },
}));

vi.mock('@/db/schema', () => ({
  config: 'config',
  plugs: 'plugs',
  chargeSessions: 'chargeSessions',
  deviceProfiles: 'deviceProfiles',
  chargers: 'chargers',
  powerReadings: 'powerReadings',
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((col, val) => ({ col, val })),
  desc: vi.fn((col) => ({ col, dir: 'desc' })),
}));

vi.mock('./pushover-client', () => ({
  sendPushover: vi.fn(async () => true),
}));

import { resolveInstanceLabel, NotificationService } from './notification-service';
import { EventBus } from '@/modules/events/event-bus';
import type { ChargeStateEvent } from '@/modules/charging/types';
import { sendPushover } from './pushover-client';

type Ifaces = NodeJS.Dict<os.NetworkInterfaceInfo[]>;

function ipv4(address: string, internal = false): os.NetworkInterfaceInfo {
  return {
    address,
    netmask: '255.255.255.0',
    family: 'IPv4',
    mac: '00:00:00:00:00:00',
    internal,
    cidr: `${address}/24`,
  };
}

function ipv6(address: string, internal = false): os.NetworkInterfaceInfo {
  return {
    address,
    netmask: 'ffff:ffff:ffff:ffff::',
    family: 'IPv6',
    mac: '00:00:00:00:00:00',
    internal,
    cidr: `${address}/64`,
    scopeid: 0,
  };
}

describe('resolveInstanceLabel', () => {
  const eth0Only: Ifaces = { eth0: [ipv4('192.168.2.117')] };
  const eth0WithLoopback: Ifaces = {
    lo: [ipv4('127.0.0.1', true)],
    eth0: [ipv4('192.168.3.185')],
  };
  const v6Only: Ifaces = { eth0: [ipv6('fe80::1')] };

  it('prefers config.instance.label when set', () => {
    expect(
      resolveInstanceLabel({
        configLabel: 'Werkstatt',
        interfaces: eth0Only,
        hostname: 'charging-master',
      })
    ).toBe('Werkstatt');
  });

  it('ignores empty / whitespace config label and falls through to IPv4', () => {
    expect(
      resolveInstanceLabel({
        configLabel: '   ',
        interfaces: eth0Only,
        hostname: 'charging-master',
      })
    ).toBe('192.168.2.117');
  });

  it('uses first non-internal IPv4 when no config label', () => {
    expect(
      resolveInstanceLabel({
        configLabel: null,
        interfaces: eth0WithLoopback,
        hostname: 'charging-master',
      })
    ).toBe('192.168.3.185');
  });

  it('skips loopback IPv4 (127.x) even if listed first', () => {
    const ifaces: Ifaces = {
      lo: [ipv4('127.0.0.1', true)],
      eth0: [ipv4('10.0.0.5')],
    };
    expect(
      resolveInstanceLabel({
        configLabel: undefined,
        interfaces: ifaces,
        hostname: 'charging-master',
      })
    ).toBe('10.0.0.5');
  });

  it('falls back to hostname when only IPv6 / no eligible IPv4', () => {
    expect(
      resolveInstanceLabel({
        configLabel: null,
        interfaces: v6Only,
        hostname: 'charging-master',
      })
    ).toBe('charging-master');
  });

  it('falls back to hostname when interfaces empty', () => {
    expect(
      resolveInstanceLabel({
        configLabel: null,
        interfaces: {},
        hostname: 'charging-master',
      })
    ).toBe('charging-master');
  });

  it('config label takes precedence even over loopback-only interfaces', () => {
    expect(
      resolveInstanceLabel({
        configLabel: 'Buero',
        interfaces: { lo: [ipv4('127.0.0.1', true)] },
        hostname: 'charging-master',
      })
    ).toBe('Buero');
  });
});

// --- Phase 11-03 SOCB-05 — ASCII bar in matched/complete messages ----------
//
// W4 closed: monospace threads through buildMessage's return type onto
// sendPushover via ONE locked path. handleEvent reads msg.monospace and
// forwards it directly — no parallel OR-fork at the call site.

function baseEvent(state: ChargeStateEvent['state'], extra: Partial<ChargeStateEvent> = {}): ChargeStateEvent {
  return {
    plugId: 'plug-1',
    state,
    profileName: 'iPad',
    confidence: 0.92,
    estimatedSoc: 50,
    targetSoc: 80,
    sessionId: 1,
    energyChargedWh: 30,
    elapsedMs: 600_000,
    ...extra,
  };
}

function resetFakeState() {
  fakeState.configRows = [];
  fakeState.plugRows = [];
  fakeState.chargeSessionRows = [];
  fakeState.deviceProfileRows = [];
  fakeState.chargerRows = [];
  fakeState.powerReadingRows = [];
}

function seedPushoverCredentials() {
  fakeState.configRows.push({ key: 'pushover.userKey', value: 'u' });
  fakeState.configRows.push({ key: 'pushover.apiToken', value: 't' });
}

describe('NotificationService — matched message with SOC band (SOCB-05)', () => {
  let bus: EventBus;
  let svc: NotificationService;

  beforeEach(() => {
    resetFakeState();
    seedPushoverCredentials();
    vi.mocked(sendPushover).mockClear();
    vi.mocked(sendPushover).mockResolvedValue(true);
    bus = new EventBus();
    svc = new NotificationService(bus);
    svc.start();
  });

  afterEach(() => {
    svc.stop();
  });

  it('matched: appends rendered ASCII bar AND forwards monospace=1 to sendPushover', async () => {
    bus.emitChargeState(baseEvent('matched', {
      socMin: 40, socMax: 60, estimatedSoc: 50, targetSoc: 80,
    }));
    // Give the async handleEvent a tick to resolve sendPushover.
    await new Promise((r) => setImmediate(r));

    expect(sendPushover).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(sendPushover).mock.calls[0][0];
    // Bar glyphs present in message body
    expect(arg.message).toMatch(/[#=.]/);
    // 3-line output → message contains at least 2 '\n' separators after appending the bar
    expect(arg.message.split('\n').length).toBeGreaterThanOrEqual(4); // leading line + 3 bar lines
    expect(arg.monospace).toBe(1);
  });

  it('matched: NO bar and monospace omitted when band fields are missing (back-compat)', async () => {
    // Same event, but WITHOUT socMin/socMax — legacy producer.
    bus.emitChargeState(baseEvent('matched', {
      socMin: undefined, socMax: undefined, estimatedSoc: 50, targetSoc: 80,
    }));
    await new Promise((r) => setImmediate(r));

    expect(sendPushover).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(sendPushover).mock.calls[0][0];
    // Legacy single-line message — no bar glyphs.
    expect(arg.message.includes('#')).toBe(false);
    expect(arg.message.includes('=')).toBe(false);
    expect(arg.monospace).toBeUndefined();
  });

  it('complete: appends rendered ASCII bar AND forwards monospace=1', async () => {
    bus.emitChargeState(baseEvent('complete', {
      socMin: 78, socMax: 82, estimatedSoc: 80, targetSoc: 80,
    }));
    await new Promise((r) => setImmediate(r));

    expect(sendPushover).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(sendPushover).mock.calls[0][0];
    expect(arg.message).toMatch(/[#=.]/);
    expect(arg.monospace).toBe(1);
  });

  it('complete: NO bar when band fields missing (legacy session row)', async () => {
    bus.emitChargeState(baseEvent('complete', {
      socMin: undefined, socMax: undefined, estimatedSoc: 80, targetSoc: 80,
    }));
    await new Promise((r) => setImmediate(r));

    expect(sendPushover).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(sendPushover).mock.calls[0][0];
    expect(arg.message.includes('#')).toBe(false);
    expect(arg.monospace).toBeUndefined();
  });

  it('detecting/error/aborted/learn_complete: monospace omitted (frequency restraint per CONTEXT §3)', async () => {
    // detecting fires the start announcement; even with band fields the bar
    // would spam during detection. The builder MUST omit the bar.
    bus.emitChargeState(baseEvent('error', {
      socMin: 40, socMax: 60, estimatedSoc: 50, targetSoc: 80,
    }));
    await new Promise((r) => setImmediate(r));

    expect(sendPushover).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(sendPushover).mock.calls[0][0];
    expect(arg.monospace).toBeUndefined();
    expect(arg.message.includes('#')).toBe(false);
  });

  it('Pushover ASCII safety — matched message body uses ONLY ASCII bytes (Pitfall 3)', async () => {
    bus.emitChargeState(baseEvent('matched', {
      socMin: 40, socMax: 60, estimatedSoc: 50, targetSoc: 80,
    }));
    await new Promise((r) => setImmediate(r));

    const arg = vi.mocked(sendPushover).mock.calls[0][0];
    // Pushover lock-screen safety: the bar must contain NO non-ASCII bytes.
    // (German prose in the lead-in line uses umlauts; restrict the check to
    // only the lines that ARE the bar — index 1, 2, 3 of the split.)
    const lines = arg.message.split('\n');
    const barLines = lines.slice(1); // first line is German prose, rest is the 3-line bar
    for (const line of barLines) {
      for (let i = 0; i < line.length; i++) {
        expect(line.charCodeAt(i)).toBeLessThan(128);
      }
    }
  });
});

// --- 260527-fmu dedup gate regression -------------------------------------
//
// The previous dedup gate `lastState === state && now - lastTime < 60_000`
// only suppressed re-fires within a 60s window. ChargeMonitor re-emits
// `detecting` on every poll while the state machine sits there, so a stuck
// `detecting` session turned into one push per minute (~960 pushes / 16h
// confirmed in prod on 2026-05-27 on LXC 192.168.2.117).

describe('NotificationService — dedup gate (sustained-state regression)', () => {
  let bus: EventBus;
  let svc: NotificationService;

  beforeEach(() => {
    resetFakeState();
    seedPushoverCredentials();
    vi.mocked(sendPushover).mockClear();
    vi.mocked(sendPushover).mockResolvedValue(true);
    bus = new EventBus();
    svc = new NotificationService(bus);
    svc.start();
  });

  afterEach(() => {
    vi.useRealTimers();
    svc.stop();
  });

  it('sustained detecting fires exactly once across many emits + wall-clock advance', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-27T09:00:00Z'));

    for (let i = 0; i < 10; i++) {
      bus.emitChargeState(baseEvent('detecting'));
      // Drain microtasks so handleEvent runs to completion.
      await vi.advanceTimersByTimeAsync(0);
      // Advance well past the old 60s cooldown — with a time-windowed gate
      // this loop would produce ~5 pushes. With the fix it produces exactly 1.
      vi.setSystemTime(new Date(Date.now() + 65_000));
    }

    expect(vi.mocked(sendPushover).mock.calls.length).toBe(1);
  });

  it('terminal-state cleanup re-enables same-state notification on the next cycle', async () => {
    bus.emitChargeState(baseEvent('detecting'));
    await new Promise((r) => setImmediate(r));

    bus.emitChargeState(baseEvent('complete', { socMin: undefined, socMax: undefined }));
    await new Promise((r) => setImmediate(r));

    // Second cycle on the same plug — terminal cleanup cleared the map,
    // so detecting fires again.
    bus.emitChargeState(baseEvent('detecting'));
    await new Promise((r) => setImmediate(r));

    expect(vi.mocked(sendPushover).mock.calls.length).toBe(3);
  });

  it('different non-terminal states on same plug each fire once', async () => {
    bus.emitChargeState(baseEvent('detecting'));
    await new Promise((r) => setImmediate(r));
    bus.emitChargeState(baseEvent('matched'));
    await new Promise((r) => setImmediate(r));
    bus.emitChargeState(baseEvent('complete', { socMin: undefined, socMax: undefined }));
    await new Promise((r) => setImmediate(r));

    expect(vi.mocked(sendPushover).mock.calls.length).toBe(3);
  });
});
