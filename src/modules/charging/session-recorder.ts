/**
 * SessionRecorder - persists power readings and state events during active charge sessions.
 *
 * Listens to:
 * - charge:* events: Tracks session lifecycle, inserts sessionEvents rows per state transition.
 * - power:* events: During active sessions, inserts sessionReadings rows (throttled to every 5th reading).
 */

import type { EventBus, PowerReading } from '@/modules/events/event-bus';
import type { ChargeStateEvent } from '@/modules/charging/types';
import { db } from '@/db/client';
import { chargeSessions, sessionReadings, sessionEvents } from '@/db/schema';
import { eq, and } from 'drizzle-orm';

const READING_THROTTLE = 5;

export class SessionRecorder {
  private eventBus: EventBus;
  private activeSessionStartTimes = new Map<string, number>();
  private activeSessionIds = new Map<string, number>();
  private readingCount = new Map<string, number>();
  // Last state persisted per session — suppresses duplicate sessionEvents rows
  // when ChargeMonitor emits multiple times in the same state.
  private lastLoggedState = new Map<number, string>();
  private chargeHandler: (event: ChargeStateEvent) => void;
  private powerHandler: (reading: PowerReading) => void;

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
    this.chargeHandler = (event: ChargeStateEvent) => this.handleChargeEvent(event);
    this.powerHandler = (reading: PowerReading) => this.handlePowerReading(reading);
  }

  start() {
    this.eventBus.on('charge:*', this.chargeHandler);
    this.eventBus.on('power:*', this.powerHandler);
    console.log('SessionRecorder started');
  }

  stop() {
    this.eventBus.off('charge:*', this.chargeHandler);
    this.eventBus.off('power:*', this.powerHandler);
    console.log('SessionRecorder stopped');
  }

  private handleChargeEvent(event: ChargeStateEvent) {
    const { plugId, state } = event;

    if (state === 'detecting') {
      // Look up the session from DB to get sessionId and startedAt
      const session = db
        .select()
        .from(chargeSessions)
        .where(and(eq(chargeSessions.plugId, plugId), eq(chargeSessions.state, 'detecting')))
        .get();

      if (session) {
        this.activeSessionIds.set(plugId, session.id);
        this.activeSessionStartTimes.set(plugId, session.startedAt);
        this.readingCount.set(plugId, 0);
        this.insertSessionEvent(session.id, state);
      }
      return;
    }

    // For sessionId, prefer event.sessionId, then our tracking map
    const sessionId = event.sessionId ?? this.activeSessionIds.get(plugId);

    if (state === 'matched' || state === 'charging' || state === 'countdown' ||
        state === 'stopping' || state === 'learning' || state === 'learn_complete') {
      if (sessionId != null) {
        // Update tracking if we got sessionId from event but didn't have it
        if (!this.activeSessionIds.has(plugId) && event.sessionId != null) {
          this.activeSessionIds.set(plugId, event.sessionId);
        }
        this.insertSessionEvent(sessionId, state);
      }
      return;
    }

    // Terminal states: complete, error, aborted, idle
    if (state === 'complete' || state === 'error' || state === 'aborted' || state === 'idle') {
      if (sessionId != null && state !== 'idle') {
        this.insertSessionEvent(sessionId, state);
      }
      // Clean up tracking maps
      if (sessionId != null) this.lastLoggedState.delete(sessionId);
      this.activeSessionIds.delete(plugId);
      this.activeSessionStartTimes.delete(plugId);
      this.readingCount.delete(plugId);
    }
  }

  private handlePowerReading(reading: PowerReading) {
    const sessionId = this.activeSessionIds.get(reading.plugId);
    if (sessionId == null) return;

    const count = (this.readingCount.get(reading.plugId) ?? 0) + 1;
    this.readingCount.set(reading.plugId, count);

    // Throttle: only persist every Nth reading
    if (count % READING_THROTTLE !== 0) return;

    const startTime = this.activeSessionStartTimes.get(reading.plugId) ?? reading.timestamp;
    const offsetMs = reading.timestamp - startTime;

    db.insert(sessionReadings).values({
      sessionId,
      offsetMs,
      apower: reading.apower,
      voltage: reading.voltage,
      current: reading.current,
      timestamp: reading.timestamp,
    }).run();
  }

  private insertSessionEvent(sessionId: number, state: string) {
    // Deduplicate: only log state TRANSITIONS, not every event at the same state.
    const prev = this.lastLoggedState.get(sessionId);
    if (prev === state) return;
    this.lastLoggedState.set(sessionId, state);

    db.insert(sessionEvents).values({
      sessionId,
      state,
      timestamp: Date.now(),
    }).run();
  }
}
