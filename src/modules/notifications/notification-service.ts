/**
 * NotificationService - dispatches Pushover notifications on charge state transitions.
 *
 * Listens to charge:* events from the EventBus and sends notifications for:
 * - matched: Device recognized
 * - complete: Target SOC reached
 * - error/aborted: Charge failure
 * - learn_complete: Learning mode finished
 *
 * Deduplicates per plug (same state not re-notified within 60s cooldown).
 * Skips sending if Pushover credentials are not configured.
 */

import type { EventBus } from '@/modules/events/event-bus';
import type { ChargeStateEvent } from '@/modules/charging/types';
import { sendPushover } from './pushover-client';
import { db } from '@/db/client';
import { config } from '@/db/schema';
import { eq } from 'drizzle-orm';

const NOTIFICATION_STATES = new Set(['matched', 'complete', 'error', 'aborted', 'learn_complete']);

const TERMINAL_STATES = new Set(['complete', 'error', 'aborted']);

const COOLDOWN_MS = 60_000;

export class NotificationService {
  private eventBus: EventBus;
  private lastNotifiedState = new Map<string, string>();
  private lastNotifiedTime = new Map<string, number>();
  private handler: (event: ChargeStateEvent) => void;

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
    this.handler = (event: ChargeStateEvent) => this.handleEvent(event);
  }

  start() {
    this.eventBus.on('charge:*', this.handler);
    console.log('NotificationService started');
  }

  stop() {
    this.eventBus.off('charge:*', this.handler);
    console.log('NotificationService stopped');
  }

  private async handleEvent(event: ChargeStateEvent) {
    if (!NOTIFICATION_STATES.has(event.state)) return;

    // Dedup: skip if same state for same plug within cooldown
    const lastState = this.lastNotifiedState.get(event.plugId);
    const lastTime = this.lastNotifiedTime.get(event.plugId) ?? 0;
    if (lastState === event.state && Date.now() - lastTime < COOLDOWN_MS) {
      return;
    }

    const credentials = this.getCredentials();
    if (!credentials) return;

    const msg = this.buildMessage(event);

    const sent = await sendPushover({
      userKey: credentials.userKey,
      apiToken: credentials.apiToken,
      title: msg.title,
      message: msg.message,
      priority: msg.priority,
    });

    if (sent) {
      this.lastNotifiedState.set(event.plugId, event.state);
      this.lastNotifiedTime.set(event.plugId, Date.now());
    }

    // On terminal states, clear dedup so next session triggers fresh
    if (TERMINAL_STATES.has(event.state)) {
      this.lastNotifiedState.delete(event.plugId);
      this.lastNotifiedTime.delete(event.plugId);
    }
  }

  private getCredentials(): { userKey: string; apiToken: string } | null {
    const userKeyRow = db.select().from(config).where(eq(config.key, 'pushover.userKey')).get();
    const apiTokenRow = db.select().from(config).where(eq(config.key, 'pushover.apiToken')).get();

    if (!userKeyRow?.value || !apiTokenRow?.value) return null;

    return { userKey: userKeyRow.value, apiToken: apiTokenRow.value };
  }

  private buildMessage(event: ChargeStateEvent): { title: string; message: string; priority: number } {
    switch (event.state) {
      case 'matched':
        return {
          title: 'Ladevorgang erkannt',
          message: `${event.profileName ?? 'Unbekannt'} wurde erkannt (${event.confidence ?? 0}% Konfidenz)`,
          priority: 0,
        };
      case 'complete':
        return {
          title: 'Ziel-SOC erreicht',
          message: `Laden abgeschlossen bei ${event.estimatedSoc ?? '?'}% SOC`,
          priority: 0,
        };
      case 'error':
      case 'aborted':
        return {
          title: 'Ladefehler',
          message: `Ladevorgang fehlgeschlagen: ${event.state}`,
          priority: 1,
        };
      case 'learn_complete':
        return {
          title: 'Lernvorgang abgeschlossen',
          message: `Referenzkurve aufgezeichnet für ${event.profileName ?? 'Unbekannt'}`,
          priority: 0,
        };
      default:
        return { title: 'Ladestatus', message: event.state, priority: -1 };
    }
  }
}
