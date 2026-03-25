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

  private readonly ACTIVE_POWER_THRESHOLD = 5; // watts
  private readonly ACTIVE_INTERVAL = 5_000; // ms -- 5s during active charging
  private readonly IDLE_INTERVAL = 60_000; // ms -- 60s during idle/standby
  private readonly WATCHDOG_CHECK_INTERVAL = 15_000; // ms
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
    }
  }

  private handleMessage(topic: string, payload: string) {
    const deviceId = parseDeviceId(topic);

    if (topic.endsWith('/online')) {
      const online = payload === 'true';
      this.eventBus.emitPlugOnline(deviceId, online);
      // Update plug online status in DB
      try {
        db.update(plugs)
          .set({ online, lastSeen: Date.now(), updatedAt: Date.now() })
          .where(eq(plugs.id, deviceId))
          .run();
      } catch { /* plug may not exist in DB yet */ }
      return;
    }

    if (topic.endsWith('/status/switch:0')) {
      const status = parseShellyStatus(payload);
      if (status) {
        const reading: PowerReading = {
          plugId: deviceId,
          apower: status.apower,
          voltage: status.voltage,
          current: status.current,
          output: status.output,
          totalEnergy: status.aenergy.total,
          timestamp: Date.now(),
        };
        this.eventBus.emitPowerReading(reading);
        this.persistIfDue(reading);
        // Update plug lastSeen + online in DB
        try {
          db.update(plugs)
            .set({ online: true, lastSeen: Date.now(), updatedAt: Date.now() })
            .where(eq(plugs.id, deviceId))
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

  subscribeToPlug(plugId: string) {
    if (!this.client) return;
    this.client.subscribe(`${plugId}/status/switch:0`);
    this.client.subscribe(`${plugId}/online`);
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

  isConnected(): boolean {
    return this.client?.connected ?? false;
  }
}
