import { createServer } from 'http';
import next from 'next';
import { MqttService } from './src/modules/mqtt/mqtt-service';
import { EventBus, type PlugOnlineEvent } from './src/modules/events/event-bus';
import { ChargeMonitor } from './src/modules/charging/charge-monitor';
import type { DiscoveredDevice } from './src/modules/mqtt/discovery';
import { db } from './src/db/client';
import { config } from './src/db/schema';
import { env } from './src/lib/env';
import { eq } from 'drizzle-orm';

const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();

function getConfigValue(key: string): string | null {
  const row = db.select().from(config).where(eq(config.key, key)).get();
  return row?.value ?? null;
}

async function main() {
  await app.prepare();

  const eventBus = new EventBus();
  const mqttService = new MqttService(eventBus);

  // Load MQTT settings from config table
  const mqttHost = getConfigValue('mqtt.host');
  const mqttPort = getConfigValue('mqtt.port') ?? '1883';
  const mqttUsername = getConfigValue('mqtt.username');
  const mqttPassword = getConfigValue('mqtt.password');

  if (mqttHost) {
    const brokerUrl = `mqtt://${mqttHost}:${mqttPort}`;
    const options: Record<string, string> = {};
    if (mqttUsername) options.username = mqttUsername;
    if (mqttPassword) options.password = mqttPassword;

    await mqttService.connect(brokerUrl, Object.keys(options).length > 0 ? options : undefined);
    console.log(`MQTT connecting to ${brokerUrl}`);
  } else {
    console.log('No MQTT broker configured. Set mqtt.host in settings to connect.');
  }

  // Initialize ChargeMonitor singleton
  const chargeMonitor = new ChargeMonitor(eventBus, mqttService);
  chargeMonitor.start();

  // Expose globals for route handlers
  globalThis.__eventBus = eventBus;
  globalThis.__mqttService = mqttService;
  globalThis.__chargeMonitor = chargeMonitor;

  // Initialize discovered devices tracking
  globalThis.__discoveredDevices = new Map<string, DiscoveredDevice>();

  eventBus.on('online:*', (event: PlugOnlineEvent) => {
    const existing = globalThis.__discoveredDevices.get(event.plugId);
    if (existing) {
      existing.lastSeen = Date.now();
      existing.online = event.online;
    } else {
      globalThis.__discoveredDevices.set(event.plugId, {
        deviceId: event.plugId,
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        online: event.online,
      });
    }
  });

  const server = createServer((req, res) => {
    handle(req, res);
  });

  const host = '0.0.0.0';
  server.listen(env.PORT, host, () => {
    console.log(`Charging Master ready on http://${host}:${env.PORT}`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('Shutting down...');
    chargeMonitor.stop();
    await mqttService.disconnect();
    server.close(() => {
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch(console.error);
