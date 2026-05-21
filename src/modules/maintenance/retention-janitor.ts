// NOTE: We intentionally do NOT `import 'server-only'` here.
// server-only throws when loaded outside a React Server Component module,
// and this file is imported by the custom Node entrypoint (server.ts), which
// is not a RSC. The db client below transitively imports better-sqlite3,
// which is a native Node module — any client import attempt would fail at
// build time with "Module not found: Can't resolve 'better-sqlite3'".
import { sql } from 'drizzle-orm';
import { db } from '@/db/client';

/**
 * Periodic janitor that keeps the SQLite DB from growing unbounded. Two
 * cleanups, both bounded by row + time gates so even a long-uptime box
 * doesn't pay a stall on the read path:
 *
 *  1. power_readings older than POWER_READING_TTL_MS that are NOT part of a
 *     charge_session timeframe (no session_readings row points at the same
 *     plug+timestamp). The session-linked readings are the ground truth for
 *     the historical chart on /history/[sessionId] — preserving them keeps
 *     past sessions reviewable. The unlinked readings are just live-stream
 *     telemetry and become noise after a few days.
 *
 *  2. SQLite incremental WAL checkpoint after a successful prune so the
 *     -wal file doesn't accumulate into the GB range under heavy churn.
 *
 * Runs from a setInterval kicked by server.ts. Logs counts to journalctl so
 * the user can see retention activity. Failures are caught and logged but
 * never thrown — retention is best-effort, never blocks the running app.
 */

// Keep 14 days of live power_readings — generous enough that learning a
// reference curve from "the last week" still has data, short enough that
// 128 k → ~30 k rows total. Active session readings stay forever via the
// session_readings copy.
export const POWER_READING_TTL_MS = 14 * 24 * 60 * 60 * 1000;

const JANITOR_INTERVAL_MS = 4 * 60 * 60 * 1000;   // 4 h
const MAX_DELETE_PER_RUN = 50_000;                // safety cap

export type JanitorOutcome = {
  prunedRows: number;
  walCheckpointed: boolean;
  durationMs: number;
  error?: string;
};

export async function runRetentionJanitor(): Promise<JanitorOutcome> {
  const start = Date.now();
  const cutoffMs = start - POWER_READING_TTL_MS;
  let prunedRows = 0;
  let walCheckpointed = false;

  try {
    // Bounded DELETE — never touch more than MAX_DELETE_PER_RUN per cycle so
    // a long-overdue cleanup doesn't lock the writer for minutes. SQLite
    // serialises writes; small batches keep the dashboard responsive.
    // session_readings is the durable copy for completed sessions, so we
    // don't need a join to "preserve session data" — we just gate by age.
    const result = db.run(sql`
      DELETE FROM power_readings
       WHERE id IN (
         SELECT id FROM power_readings
          WHERE timestamp < ${cutoffMs}
          ORDER BY id ASC
          LIMIT ${MAX_DELETE_PER_RUN}
       )
    `);
    prunedRows = (result as { changes?: number })?.changes ?? 0;

    if (prunedRows > 0) {
      // wal_checkpoint(TRUNCATE) collapses the -wal file back into the main
      // DB and zeroes it out. PASSIVE would do less work but accumulate.
      try {
        db.run(sql`PRAGMA wal_checkpoint(TRUNCATE)`);
        walCheckpointed = true;
      } catch {
        // checkpoint races with active writers — non-fatal, will get
        // checkpointed next cycle.
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[retention-janitor] cycle failed:', msg);
    return {
      prunedRows,
      walCheckpointed,
      durationMs: Date.now() - start,
      error: msg,
    };
  }

  const durationMs = Date.now() - start;
  if (prunedRows > 0) {
    console.log(`[retention-janitor] pruned ${prunedRows} power_readings older than ${POWER_READING_TTL_MS / (24 * 60 * 60 * 1000)} days (${durationMs} ms${walCheckpointed ? ', WAL truncated' : ''})`);
  }
  return { prunedRows, walCheckpointed, durationMs };
}

export class RetentionJanitor {
  private timer: ReturnType<typeof setInterval> | null = null;

  start(): void {
    if (this.timer !== null) return;

    // First cycle 60 s after boot so a freshly-restarted service doesn't
    // compete with the dashboard's initial render for writes. Subsequent
    // cycles run every 4 h.
    setTimeout(() => {
      void runRetentionJanitor();
    }, 60_000).unref();

    this.timer = setInterval(() => {
      void runRetentionJanitor();
    }, JANITOR_INTERVAL_MS);
    if (typeof this.timer.unref === 'function') this.timer.unref();

    console.log(`[retention-janitor] started (interval=${JANITOR_INTERVAL_MS / 1000 / 60} min, ttl=${POWER_READING_TTL_MS / (24 * 60 * 60 * 1000)} d)`);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
      console.log('[retention-janitor] stopped');
    }
  }
}
