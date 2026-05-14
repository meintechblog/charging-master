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

import os from 'node:os';
import type { EventBus } from '@/modules/events/event-bus';
import type { ChargeStateEvent } from '@/modules/charging/types';
import { renderSocBandAscii } from '@/modules/charging/soc-band-ascii';
import { sendPushover } from './pushover-client';
import { db } from '@/db/client';
import { config, deviceProfiles, chargers, chargeSessions, plugs, powerReadings } from '@/db/schema';
import { eq, desc } from 'drizzle-orm';

/**
 * Built message shape returned by buildMessage / buildMatchedMessage /
 * buildCompleteMessage. Phase 11-03 W4 (closed): monospace is on the builder
 * return type so handleEvent threads ONE locked flag through to sendPushover.
 * No parallel OR-fork in the call site.
 */
type BuiltMessage = {
  title: string;
  message: string;
  priority: number;
  monospace?: 0 | 1;
};

const DEFAULT_ELECTRICITY_PRICE_EUR_PER_KWH = 0.40;

function formatDurationMs(ms: number): string {
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h >= 1) return `${h} h ${m} min`;
  return `${m} min`;
}

function formatWh(wh: number): string {
  if (wh >= 1000) return `${(wh / 1000).toFixed(2)} kWh`;
  return `${wh.toFixed(0)} Wh`;
}

function formatEur(eur: number): string {
  return `${eur.toFixed(2).replace('.', ',')} EUR`;
}

function getElectricityPrice(): number {
  const row = db.select().from(config).where(eq(config.key, 'electricity.priceEurPerKwh')).get();
  if (!row?.value) return DEFAULT_ELECTRICITY_PRICE_EUR_PER_KWH;
  const n = parseFloat(row.value);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_ELECTRICITY_PRICE_EUR_PER_KWH;
}

const NOTIFICATION_STATES = new Set(['detecting', 'matched', 'complete', 'error', 'aborted', 'learn_complete']);

const TERMINAL_STATES = new Set(['complete', 'error', 'aborted']);

const COOLDOWN_MS = 60_000;

/**
 * Pure resolver for the instance label used to prefix push titles. Precedence:
 *   1. configLabel (DB override — `config.instance.label`)
 *   2. First non-internal IPv4 from os.networkInterfaces()
 *   3. hostname (last resort, fed by caller)
 *
 * Pure function so tests don't have to mock node:os or the db module.
 */
export function resolveInstanceLabel(opts: {
  configLabel: string | null | undefined;
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  hostname: string;
}): string {
  if (opts.configLabel && opts.configLabel.trim() !== '') {
    return opts.configLabel;
  }
  for (const addrs of Object.values(opts.interfaces)) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) {
        return addr.address;
      }
    }
  }
  return opts.hostname;
}

