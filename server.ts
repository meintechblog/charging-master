import { createServer } from 'http';
import next from 'next';
import { HttpPollingService } from './src/modules/shelly/http-polling-service';
import { EventBus } from './src/modules/events/event-bus';
import { ChargeMonitor } from './src/modules/charging/charge-monitor';
import { NotificationService } from './src/modules/notifications/notification-service';
import { SessionRecorder } from './src/modules/charging/session-recorder';
import { UpdateStateStore } from './src/modules/self-update/update-state-store';
import { UpdateChecker } from './src/modules/self-update/update-checker';
import { db } from './src/db/client';
import { plugs } from './src/db/schema';
import { env } from './src/lib/env';

const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();

async function main() {
  await app.prepare();

  // Initialize self-update state store BEFORE anything else touches it.
  // Creates .update-state/ and seeds state.json with { currentSha: CURRENT_SHA, ... }
  // on fresh installs. Idempotent: never overwrites an existing file.
  // NOT wrapped in try/catch — if this fails, the process MUST crash loud.
  UpdateStateStore.init();

  // Boot the background GitHub poller. Fire-and-forget: start() schedules an
  // immediate first check (async) + a 6h setInterval (unref'd). Must run
  // AFTER UpdateStateStore.init() (needs the store) and BEFORE HttpPollingService
  // (convention: self-update infra before device infra).
  // NOT wrapped in try/catch — the constructor and start() are designed to be
  // safe (internal errors never propagate). If this somehow throws, boot should
  // crash loud so we see it in systemd logs.
  const updateChecker = new UpdateChecker(new UpdateStateStore());
  updateChecker.start();
  globalThis.__updateChecker = updateChecker;

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
      httpPollingService.startPolling(
        plug.id,
        plug.ipAddress,
        (plug.pollingInterval ?? 1) * 1000,
        plug.channel ?? 0
      );
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
