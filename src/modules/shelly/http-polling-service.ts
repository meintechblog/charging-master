import type { EventBus, PowerReading } from '../events/event-bus';
import { db } from '@/db/client';
import { plugs, powerReadings } from '@/db/schema';
import { eq } from 'drizzle-orm';

/**
 * Standalone HTTP polling service for Shelly Plug S Gen3 devices.
 * Polls power data via the Shelly HTTP API, emits PowerReading events
 * on the EventBus, and persists readings to the database.
 *
 * No MQTT dependency -- communicates directly with devices over HTTP.
 */
export class HttpPollingService {
  private eventBus: EventBus;
  private pollers: Map<string, NodeJS.Timeout> = new Map();
  private lastPersistedAt: Map<string, number> = new Map();

  private readonly ACTIVE_POWER_THRESHOLD = 5; // watts
  private readonly ACTIVE_INTERVAL = 1_000; // ms -- persist every 1s during active charging
  private readonly IDLE_INTERVAL = 60_000; // ms -- persist every 60s during idle/standby

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
  }

  /**
   * Start polling a Shelly device at the given IP address.
   * Polls immediately, then at the configured interval.
   * Guards against double-polling the same plugId.
   */
  startPolling(plugId: string, ipAddress: string, intervalMs: number = 1000): void {
    if (this.pollers.has(plugId)) return;

    const poll = async () => {
      try {
        const res = await fetch(
          `http://${ipAddress}/rpc/Switch.GetStatus?id=0`,
          { signal: AbortSignal.timeout(3000) }
        );

        if (res.ok) {
          const status = await res.json();
          const reading: PowerReading = {
            plugId,
            apower: status.apower ?? 0,
            voltage: status.voltage ?? 0,
            current: status.current ?? 0,
            output: status.output ?? false,
            totalEnergy: status.aenergy?.total ?? 0,
            timestamp: Date.now(),
          };

          this.eventBus.emitPowerReading(reading);
          this.persistIfDue(reading);

          // Update online status
          try {
            db.update(plugs)
              .set({ online: true, lastSeen: Date.now(), updatedAt: Date.now() })
              .where(eq(plugs.id, plugId))
              .run();
          } catch { /* plug may not exist yet */ }
        }
      } catch {
        // Shelly unreachable -- mark offline
        try {
          db.update(plugs)
            .set({ online: false, updatedAt: Date.now() })
            .where(eq(plugs.id, plugId))
            .run();
          this.eventBus.emitPlugOnline(plugId, false);
        } catch { /* ignore */ }
      }
    };

    // Poll immediately, then on interval
    poll();
    const timer = setInterval(poll, intervalMs);
    this.pollers.set(plugId, timer);
  }

  /**
   * Stop polling a specific plug (single-plug overload).
   */
  stopPolling(plugId: string): void;
  /**
   * Stop ALL active polling intervals and wait for a brief settle window so
   * any in-flight HTTP fetch has a chance to complete before the caller moves
   * on to e.g. a WAL checkpoint. Returns the number of pollers that were
   * active at the moment the call started.
   *
   * Added in Phase 9 (EXEC-04) for the /api/internal/prepare-for-shutdown
   * drain path. The existing stopAll() method remains for the synchronous
   * SIGTERM shutdown path in server.ts -- do not merge them.
   */
  stopPolling(): Promise<number>;
  stopPolling(plugId?: string): void | Promise<number> {
    if (typeof plugId === 'string') {
      // Single-plug overload -- existing behavior, unchanged.
      const timer = this.pollers.get(plugId);
      if (timer) {
        clearInterval(timer);
        this.pollers.delete(plugId);
      }
      return;
    }

    // No-arg overload -- drain-all.
    const count = this.pollers.size;
    for (const timer of this.pollers.values()) {
      clearInterval(timer);
    }
    this.pollers.clear();
    // Brief settle window so any fetch() that fired just before the interval
    // was cleared has a chance to resolve and land its DB write BEFORE the
    // caller checkpoints the WAL. 100ms is empirically enough -- the fetch
    // itself already has AbortSignal.timeout(3000) but we don't need to wait
    // for a stuck fetch, only for "normal" in-flight ones.
    return new Promise<number>((resolve) => {
      setTimeout(() => resolve(count), 100);
    });
  }

  /**
   * Stop all active polling intervals.
   */
  stopAll(): void {
    for (const timer of this.pollers.values()) {
      clearInterval(timer);
    }
    this.pollers.clear();
  }

  /**
   * Check if a plug is currently being polled.
   */
  isPolling(plugId: string): boolean {
    return this.pollers.has(plugId);
  }

  /**
   * Persist a power reading if enough time has elapsed since the last persist.
   * Uses ACTIVE_INTERVAL (1s) when power > 5W, IDLE_INTERVAL (60s) otherwise.
   */
  private persistIfDue(reading: PowerReading): void {
    const lastPersisted = this.lastPersistedAt.get(reading.plugId) ?? 0;
    const elapsed = reading.timestamp - lastPersisted;
    const interval = reading.apower > this.ACTIVE_POWER_THRESHOLD
      ? this.ACTIVE_INTERVAL
      : this.IDLE_INTERVAL;

    if (elapsed >= interval) {
      this.persistPowerReading(reading);
      this.lastPersistedAt.set(reading.plugId, reading.timestamp);
    }
  }

  /**
   * Insert a power reading into the database.
   */
  private persistPowerReading(reading: PowerReading): void {
    try {
      db.insert(powerReadings).values({
        plugId: reading.plugId,
        apower: reading.apower,
        voltage: reading.voltage,
        current: reading.current,
        output: reading.output,
        totalEnergy: reading.totalEnergy,
        timestamp: reading.timestamp,
      }).run();
    } catch (err) {
      console.error('Failed to persist power reading:', err);
    }
  }
}
