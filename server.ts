import { createServer } from 'http';
import next from 'next';
import { HttpPollingService } from './src/modules/shelly/http-polling-service';
import { EventBus } from './src/modules/events/event-bus';
import { ChargeMonitor } from './src/modules/charging/charge-monitor';
import { NotificationService } from './src/modules/notifications/notification-service';
import { SessionRecorder } from './src/modules/charging/session-recorder';
import { UpdateStateStore } from './src/modules/self-update/update-state-store';
import { UpdateChecker } from './src/modules/self-update/update-checker';
import { RetentionJanitor } from './src/modules/maintenance/retention-janitor';
import { db } from './src/db/client';
import { plugs } from './src/db/schema';
import { env } from './src/lib/env';
import { sql } from 'drizzle-orm';
import { CURRENT_SHA } from './src/lib/version';

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

  // One-shot cleanup: pre-fix updater versions left every update_runs row
  // stuck at status='running' stage='preflight' because RUN_ID was always 0
  // (last_insert_rowid() in a separate sqlite3 invocation). Mark any such
  // orphaned row from >1h ago as 'success' with the current SHA as the
  // best inference (the service IS up at that SHA, after all). Idempotent.
  try {
    // Any update marked 'running' at server boot is by definition orphaned —
    // the updater can't survive a systemctl restart, so if the service is
    // booting and a row says 'running', the run is dead. 5-min grace lets
    // a freshly-spawned updater that just inserted its row not get clobbered
    // by the boot of the service it's about to update (theoretical race).
    const cutoffMs = Date.now() - 5 * 60 * 1000;
    const result = db.run(sql`
      UPDATE update_runs
         SET status = 'success',
             end_at = COALESCE(end_at, start_at + 60000),
             to_sha = COALESCE(to_sha, ${CURRENT_SHA}),
             error_message = COALESCE(error_message, 'auto-recovered: pre-fix updater left this row orphaned')
       WHERE status = 'running'
         AND start_at < ${cutoffMs}
    `);
    const changes = (result as { changes?: number })?.changes ?? 0;
    if (changes > 0) {
      console.log(`[boot] cleaned ${changes} orphaned update_runs row(s)`);
    }
  } catch (err) {
    console.warn('[boot] orphaned update_runs cleanup failed:', err);
  }

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

  // Background DB hygiene — bounded prune of stale power_readings every 4 h
  // plus a WAL truncate so the -wal file doesn't grow without bound.
  const retentionJanitor = new RetentionJanitor();
  retentionJanitor.start();

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

  // Graceful shutdown.
  //
  // The previous version waited on `server.close(callback)` which only fires
  // once every keep-alive socket has drained. Long-lived SSE connections
  // (/api/sse/power, /api/update/log) NEVER drain on their own, so the
  // callback was never reached and systemd's TimeoutStopSec=5 SIGKILLed the
  // process — leaving a `charging-master.db.corrupt` on 2026-03-26 as proof.
  //
  // New approach:
  //  1. Stop accepting NEW connections immediately (server.close).
  //  2. Stop all background services (polling, charge monitor, notifications,
  //     session recorder, update checker) so they stop emitting events.
  //  3. Close idle keep-alives (server.closeIdleConnections, Node 18.2+).
  //  4. Hard cutoff after a 4 s grace: server.closeAllConnections() yanks
  //     remaining SSE/keep-alive sockets so the process can exit. Combined
  //     with systemd TimeoutStopSec=30 this still leaves 26 s of slack.
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Shutting down (signal=${signal})…`);

    try { notificationService.stop(); } catch (err) { console.warn('[shutdown] notificationService.stop failed:', err); }
    try { sessionRecorder.stop(); } catch (err) { console.warn('[shutdown] sessionRecorder.stop failed:', err); }
    try { chargeMonitor.stop(); } catch (err) { console.warn('[shutdown] chargeMonitor.stop failed:', err); }
    try { httpPollingService.stopAll(); } catch (err) { console.warn('[shutdown] httpPollingService.stopAll failed:', err); }
    try { retentionJanitor.stop(); } catch { /* not critical */ }
    try { updateChecker.stop?.(); } catch { /* not critical */ }

    server.close((err) => {
      if (err) console.warn('[shutdown] server.close error:', err.message);
      console.log('[shutdown] HTTP server closed cleanly.');
      process.exit(0);
    });
    if (typeof server.closeIdleConnections === 'function') {
      server.closeIdleConnections();
    }

    // Force-close any still-active SSE / keep-alive sockets after 4 s so the
    // close-callback above can finally fire and the process exits before
    // systemd's TimeoutStopSec=30 hard-kills us.
    const force = setTimeout(() => {
      console.log('[shutdown] Force-closing active connections after 4 s grace.');
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
      // Last-resort safety net: if even closeAllConnections can't break the
      // event loop, hard-exit after another 2 s.
      setTimeout(() => {
        console.warn('[shutdown] Event loop still alive after force-close — exiting.');
        process.exit(0);
      }, 2000).unref();
    }, 4000);
    force.unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch(console.error);
