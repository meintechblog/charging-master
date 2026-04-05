/**
 * Relay Controller -- switches Shelly relay off with MQTT + HTTP fallback.
 *
 * Strategy:
 * 1. Send MQTT 'off' command
 * 2. Wait 3 seconds, check if power dropped
 * 3. If not, retry via HTTP API up to 3 times
 *
 * Includes hysteresis cooldown to prevent rapid on/off cycling (CHRG-07).
 */

import type { MqttService } from '../mqtt/mqtt-service';
import type { EventBus, PowerReading } from '../events/event-bus';

const VERIFY_DELAY_MS = 3000;
const MAX_HTTP_RETRIES = 3;
const POWER_OFF_THRESHOLD = 5; // watts

/** Minimum time between relay off commands to prevent rapid cycling */
export const HYSTERESIS_COOLDOWN_MS = 60_000;

/**
 * Wait for a power reading below threshold on the given plug.
 * Returns true if power drops within the timeout.
 */
function waitForPowerDrop(
  eventBus: EventBus,
  plugId: string,
  timeoutMs: number
): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      eventBus.removeListener(`power:${plugId}`, handler);
      resolve(false);
    }, timeoutMs);

    function handler(reading: PowerReading) {
      if (reading.apower < POWER_OFF_THRESHOLD) {
        clearTimeout(timer);
        eventBus.removeListener(`power:${plugId}`, handler);
        resolve(true);
      }
    }

    eventBus.on(`power:${plugId}`, handler);
  });
}

/**
 * Attempt to switch off the relay for a plug.
 * Tries MQTT first, then falls back to HTTP API.
 * Returns true if relay was confirmed off.
 */
export async function switchRelayOff(
  mqttService: MqttService,
  plug: { mqttTopicPrefix: string; ipAddress: string | null },
  eventBus: EventBus
): Promise<boolean> {
  // Attempt 1: MQTT
  mqttService.publishCommand(plug.mqttTopicPrefix, 'off');

  // Wait and verify via next power reading
  const verified = await waitForPowerDrop(eventBus, plug.mqttTopicPrefix, VERIFY_DELAY_MS);
  if (verified) return true;

  // Attempt 2+: HTTP fallback
  if (plug.ipAddress) {
    for (let retry = 0; retry < MAX_HTTP_RETRIES; retry++) {
      try {
        const res = await fetch(
          `http://${plug.ipAddress}/rpc/Switch.Set?id=0&on=false`,
          { signal: AbortSignal.timeout(3000) }
        );
        if (res.ok) {
          const innerVerified = await waitForPowerDrop(
            eventBus,
            plug.mqttTopicPrefix,
            VERIFY_DELAY_MS
          );
          if (innerVerified) return true;
        }
      } catch {
        // HTTP request failed, retry
      }
    }
  }

  return false; // All attempts failed
}

/**
 * Attempt to switch on the relay for a plug.
 * Sends MQTT 'on' command and, if an IP is known, also issues an HTTP
 * Switch.Set RPC as a belt-and-suspenders fallback so the plug reliably
 * turns on even when the MQTT broker is lagging or the device has just
 * reconnected. Returns true if at least one transport succeeded.
 */
export async function switchRelayOn(
  mqttService: MqttService,
  plug: { mqttTopicPrefix: string; ipAddress: string | null }
): Promise<boolean> {
  let mqttOk = false;
  try {
    mqttService.publishCommand(plug.mqttTopicPrefix, 'on');
    mqttOk = true;
  } catch {
    // MQTT not connected or publish failed -- fall through to HTTP
  }

  if (plug.ipAddress) {
    try {
      const res = await fetch(
        `http://${plug.ipAddress}/rpc/Switch.Set?id=0&on=true`,
        { signal: AbortSignal.timeout(3000) }
      );
      if (res.ok) return true;
    } catch {
      // HTTP failed -- rely on MQTT result
    }
  }

  return mqttOk;
}

/**
 * Check if relay switching is allowed (hysteresis guard).
 * Returns true if enough time has passed since last relay off.
 */
export function canSwitchRelay(lastRelayOffAt: number): boolean {
  return Date.now() - lastRelayOffAt > HYSTERESIS_COOLDOWN_MS;
}
