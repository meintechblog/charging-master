// src/modules/self-update/update-checker.ts
// Singleton scheduler for background GitHub commit polling.
// Boot: constructed + started from server.ts main() AFTER UpdateStateStore.init()
// and BEFORE HttpPollingService — non-blocking, no await on start().

import { spawn } from 'node:child_process';
import { db } from '@/db/client';
import { config, chargeSessions } from '@/db/schema';
import { eq, inArray } from 'drizzle-orm';
import type { LastCheckResult } from './types';
import { GitHubClient } from './github-client';
import { UpdateStateStore } from './update-state-store';

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const AUTO_UPDATE_TICK_MS = 5 * 60 * 1000; // re-evaluate auto-update conditions every 5 min
const AUTO_UPDATE_MIN_INTERVAL_MS = 23 * 60 * 60 * 1000; // never auto-update more than once per ~day
const ACTIVE_SESSION_STATES = ['detecting', 'matched', 'charging', 'countdown', 'learning', 'stopping'];

export class UpdateChecker {
  private readonly store: UpdateStateStore;
  private readonly client: GitHubClient;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private autoUpdateTickHandle: ReturnType<typeof setInterval> | null = null;
  private isChecking = false;

  constructor(store: UpdateStateStore, client: GitHubClient = new GitHubClient()) {
    this.store = store;
    this.client = client;
  }

  /**
   * Idempotent. Calling start() a second time is a no-op (logs a warning).
   *
   * Fire-and-forget: this method returns synchronously after scheduling the
   * interval. The first check runs asynchronously in the background. Callers
   * (server.ts main()) must NOT await start().
   */
  start(): void {
    if (this.intervalHandle !== null) {
      console.warn('[UpdateChecker] start() called while already running — ignoring');
      return;
    }

    // Kick off the first check immediately (async, no await — we do not want
    // to block server boot on a GitHub round-trip).
    void this.runTick('initial');

    // Schedule recurring checks every 6 hours. .unref() so the interval does
    // not keep the event loop alive — shutdown proceeds normally.
    this.intervalHandle = setInterval(() => {
      void this.runTick('scheduled');
    }, SIX_HOURS_MS);
    this.intervalHandle.unref?.();

    // Auto-update opportunity tick — every 5 min, evaluates whether the
    // configured auto-update window matches and conditions allow firing.
    this.autoUpdateTickHandle = setInterval(() => {
      try { this.maybeAutoUpdate(); } catch { /* swallow */ }
    }, AUTO_UPDATE_TICK_MS);
    this.autoUpdateTickHandle.unref?.();

    console.log(`[UpdateChecker] started (interval: ${SIX_HOURS_MS / 1000 / 60 / 60}h, first check: now, auto-update tick: ${AUTO_UPDATE_TICK_MS / 60000}min)`);
  }

  /** Stop the scheduler. Not wired into server.ts shutdown in Phase 8. */
  stop(): void {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    if (this.autoUpdateTickHandle !== null) {
      clearInterval(this.autoUpdateTickHandle);
      this.autoUpdateTickHandle = null;
    }
    console.log('[UpdateChecker] stopped');
  }

  /**
   * Auto-update guardrails. Fires only when ALL hold:
   *  - update.autoUpdate config is 'true'
   *  - update is genuinely available (lastCheckResult.ok && remoteSha != currentSha)
   *  - local hour matches update.autoUpdateHour (default 3)
   *  - no active charge session (would interrupt user)
   *  - no auto-update in the last AUTO_UPDATE_MIN_INTERVAL_MS
   *  - not already installing
   */
  private maybeAutoUpdate(): void {
    const autoEnabled = this.readConfig('update.autoUpdate') === 'true';
    if (!autoEnabled) return;

    const state = this.store.read();
    if (state.updateStatus === 'installing') return;
    if (state.lastCheckResult?.status !== 'ok') return;
    if (state.lastCheckResult.remoteSha === state.currentSha) return;

    const hourStr = this.readConfig('update.autoUpdateHour') ?? '3';
    const targetHour = parseInt(hourStr, 10);
    if (!Number.isFinite(targetHour) || targetHour < 0 || targetHour > 23) return;
    const localHour = new Date().getHours();
    if (localHour !== targetHour) return;

    const lastAuto = parseInt(this.readConfig('update.lastAutoUpdateAt') ?? '0', 10) || 0;
    if (Date.now() - lastAuto < AUTO_UPDATE_MIN_INTERVAL_MS) return;

    // Don't interrupt an active charge.
    const active = db.select({ id: chargeSessions.id })
      .from(chargeSessions)
      .where(inArray(chargeSessions.state, ACTIVE_SESSION_STATES))
      .all();
    if (active.length > 0) {
      console.log(`[UpdateChecker] auto-update deferred — ${active.length} active session(s)`);
      return;
    }

    console.log(`[UpdateChecker] auto-update window open — triggering update to ${state.lastCheckResult.remoteShaShort}`);
    this.writeConfig('update.lastAutoUpdateAt', String(Date.now()));

    // Mirror the API trigger flow: pre-mark state, spawn systemctl --no-block.
    try {
      this.store.write({
        updateStatus: 'installing',
        targetSha: state.lastCheckResult.remoteSha,
        updateStartedAt: Date.now(),
      });
    } catch (err) {
      console.error(`[UpdateChecker] auto-update state write failed: ${err instanceof Error ? err.message : err}`);
      return;
    }

    try {
      const child = spawn(
        'systemctl',
        ['start', '--no-block', 'charging-master-updater.service'],
        { detached: true, stdio: 'ignore' },
      );
      child.unref();
    } catch (err) {
      console.error(`[UpdateChecker] auto-update spawn failed: ${err instanceof Error ? err.message : err}`);
      // Roll back the installing state
      try {
        this.store.write({ updateStatus: 'idle', targetSha: null, updateStartedAt: null });
      } catch { /* best effort */ }
    }
  }

