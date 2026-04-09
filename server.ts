import { createServer } from 'http';
import next from 'next';
import { HttpPollingService } from './src/modules/shelly/http-polling-service';
import { EventBus } from './src/modules/events/event-bus';
import { ChargeMonitor } from './src/modules/charging/charge-monitor';
import { NotificationService } from './src/modules/notifications/notification-service';
import { SessionRecorder } from './src/modules/charging/session-recorder';
import { db } from './src/db/client';
import { plugs } from './src/db/schema';
import { env } from './src/lib/env';

const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();

async function main() {
  await app.prepare();

  const eventBus = new EventBus();
  const httpPollingService = new HttpPollingService(eventBus);

  // Initialize ChargeMonitor singleton
  const chargeMonitor = new ChargeMonitor(eventBus);
  chargeMonitor.start();

  // Initialize notification and session recording services
  const notificationService = new NotificationService(eventBus);
  notificationService.start();
  const sessionRecorder = new SessionRecorder(eventBus);
  sessionRecorder.start();

  // Expose globals for route handlers
  globalThis.__eventBus = eventBus;
  globalThis.__httpPollingService = httpPollingService;
  globalThis.__chargeMonitor = chargeMonitor;

  // Start HTTP polling for all registered plugs with IP addresses
  const registeredPlugs = db.select().from(plugs).all();
  for (const plug of registeredPlugs) {
    if (plug.enabled && plug.ipAddress) {
      httpPollingService.startPolling(plug.id, plug.ipAddress, (plug.pollingInterval ?? 1) * 1000);
    }
  }

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
    notificationService.stop();
    sessionRecorder.stop();
    chargeMonitor.stop();
    httpPollingService.stopAll();
    server.close(() => {
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch(console.error);
