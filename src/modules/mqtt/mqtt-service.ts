import mqtt, { type MqttClient, type IClientOptions } from 'mqtt';
import type { EventBus, PowerReading } from '../events/event-bus';
import { parseShellyStatus } from './shelly-parser';
import { parseDeviceId, DISCOVERY_TOPICS } from './discovery';
import { db } from '@/db/client';
import { powerReadings } from '@/db/schema';
import { plugs } from '@/db/schema';
import { eq } from 'drizzle-orm';

export class MqttService {
  private client: MqttClient | null = null;
  private eventBus: EventBus;
  private lastPersistedAt: Map<string, number> = new Map();
  private lastMessageAt: number = 0;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private httpPollers: Map<string, NodeJS.Timeout> = new Map();
  // Maps MQTT topic prefix → plug.id for correct DB lookups
  private topicToPlugId: Map<string, string> = new Map();

  private readonly ACTIVE_POWER_THRESHOLD = 5; // watts
  private readonly ACTIVE_INTERVAL = 1_000; // ms -- 1s during active charging for real-time UX
  private readonly IDLE_INTERVAL = 60_000; // ms -- 60s during idle/standby
  private readonly WATCHDOG_CHECK_INTERVAL = 15_000; // ms
  private readonly HTTP_POLL_INTERVAL = 1_000; // ms -- poll Shelly HTTP API every 1s for real-time UX
  private readonly WATCHDOG_STALE_THRESHOLD = 30_000; // ms

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
  }

  async connect(brokerUrl: string, options?: IClientOptions): Promise<void> {
    this.client = mqtt.connect(brokerUrl, {
      reconnectPeriod: 1000,
      connectTimeout: 5000,
      ...options,
    });

    this.client.on('connect', () => {
      console.log('MQTT connected to', brokerUrl);
      this.lastMessageAt = Date.now();
      this.subscribeToDiscoveryAndRegistered();
    });

    this.client.on('message', (topic, payload) => {
      this.lastMessageAt = Date.now();
      this.handleMessage(topic, payload.toString());
    });

    this.client.on('reconnect', () => {
      console.log('MQTT reconnecting...');
    });

    this.client.on('error', (err) => {
      console.error('MQTT error:', err.message);
    });

    this.client.on('offline', () => {
      console.log('MQTT offline');
    });

    // Start watchdog to detect stale/zombie connections
    this.startWatchdog();
  }

  private startWatchdog() {
    this.watchdogTimer = setInterval(() => {
      if (this.client && this.lastMessageAt > 0) {
        const elapsed = Date.now() - this.lastMessageAt;
        if (elapsed > this.WATCHDOG_STALE_THRESHOLD) {
          console.warn(`MQTT watchdog: no messages for ${Math.round(elapsed / 1000)}s, forcing reconnect`);
          this.client.reconnect();
        }
      }
    }, this.WATCHDOG_CHECK_INTERVAL);
  }

  private subscribeToDiscoveryAndRegistered() {
    if (!this.client) return;

    // Subscribe to discovery topics
    for (const topic of DISCOVERY_TOPICS) {
      this.client.subscribe(topic, (err) => {
        if (err) console.error('MQTT subscribe error:', topic, err.message);
      });
    }

    // Subscribe to all registered plugs from database
    const registeredPlugs = db.select().from(plugs).where(eq(plugs.enabled, true)).all();
    for (const plug of registeredPlugs) {
      this.subscribeToPlug(plug.mqttTopicPrefix);
      this.topicToPlugId.set(plug.mqttTopicPrefix, plug.id);
    }
  }

  private handleMessage(topic: string, payload: string) {
    const topicPrefix = parseDeviceId(topic);
    // Resolve MQTT topic prefix to the plug's DB id
    const plugId = this.topicToPlugId.get(topicPrefix) ?? topicPrefix;

    if (topic.endsWith('/online')) {
      const online = payload === 'true';
      this.eventBus.emitPlugOnline(plugId, online);
      try {
        db.update(plugs)
          .set({ online, lastSeen: Date.now(), updatedAt: Date.now() })
          .where(eq(plugs.id, plugId))
          .run();
      } catch { /* plug may not exist in DB yet */ }
      return;
    }

    if (topic.endsWith('/status/switch:0')) {
      const status = parseShellyStatus(payload);
      if (status) {
        const reading: PowerReading = {
          plugId,
          apower: status.apower,
          voltage: status.voltage,
          current: status.current,
          output: status.output,
          totalEnergy: status.aenergy.total,
          timestamp: Date.now(),
        };
        this.eventBus.emitPowerReading(reading);
        this.persistIfDue(reading);
        try {
          db.update(plugs)
            .set({ online: true, lastSeen: Date.now(), updatedAt: Date.now() })
            .where(eq(plugs.id, plugId))
            .run();
        } catch { /* plug may not exist */ }
      }
    }
  }

  private persistIfDue(reading: PowerReading) {
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

  private persistPowerReading(reading: PowerReading) {
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

  subscribeToPlug(topicPrefix: string) {
    if (!this.client) return;
    this.client.subscribe(`${topicPrefix}/status/switch:0`);
    this.client.subscribe(`${topicPrefix}/online`);
  }

  registerTopicMapping(topicPrefix: string, plugId: string) {
    this.topicToPlugId.set(topicPrefix, plugId);
  }

  unsubscribeFromPlug(plugId: string) {
    if (!this.client) return;
    this.client.unsubscribe(`${plugId}/status/switch:0`);
    this.client.unsubscribe(`${plugId}/online`);
  }

  async testConnection(brokerUrl: string, options?: IClientOptions): Promise<boolean> {
    return new Promise((resolve) => {
      const testClient = mqtt.connect(brokerUrl, {
        connectTimeout: 5000,
        reconnectPeriod: 0,
        ...options,
      });

      const cleanup = (result: boolean) => {
        testClient.end();
        resolve(result);
      };

      testClient.on('connect', () => cleanup(true));
      testClient.on('error', () => cleanup(false));

      setTimeout(() => cleanup(false), 5000);
    });
  }

  async disconnect(): Promise<void> {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    if (this.client) {
      await new Promise<void>((resolve) => {
        this.client!.end(false, () => resolve());
      });
      this.client = null;
    }
  }

  publishCommand(topicPrefix: string, command: 'on' | 'off' | 'toggle'): void {
    if (!this.client) throw new Error('MQTT not connected');
    this.client.publish(`${topicPrefix}/command/switch:0`, command);
  }

  /**
   * Request current status from a Shelly device via MQTT RPC.
   * Used during LEARNING and CHARGING states for active polling (Pitfall 2: sparse Shelly updates).
   */
  requestStatus(topicPrefix: string): void {
    if (!this.client) return;
    this.client.publish(`${topicPrefix}/rpc`, JSON.stringify({
      id: Date.now(),
      src: 'charging-master',
      method: 'Switch.GetStatus',
      params: { id: 0 },
    }));
  }

  /**
   * Start HTTP polling for a plug's power data.
   * Shelly Gen3 only sends MQTT status_ntf on "significant changes",
   * so we poll via HTTP API as a reliable data source.
   */
  startHttpPolling(plugId: string): void {
    if (this.httpPollers.has(plugId)) return;

    // Look up IP address from DB
    const plug = db.select().from(plugs).where(eq(plugs.id, plugId)).get();
    const ipAddress = plug?.ipAddress;

    // If no IP, try to derive from Shelly device ID pattern
    // For now, poll all registered plugs that have an IP
    if (!ipAddress) {
      console.log(`HTTP polling skipped for ${plugId}: no IP address configured`);
      return;
    }

    console.log(`Starting HTTP polling for ${plugId} at ${ipAddress}`);

    const poll = async () => {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);

        const res = await fetch(`http://${ipAddress}/rpc/Switch.GetStatus?id=0`, {
          signal: controller.signal,
        });
        clearTimeout(timeout);

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
          } catch { /* ignore */ }
        }
      } catch {
        // Shelly unreachable — mark offline
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
    const timer = setInterval(poll, this.HTTP_POLL_INTERVAL);
    this.httpPollers.set(plugId, timer);
  }

  stopHttpPolling(plugId: string): void {
    const timer = this.httpPollers.get(plugId);
    if (timer) {
      clearInterval(timer);
      this.httpPollers.delete(plugId);
      console.log(`Stopped HTTP polling for ${plugId}`);
    }
  }

  stopAllHttpPolling(): void {
    for (const [plugId, timer] of this.httpPollers) {
      clearInterval(timer);
    }
    this.httpPollers.clear();
  }

  isConnected(): boolean {
    return this.client?.connected ?? false;
  }
}