export class NotificationService {
  private eventBus: EventBus;
  private lastNotifiedState = new Map<string, string>();
  private lastNotifiedTime = new Map<string, number>();
  private handler: (event: ChargeStateEvent) => void;
  private instanceLabel: string | null = null;

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
    this.handler = (event: ChargeStateEvent) => this.handleEvent(event);
  }

  // Identify which instance fired the push so multi-LXC users can tell them
  // apart. Cached after first lookup; restart to re-read.
  private getInstanceLabel(): string {
    if (this.instanceLabel) return this.instanceLabel;

    const labelRow = db.select().from(config).where(eq(config.key, 'instance.label')).get();
    this.instanceLabel = resolveInstanceLabel({
      configLabel: labelRow?.value ?? null,
      interfaces: os.networkInterfaces(),
      hostname: os.hostname(),
    });
    return this.instanceLabel;
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

    // Detection-exhausted re-emits the 'detecting' state at MAX_DETECTION_READINGS
    // to drive the UnknownDeviceDialog. Don't notify a second time for the same
    // session — the start announcement already fired at idle→detecting.
    if (event.state === 'detecting' && event.detectionExhausted) return;

    // Dedup: skip if same state for same plug within cooldown
    const lastState = this.lastNotifiedState.get(event.plugId);
    const lastTime = this.lastNotifiedTime.get(event.plugId) ?? 0;
    if (lastState === event.state && Date.now() - lastTime < COOLDOWN_MS) {
      return;
    }

    const credentials = this.getCredentials();
    if (!credentials) return;

    const msg = this.buildMessage(event);
    const label = this.getInstanceLabel();

    const sent = await sendPushover({
      userKey: credentials.userKey,
      apiToken: credentials.apiToken,
      title: `[${label}] ${msg.title}`,
      message: msg.message,
      priority: msg.priority,
      monospace: msg.monospace,
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

  private buildMessage(event: ChargeStateEvent): BuiltMessage {
    switch (event.state) {
      case 'detecting':
        return this.buildDetectingMessage(event);

      case 'matched': {
        const conf = event.confidence != null ? `${(event.confidence * 100).toFixed(0)} %` : '?';
        const lines = [
          `${event.profileName ?? 'Unbekannt'} erkannt (${conf} Konfidenz).`,
        ];
        if (event.estimatedSoc != null) lines.push(`Start-SOC ~${event.estimatedSoc} %.`);
        if (event.targetSoc != null) lines.push(`Ziel: ${event.targetSoc} %.`);

        // Phase 11-03 SOCB-05: attach the ASCII SOC band when the matcher
        // produced one (event has socMin/socMax + estimatedSoc + targetSoc).
        // Back-compat: when band fields are absent, the message stays in the
        // legacy single-line form and monospace is omitted (W4 locked path).
        const built: BuiltMessage = {
          title: 'Ladevorgang erkannt',
          message: lines.join(' '),
          priority: 0,
        };
        if (
          event.socMin != null &&
          event.socMax != null &&
          event.estimatedSoc != null &&
          event.targetSoc != null
        ) {
          const bar = renderSocBandAscii({
            socMin: event.socMin,
            socMax: event.socMax,
            socBest: event.estimatedSoc,
            targetSoc: event.targetSoc,
            mode: 'pushover',
          });
          built.message = `${built.message}\n${bar}`;
          built.monospace = 1;
        }
        return built;
      }

      case 'complete':
        return this.buildCompleteMessage(event);

      case 'error':
      case 'aborted': {
        const name = event.profileName ?? 'Unbekannt';
        return {
          title: event.state === 'error' ? 'Ladefehler' : 'Ladevorgang abgebrochen',
          message: `${name}: ${event.state}. Plug-Status manuell pruefen.`,
          priority: 1,
        };
      }

      case 'learn_complete': {
        const lines = [`Referenzkurve aufgezeichnet fuer ${event.profileName ?? 'Unbekannt'}.`];
        if (event.elapsedMs) lines.push(`Dauer: ${formatDurationMs(event.elapsedMs)}.`);
        if (event.energyChargedWh) lines.push(`Energie AC: ${formatWh(event.energyChargedWh)}.`);
        return { title: 'Lernvorgang abgeschlossen', message: lines.join(' '), priority: 0 };
      }

      default:
        return { title: 'Ladestatus', message: event.state, priority: -1 };
    }
  }

  private buildDetectingMessage(event: ChargeStateEvent): BuiltMessage {
    const plugRow = db.select().from(plugs).where(eq(plugs.id, event.plugId)).get();
    const plugName = plugRow?.name ?? event.plugId;

    let powerLine = '';
    try {
      const reading = db.select({ apower: powerReadings.apower })
        .from(powerReadings)
        .where(eq(powerReadings.plugId, event.plugId))
        .orderBy(desc(powerReadings.timestamp))
        .limit(1)
        .get();
      if (reading?.apower != null) powerLine = ` ${reading.apower.toFixed(0)} W.`;
    } catch {
      // Best-effort — power line is informational only
    }

    return {
      title: `Ladevorgang gestartet: ${plugName}`,
      message: `${plugName} zieht Strom.${powerLine} Geräteerkennung läuft (~5–10 min).`,
      priority: -1, // quiet — informational, no sound
    };
  }

  private buildCompleteMessage(event: ChargeStateEvent): BuiltMessage {
    const name = event.profileName ?? 'Akku';
    const soc = event.estimatedSoc != null ? `${event.estimatedSoc} %` : '?';

    // Pull authoritative AC Wh from the persisted session row — sessionWh in
    // memory is cleared at cleanupSession time and the event may race that.
    let acWh: number | undefined = event.energyChargedWh ?? undefined;
    let efficiency = 0.85;
    let priceEurPerKwh = getElectricityPrice();

    if (event.sessionId != null) {
      const session = db.select().from(chargeSessions).where(eq(chargeSessions.id, event.sessionId)).get();
      if (session?.energyWh != null) acWh = session.energyWh;

      if (session?.profileId != null) {
        const profile = db.select().from(deviceProfiles).where(eq(deviceProfiles.id, session.profileId)).get();
        if (profile) {
          let resolvedEta: number | null = null;
          if (profile.chargerId != null) {
            const ch = db.select().from(chargers).where(eq(chargers.id, profile.chargerId)).get();
            if (ch?.efficiency != null) resolvedEta = ch.efficiency;
          }
          if (resolvedEta == null && profile.chargerEfficiency != null) {
            resolvedEta = profile.chargerEfficiency;
          }
          if (resolvedEta != null && resolvedEta > 0) efficiency = resolvedEta;
        }
      }
    }

    const dcWh = acWh != null ? acWh * efficiency : null;
    const cost = acWh != null ? (acWh / 1000) * priceEurPerKwh : null;
    const duration = event.elapsedMs ? formatDurationMs(event.elapsedMs) : null;

    const parts: string[] = [];
    parts.push(`${name} -> ${soc} erreicht.`);
    if (dcWh != null && acWh != null) {
      parts.push(`${formatWh(dcWh)} DC im Akku (${formatWh(acWh)} AC, eta ${(efficiency * 100).toFixed(0)} %).`);
    } else if (acWh != null) {
      parts.push(`${formatWh(acWh)} AC.`);
    }
    if (duration) parts.push(`Dauer ${duration}.`);
    if (cost != null) parts.push(`Strompreis ${formatEur(cost)}.`);
    parts.push('Plug abgeschaltet, sicher zum Abnehmen.');

    // Phase 11-03 SOCB-05: attach the ASCII SOC band when band fields are
    // present on the captureEventContext snapshot. handleStopping snapshots
    // before the relay-off await, so socMin/socMax are populated here even
    // after cleanupSession has cleared the per-plug Maps (2640873 bug class
    // closed for the band — same shape as the original estimatedSoc fix).
    const built: BuiltMessage = {
      title: `Akku voll: ${name}`,
      message: parts.join(' '),
      priority: 0,
    };
    if (
      event.socMin != null &&
      event.socMax != null &&
      event.estimatedSoc != null &&
      event.targetSoc != null
    ) {
      const bar = renderSocBandAscii({
        socMin: event.socMin,
        socMax: event.socMax,
        socBest: event.estimatedSoc,
        targetSoc: event.targetSoc,
        mode: 'pushover',
      });
      built.message = `${built.message}\n${bar}`;
      built.monospace = 1;
    }
    return built;
  }
}
