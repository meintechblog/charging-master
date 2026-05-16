import type { EventBus, PowerReading } from '../events/event-bus';
import { db } from '@/db/client';
import { plugs, powerReadings } from '@/db/schema';
import { eq } from 'drizzle-orm';
import {
  BURST_DURATION_MS,
  BURST_INTERVAL_MS,
  TRANSIENT_ACTIVE_THRESHOLD_W,
  extractTransientFeatures,
  type TransientSample,
} from '../charging/plug-in-transient';

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
  // Tracks the last time we verified that the device answering at plug.ipAddress
  // is the one we expect. Without this, IP reuse (DHCP gives the same IP to a
  // different device after the original goes offline) leaves the app showing
  // "online" forever because Switch.GetStatus succeeds against the squatter.
  private lastIdCheckAt: Map<string, number> = new Map();
  // 'ok' = last id check matched, re-verify every ID_CHECK_INTERVAL_MS.
  // 'fail' (or absent) = last check missing/failed/mismatched, re-verify on
  // every poll AND skip Switch.GetStatus to avoid emitting bogus readings
  // from a squatter device.
  private lastIdCheckResult: Map<string, 'ok' | 'fail'> = new Map();

  // v1.7-B plug-in transient capture. The first 30 s after apower crosses
  // the active-charge threshold (idle → active transition) carries unique
  // discriminative information per the NILM literature. We detect the
  // edge, fire a parallel 1 Hz poller for BURST_DURATION_MS alongside the
  // normal one, accumulate every sample (from both pollers) into
  // `burstBuffers`, then on burst end extract a fixed-shape feature
  // vector via the pure-functional module and emit it for ChargeMonitor
  // to attach to the active session.
  private lastApower: Map<string, number> = new Map();
  private burstBuffers: Map<string, TransientSample[]> = new Map();
  private burstEndsAt: Map<string, number> = new Map();
  private burstTimers: Map<string, NodeJS.Timeout> = new Map();
  private plugIpAddress: Map<string, string> = new Map();
  private plugChannel: Map<string, number> = new Map();

  private readonly ACTIVE_POWER_THRESHOLD = 5; // watts
  private readonly ACTIVE_INTERVAL = 1_000; // ms -- persist every 1s during active charging
  private readonly IDLE_INTERVAL = 60_000; // ms -- persist every 60s during idle/standby
  private readonly ID_CHECK_INTERVAL_MS = 60_000; // verify device-id at most once per minute per plug

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
  }

  /**
   * Strip the channel suffix off a plug id to get the underlying Shelly
   * device id. Channel-0 plugs are stored as bare `<deviceId>`, channels ≥1
   * as `<deviceId>:<n>` (see CLAUDE.md "Naming"). The device-info endpoint
   * answers with the bare id regardless of channel.
   */
  private baseDeviceId(plugId: string): string {
    const idx = plugId.indexOf(':');
    return idx >= 0 ? plugId.slice(0, idx) : plugId;
  }

  private markOffline(plugId: string): void {
    try {
      db.update(plugs)
        .set({ online: false, updatedAt: Date.now() })
        .where(eq(plugs.id, plugId))
        .run();
      this.eventBus.emitPlugOnline(plugId, false);
    } catch { /* ignore */ }
  }

  /**
   * Start polling a Shelly device at the given IP address.
   * Polls immediately, then at the configured interval.
   * Guards against double-polling the same plugId.
   */
  startPolling(
    plugId: string,
    ipAddress: string,
    intervalMs: number = 1000,
    channel: number = 0
  ): void {
    if (this.pollers.has(plugId)) return;

    const safeChannel = Number.isInteger(channel) && channel >= 0 ? channel : 0;
    this.plugIpAddress.set(plugId, ipAddress);
    this.plugChannel.set(plugId, safeChannel);

    const expectedBaseId = this.baseDeviceId(plugId);

    const poll = async () => {
      // Device-id verification. While the last check is 'ok', re-verify every
      // ID_CHECK_INTERVAL_MS (60s). While 'fail' (or unset), re-verify on
      // every poll AND suppress Switch.GetStatus until we get back to 'ok' —
      // otherwise a squatter at this IP would feed us bogus readings between
      // re-checks.
      const now = Date.now();
      const lastResult = this.lastIdCheckResult.get(plugId);
      const lastCheck = this.lastIdCheckAt.get(plugId) ?? 0;
      const shouldVerifyId =
        lastResult !== 'ok' || (now - lastCheck >= this.ID_CHECK_INTERVAL_MS);

      if (shouldVerifyId) {
        const wasOk = lastResult === 'ok';
        try {
          const infoRes = await fetch(
            `http://${ipAddress}/rpc/Shelly.GetDeviceInfo`,
            { signal: AbortSignal.timeout(3000) }
          );
          if (!infoRes.ok) throw new Error(`GetDeviceInfo HTTP ${infoRes.status}`);
          const info = await infoRes.json();
          if (info.id !== expectedBaseId) {
            // Log only on transition (or first ever) so a persistent mismatch
            // doesn't spam journalctl with the same line every poll.
            if (wasOk || lastResult === undefined) {
              console.warn(
                `[HttpPolling] device-id mismatch at ${ipAddress} for plug ${plugId}: expected ${expectedBaseId}, got ${info.id}. Marking offline.`
              );
            }
            this.lastIdCheckResult.set(plugId, 'fail');
            this.lastIdCheckAt.set(plugId, now);
            this.markOffline(plugId);
            return;
          }
          if (!wasOk && lastResult !== undefined) {
            console.log(
              `[HttpPolling] device-id at ${ipAddress} now matches plug ${plugId}. Resuming polling.`
            );
          }
          this.lastIdCheckResult.set(plugId, 'ok');
          this.lastIdCheckAt.set(plugId, now);
        } catch {
          // Same transition-only logging so an offline plug doesn't fill the
          // journal. The first failure logs; subsequent identical failures are
          // suppressed until we get a successful match or a different error.
          if (wasOk || lastResult === undefined) {
            console.warn(
              `[HttpPolling] device-id probe failed at ${ipAddress} for plug ${plugId} (device unreachable). Marking offline.`
            );
          }
          this.lastIdCheckResult.set(plugId, 'fail');
          this.lastIdCheckAt.set(plugId, now);
          this.markOffline(plugId);
          return;
        }
      }

      try {
        const res = await fetch(
          `http://${ipAddress}/rpc/Switch.GetStatus?id=${safeChannel}`,
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
          this.handleTransientCapture(plugId, reading);

          // Update online status
          try {
            db.update(plugs)
              .set({ online: true, lastSeen: Date.now(), updatedAt: Date.now() })
              .where(eq(plugs.id, plugId))
              .run();
          } catch { /* plug may not exist yet */ }
        }
      } catch {
        this.markOffline(plugId);
      }
    };

    // Poll immediately, then on interval
    poll();
    const timer = setInterval(poll, intervalMs);
    this.pollers.set(plugId, timer);
  }

  /**
   * v1.7-B plug-in transient capture. Detects the idle→active edge, fans
   * the per-plug poller from its normal interval (default 5 s) down to
   * BURST_INTERVAL_MS (1 s) for BURST_DURATION_MS (30 s), accumulates
   * samples, and emits a TransientFeatures event when the burst ends.
   *
   * No-ops cleanly when:
   *   - apower stays below the active threshold (no burst trigger)
   *   - apower stays above the active threshold (we're mid-charge, not
   *     just plugged in — the previous burst already captured features)
   *   - the burst is already in flight (subsequent reading just appends
   *     to the buffer and lets the timer reach `burstEndsAt` naturally)
   */
  private handleTransientCapture(plugId: string, reading: PowerReading): void {
    const prevApower = this.lastApower.get(plugId) ?? 0;
    this.lastApower.set(plugId, reading.apower);

    // Edge trigger: prev < threshold AND current >= threshold AND no burst
    // currently in flight on this plug.
    const wasIdle = prevApower < TRANSIENT_ACTIVE_THRESHOLD_W;
    const isActive = reading.apower >= TRANSIENT_ACTIVE_THRESHOLD_W;
    const burstInFlight = this.burstEndsAt.has(plugId);

    if (wasIdle && isActive && !burstInFlight) {
      this.startBurst(plugId, reading);
    } else if (burstInFlight) {
      // Append this reading to the burst buffer regardless of whether the
      // poller is currently in 1 s burst-mode or back to 5 s — the feature
      // extractor handles uneven spacing via the raw `ts` values.
      const buffer = this.burstBuffers.get(plugId);
      if (buffer) buffer.push({ ts: reading.timestamp, apower: reading.apower });

      const endsAt = this.burstEndsAt.get(plugId);
      if (endsAt !== undefined && reading.timestamp >= endsAt) {
        this.finishBurst(plugId);
      }
    }
  }

  private startBurst(plugId: string, firstReading: PowerReading): void {
    const buffer: TransientSample[] = [
      { ts: firstReading.timestamp, apower: firstReading.apower },
    ];
    this.burstBuffers.set(plugId, buffer);
    this.burstEndsAt.set(plugId, firstReading.timestamp + BURST_DURATION_MS);

    // Spawn a parallel 1 Hz poller for BURST_DURATION_MS. The normal poller
    // keeps running at its configured interval; both feed handleTransient-
    // Capture which appends every reading to `buffer`. We tear the burst
    // poller down via `burstTimers` either when the buffer's time window
    // closes (handled in handleTransientCapture) or via clearBurstTimer
    // from cleanup paths.
    const ipAddress = this.plugIpAddress.get(plugId);
    const channel = this.plugChannel.get(plugId) ?? 0;
    if (!ipAddress) return; // shouldn't happen — startPolling populates it

    const burstPoll = async () => {
      try {
        const res = await fetch(
          `http://${ipAddress}/rpc/Switch.GetStatus?id=${channel}`,
          { signal: AbortSignal.timeout(2000) },
        );
        if (!res.ok) return;
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
        this.handleTransientCapture(plugId, reading);
      } catch {
        // Burst poll failures are non-fatal — the normal poller covers the
        // happy path; one missed 1 s sample doesn't break feature extraction.
      }
    };

    const timer = setInterval(burstPoll, BURST_INTERVAL_MS);
    this.burstTimers.set(plugId, timer);
  }

  private finishBurst(plugId: string): void {
    const buffer = this.burstBuffers.get(plugId);
    const endsAt = this.burstEndsAt.get(plugId);
    this.burstBuffers.delete(plugId);
    this.burstEndsAt.delete(plugId);
    const burstTimer = this.burstTimers.get(plugId);
    if (burstTimer) {
      clearInterval(burstTimer);
      this.burstTimers.delete(plugId);
    }
    if (!buffer || buffer.length < 5) return; // not enough samples to be useful

    const features = extractTransientFeatures(buffer);
    this.eventBus.emitPlugTransient({
      plugId,
      features,
      startedAt: buffer[0].ts,
    });
    console.log(
      `[Transient] ${plugId}: peakW=${features.peakInrushW.toFixed(1)} ` +
        `settlingFrac=${features.settlingFractionOfPeak.toFixed(2)} ` +
        `tStable=${features.tToStableSeconds.toFixed(1)}s ` +
        `osc=${features.oscillationCount} ` +
        `(burst ${buffer.length} samples, ${endsAt ? ((endsAt - buffer[0].ts) / 1000).toFixed(1) : '?'}s)`,
    );
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
      this.lastIdCheckAt.delete(plugId);
      this.lastIdCheckResult.delete(plugId);
      // v1.7-B clear any in-flight burst poller too.
      const burstTimer = this.burstTimers.get(plugId);
      if (burstTimer) {
        clearInterval(burstTimer);
        this.burstTimers.delete(plugId);
      }
      this.burstBuffers.delete(plugId);
      this.burstEndsAt.delete(plugId);
      this.lastApower.delete(plugId);
      this.plugIpAddress.delete(plugId);
      this.plugChannel.delete(plugId);
      return;
    }

    // No-arg overload -- drain-all.
    const count = this.pollers.size;
    for (const timer of this.pollers.values()) {
      clearInterval(timer);
    }
    this.pollers.clear();
    this.lastIdCheckAt.clear();
    this.lastIdCheckResult.clear();
    // v1.7-B drain burst pollers too.
    for (const timer of this.burstTimers.values()) clearInterval(timer);
    this.burstTimers.clear();
    this.burstBuffers.clear();
    this.burstEndsAt.clear();
    this.lastApower.clear();
    this.plugIpAddress.clear();
    this.plugChannel.clear();
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
    this.lastIdCheckAt.clear();
    this.lastIdCheckResult.clear();
    // v1.7-B mirror the stopPolling() teardown.
    for (const timer of this.burstTimers.values()) clearInterval(timer);
    this.burstTimers.clear();
    this.burstBuffers.clear();
    this.burstEndsAt.clear();
    this.lastApower.clear();
    this.plugIpAddress.clear();
    this.plugChannel.clear();
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