  private readConfig(key: string): string | null {
    try {
      const row = db.select().from(config).where(eq(config.key, key)).get();
      return row?.value ?? null;
    } catch {
      return null;
    }
  }

  private writeConfig(key: string, value: string): void {
    try {
      db.insert(config)
        .values({ key, value, updatedAt: Date.now() })
        .onConflictDoUpdate({ target: config.key, set: { value, updatedAt: Date.now() } })
        .run();
    } catch { /* best effort */ }
  }

  /**
   * Run a single check. Safe to call concurrently: the isChecking flag
   * guarantees only one in-flight GitHub call at a time. The second caller
   * short-circuits with the CURRENT persisted result (no error, no wait).
   *
   * Used by both the interval tick AND GET /api/update/check.
   */
  async check(options: { manual?: boolean } = {}): Promise<LastCheckResult> {
    if (this.isChecking) {
      // Another tick is already in flight. Return the last persisted result
      // rather than queueing. The UI manual trigger gets "here's what we
      // already know" rather than "please wait" — a pragmatic choice since
      // the in-flight call will update state.json within ~10s anyway.
      const current = this.store.read().lastCheckResult;
      return current ?? { status: 'error', error: 'check already in progress' };
    }

    this.isChecking = true;
    try {
      const state = this.store.read();
      const { result, etag: newEtag } = await this.client.checkLatestCommit({
        etag: state.lastCheckEtag,
      });

      const now = Date.now();

      // Merge rule: NEVER persist { status: 'unchanged' } as the authoritative
      // lastCheckResult — we want the banner to keep showing the previous 'ok'
      // metadata (remote SHA, commit message, etc.) so the UI does not lose
      // context on a 304 reply. Only update lastCheckAt in that case.
      if (result.status === 'unchanged') {
        this.store.write({ lastCheckAt: now });
        if (options.manual) {
          console.log('[UpdateChecker] manual check: 304 unchanged');
        }
        return result;
      }

      // For 'ok', 'rate_limited', and 'error' we persist the new result.
      // ETag is only updated from the client on an 'ok' 200 response.
      const patch: Partial<import('./types').UpdateState> = {
        lastCheckAt: now,
        lastCheckResult: result,
      };
      if (newEtag !== null) {
        patch.lastCheckEtag = newEtag;
      }
      this.store.write(patch);

      if (result.status === 'ok') {
        console.log(
          `[UpdateChecker] ${options.manual ? 'manual' : 'scheduled'} check ok — remote=${result.remoteShaShort} author=${result.author}`,
        );
      } else if (result.status === 'rate_limited') {
        console.warn(
          `[UpdateChecker] rate-limited — reset at ${new Date(result.resetAt * 1000).toISOString()}`,
        );
      } else {
        console.warn(`[UpdateChecker] check error: ${result.error}`);
      }

      return result;
    } catch (err) {
      // Belt-and-suspenders: GitHubClient is contractually non-throwing, but
      // store.read()/write() can throw on fs permission errors. We catch,
      // log, and return an error result so the scheduler loop (and the HTTP
      // manual trigger) never blow up.
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[UpdateChecker] check() threw: ${error}`);
      return { status: 'error', error };
    } finally {
      this.isChecking = false;
    }
  }

  /** Internal wrapper for scheduled ticks — swallows the return value. */
  private async runTick(label: 'initial' | 'scheduled'): Promise<void> {
    try {
      await this.check({ manual: false });
    } catch (err) {
      // check() already has its own try/catch, but this is the final safety net
      // for the setInterval callback — a thrown error here would crash Node's
      // timer machinery only in pathological cases, but we log and swallow anyway.
      console.error(
        `[UpdateChecker] ${label} tick crashed unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
