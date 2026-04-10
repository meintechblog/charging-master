# Stack Research — v1.2 Self-Update Mechanism

**Domain:** In-app self-update for a Next.js 15 server running under systemd on Debian 13 LXC
**Researched:** 2026-04-10
**Confidence:** HIGH

## Scope

This document covers ONLY the libraries and system tools required for the v1.2 self-update milestone. The existing stack (Next.js 15.5, React 19.2, TypeScript 5.9, better-sqlite3, Drizzle, ECharts, SSE via `ReadableStream`, Pushover via native `fetch`, systemd on Debian 13 LXC) is already validated and NOT re-researched here.

**Design decisions already locked by the milestone:**
- Update pipeline runs inside a dedicated systemd one-shot unit `charging-master-updater.service` (NOT inside the Next.js process, which would be about to restart itself)
- GitHub polling every 6 h, unauthenticated, `<60 req/h`
- Version source = latest commit SHA on `main` of `meintechblog/charging-master`
- Auto-rollback to previous HEAD SHA on any failure in the update pipeline
- App process runs as `root` inside the LXC (single-user container, already the case for the Shelly/MQTT phases) — this materially simplifies privilege handling

## Recommended Stack

### New Runtime Dependencies

**None.** Every piece of the self-update feature can be built with Node.js built-ins plus one trivially optional helper. This is deliberate and is the core recommendation of this research.

| What we need | Recommended choice | Why |
|---|---|---|
| GitHub API client | Native `fetch` (Node 22 built-in) | Single endpoint, single verb, no pagination, no auth. A library is pure overhead. |
| Git operations | Shell-out to system `git` via `node:child_process` | Updater runs in a dedicated systemd unit, not in the app. `git` CLI is already on the LXC (needed for the initial clone). No Node library can match `git reset --hard` semantics without surprises. |
| systemctl trigger | `node:child_process.spawn('systemctl', ['start', '--no-block', 'charging-master-updater.service'])` | The app runs as root inside the LXC. No sudo, no polkit, no wrapper library needed. |
| journalctl tail | `node:child_process.spawn('journalctl', ['-fu', 'charging-master-updater.service', '--output=cat'])` piped into an SSE `ReadableStream` | Already proven stack component (SSE). `--output=cat` strips timestamps we don't need; we add our own. |
| 6 h scheduler | `setInterval` in a small singleton started from `instrumentation.ts` | Next.js 15's `instrumentation.ts` is the canonical place for process-lifetime side effects. One instance per process, survives HMR concerns because production runs `next start` without HMR. |
| Build-time version injection | `next.config.ts` reads `git rev-parse HEAD` and `Date.now()`, exposes them via `env` and `publicRuntimeConfig`-style `NEXT_PUBLIC_*` keys | Canonical Next.js pattern. Stays statically inlined, zero runtime cost, available to both server and client. |

### Supporting Libraries (all already present)

| Library | Version (already installed) | Role in v1.2 |
|---|---|---|
| `zod` | ^4.3.6 | Validate the GitHub `/commits/main` response shape and the `UpdateState` row in SQLite |
| `better-sqlite3` | ^12.8.0 | Persist `update_state` (current SHA, last check, last known remote SHA, last update attempt, last error) |
| `drizzle-orm` | ^0.45.1 | Schema + typed queries for the new `update_state` and `update_log` tables |
| `server-only` | ^0.0.1 | Guard the scheduler and spawn helpers so they never get bundled into client components |

### Optional Dev-time Helper

| Tool | Version | Purpose | Verdict |
|---|---|---|---|
| `simple-git` | 3.35.2 (2026-04-06) | Promise wrapper around the `git` CLI | **Do not add.** See "What NOT to Use" for reasoning. Listed here only so the team recognizes it if someone proposes it during implementation. |

## Detailed Answers to the Seven Questions

### 1. GitHub API client

**Recommendation:** Native `fetch` (built into Node 22). Do not add `@octokit/*`.

- The feature uses exactly one endpoint: `GET https://api.github.com/repos/meintechblog/charging-master/commits/main`.
- Response is a single JSON object with `sha`, `commit.author.date`, `commit.message`. Validate with `zod` (already installed).
- **ETag/conditional requests are required for rate-limit friendliness:** unauthenticated clients get 60 req/h, but a `304 Not Modified` response does not count against the budget ([GitHub REST rate-limit docs](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)). With a 6-hour poll interval we only consume ~4 req/day in the worst case anyway, but ETag caching is cheap insurance against accidentally bumping the interval and is trivially implemented:

  ```ts
  // src/modules/update/github-client.ts
  import 'server-only';
  const UA = 'charging-master-update-checker/1.0';
  type CachedEtag = { etag: string; sha: string; checkedAt: number };
  let cache: CachedEtag | null = null; // replace with SQLite row in real impl

  export async function fetchLatestMainSha(): Promise<{ sha: string; notModified: boolean }> {
    const headers: Record<string, string> = {
      'User-Agent': UA,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (cache?.etag) headers['If-None-Match'] = cache.etag;

    const res = await fetch(
      'https://api.github.com/repos/meintechblog/charging-master/commits/main',
      { headers, signal: AbortSignal.timeout(10_000) }
    );
    if (res.status === 304 && cache) return { sha: cache.sha, notModified: true };
    if (!res.ok) throw new Error(`GitHub ${res.status}: ${await res.text()}`);
    const json = await res.json();
    const sha = String(json.sha);
    const etag = res.headers.get('etag');
    if (etag) cache = { etag, sha, checkedAt: Date.now() };
    return { sha, notModified: false };
  }
  ```

- Persist `etag` and `last_known_remote_sha` in the `update_state` SQLite row so they survive restarts — an in-memory cache is useless since we restart on every update.
- Always set a `User-Agent` header; GitHub rejects unauthenticated requests without one.
- Pin the API version via `X-GitHub-Api-Version: 2022-11-28`.
- Use `AbortSignal.timeout()` (Node 22 built-in) so the background check can never hang forever.

**Why not `@octokit/rest` (22.0.1) or `@octokit/request` (10.0.8)?** Octokit is a 300+ kB dependency optimized for authenticated, paginated, multi-endpoint usage (retries, throttling plugins, token rotation). We have one endpoint and no auth. The bundle cost, the supply-chain surface, and the mental overhead aren't justified.

### 2. Git operations

**Recommendation:** Shell-out to the system `git` binary via `node:child_process.spawn`. Do not add `simple-git`, `isomorphic-git`, or any other library.

**Rationale for our context:**

- The updater lives in `charging-master-updater.service` — a bash script or `tsx` one-shot, not the Next.js process. Process-lifecycle concerns (Next.js hot reload, React Server Components bundling) don't apply.
- The Debian LXC already has `git` installed (it was used to clone the repo in the first place). Adding a Node wrapper installs a second git implementation or a second way to invoke the same binary.
- The pipeline is four imperative steps with well-known flags. Wrapping them in a library obscures the shell command being executed — which is exactly the command the operator will paste into their terminal when debugging a failed update.

**Canonical pipeline (for `scripts/update/run-update.ts`, executed by the systemd unit):**

```bash
# All commands run with cwd=/opt/charging-master
PREVIOUS_SHA=$(git rev-parse HEAD)
git fetch --depth=1 origin main                 # shallow fetch, keeps .git small
git reset --hard origin/main                    # hard reset to remote HEAD
pnpm install --frozen-lockfile                  # reproducible install
pnpm build                                      # next build
systemctl restart charging-master.service       # restart the app (updater exits here)
```

On any non-zero exit, the trap resets to `$PREVIOUS_SHA`, re-runs `pnpm install` and `pnpm build`, and exits non-zero so systemd marks the update unit as failed. The app (which by then has re-read `update_state`) shows the rollback in the UI.

**Why not `simple-git` (3.35.2)?** It's a well-maintained Promise wrapper, but:
- It still shells out to the `git` binary — it adds no capability, only an API surface.
- It swallows stdout/stderr by default; for the SSE live log we want raw stream chunks, which `simple-git` makes awkward.
- It adds five transitive dependencies (`@kwsites/file-exists`, `@kwsites/promise-deferred`, `@simple-git/args-pathspec`, `@simple-git/argv-parser`, `debug`) for zero functional gain.

**Why not `isomorphic-git` (1.37.5)?** It's a pure-JS git implementation aimed at environments without the `git` binary (browsers, Cloudflare Workers, etc.). We have the binary. Using a JS reimplementation introduces edge cases (pack-file handling, ref update semantics) we do not want to debug at 2 a.m. during a broken deploy.

### 3. systemd integration

**Recommendation:** Direct `node:child_process.spawn` against `systemctl` and `journalctl`. No library.

The Next.js process runs as `root` inside the LXC (single-user container, matches how the Shelly MQTT broker and the app itself are already wired), so there are **no privilege escalation concerns** — no `sudo`, no polkit rules, no wrapper units.

**Triggering the updater:**

```ts
// src/modules/update/systemctl.ts
import 'server-only';
import { spawn } from 'node:child_process';

export function triggerUpdaterUnit(): Promise<void> {
  return new Promise((resolve, reject) => {
    // --no-block returns immediately without waiting for the unit to finish,
    // which is critical: the unit will restart *this* process.
    const proc = spawn('systemctl', ['start', '--no-block', 'charging-master-updater.service']);
    proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`systemctl exit ${code}`))));
    proc.on('error', reject);
  });
}
```

`--no-block` is essential: without it, `systemctl start` waits for the unit to reach `active`, but the unit's final step restarts `charging-master.service`, killing the very process that is waiting. With `--no-block` the API route returns `202 Accepted` immediately and the UI switches to the log-tail SSE stream.

**Pitfalls for a non-root future (documented so we have the answer if the constraint changes):**

- If the app is ever moved to a non-root user, the clean solution is polkit, not sudoers. Create `/etc/polkit-1/rules.d/50-charging-master-updater.rules`:
  ```javascript
  polkit.addRule(function(action, subject) {
    if (action.id == "org.freedesktop.systemd1.manage-units" &&
        action.lookup("unit") == "charging-master-updater.service" &&
        subject.user == "charging-master") {
      return polkit.Result.YES;
    }
  });
  ```
  Sudoers (`NOPASSWD: /bin/systemctl start charging-master-updater.service`) also works but forces a `sudo` prefix in the spawn call and interacts badly with systemd session management ([ArchWiki polkit reference](https://wiki.archlinux.org/title/Polkit)).
- **Do not** use a library like `systemctl` (npm) or `sd-daemon`. They either wrap the same `spawn` call or require `systemd-notify` integration we don't need.

### 4. Build-time version injection

**Recommendation:** Read git metadata inside `next.config.ts` at build time, expose via the `env` field with `NEXT_PUBLIC_*` keys. No generated file, no runtime tooling.

This is the officially documented Next.js pattern and has been stable across Next 13/14/15 ([Next.js environment variables guide](https://nextjs.org/docs/pages/guides/environment-variables), [vercel/next.js discussion #15849](https://github.com/vercel/next.js/discussions/15849)). The values are statically inlined into both the server bundle and the client bundle at `next build` time.

```ts
// next.config.ts
import type { NextConfig } from 'next';
import { execSync } from 'node:child_process';

function gitSha(): string {
  try {
    return execSync('git rev-parse HEAD', { cwd: __dirname, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function gitShaShort(): string {
  return gitSha().slice(0, 7);
}

const buildTime = new Date().toISOString();

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['echarts', 'zrender'],
  env: {
    NEXT_PUBLIC_COMMIT_SHA: gitSha(),
    NEXT_PUBLIC_COMMIT_SHA_SHORT: gitShaShort(),
    NEXT_PUBLIC_BUILD_TIME: buildTime,
  },
};

export default nextConfig;
```

Usage anywhere in the codebase:

```ts
const currentSha = process.env.NEXT_PUBLIC_COMMIT_SHA!;
const buildTime = process.env.NEXT_PUBLIC_BUILD_TIME!;
```

**Why this over the alternatives:**

- **Generated `src/generated/version.ts` via a prebuild script:** works, but adds a `prebuild` step to `package.json`, a file to `.gitignore`, and a second source of truth. The `next.config.ts` approach is one file and runs automatically at every `next build`.
- **Reading `.git/HEAD` at runtime:** fragile (the file can be a ref or a detached HEAD), ties the running server to an untracked filesystem location, and is pointless because the very next `next build` will overwrite it.
- **`next-build-id` package:** sets `BUILD_ID` but doesn't expose the SHA to application code. We need the SHA in the UI and in the API's `/api/version` response, not just in the Next.js internals.

**Critical detail:** because these are `NEXT_PUBLIC_*` variables, they are inlined at build time. The app MUST be rebuilt (`pnpm build`) on every update — which is already part of the updater pipeline. Reading `process.env.NEXT_PUBLIC_COMMIT_SHA` at runtime after a rebuild returns the new value correctly because Next.js rebuilds the server bundle as well.

### 5. Scheduling the 6 h background check

**Recommendation:** `setInterval` in a module started from Next.js's `instrumentation.ts`. No cron library, no systemd timer.

```ts
// instrumentation.ts (Next.js 15 official entry point for process-lifetime code)
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { startUpdateChecker } = await import('./src/modules/update/scheduler');
  startUpdateChecker();
}
```

```ts
// src/modules/update/scheduler.ts
import 'server-only';
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
let handle: NodeJS.Timeout | null = null;

export function startUpdateChecker() {
  if (handle) return;                       // idempotent; survives HMR in dev
  runCheck().catch(() => {});               // run once at boot
  handle = setInterval(() => { runCheck().catch(() => {}); }, SIX_HOURS_MS);
  handle.unref();                           // don't block process exit
}

async function runCheck() { /* fetch GitHub, update SQLite row */ }
```

**Why this beats the alternatives:**

- **`node-cron` (4.2.1) or `croner` (9.6.1):** cron expressions are overkill for a fixed 6-hour interval. `setInterval(fn, 6 * 3600_000)` is clearer and has zero dependencies. Croner is genuinely excellent (zero deps, DST-aware, the best cron library for Node), but we'd only use one feature (fire every 6 h), which `setInterval` already does.
- **systemd timer:** would move scheduling out of the app, but then needs IPC (HTTP call back to the app, or direct SQLite writes from a second process) to report results to the UI. Pure complication.
- **Next.js route lifecycle / middleware:** routes don't have lifecycle in the "background worker" sense. Running a check inside a route handler only works if the route is called — which defeats the purpose.
- **`instrumentation.ts` specifically:** Next.js 15 runs this exactly once per server process at startup ([Next.js instrumentation docs](https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation)). In production (`next start` or the custom `tsx server.ts` start script this project uses) there is no HMR, so the `if (handle) return` guard is belt-and-braces only.

**Single-instance correctness:** the app runs as exactly one systemd-managed Node process. We do not need distributed locking. The `handle` guard plus systemd's single-instance guarantee is sufficient.

### 6. Log streaming via SSE

**Recommendation:** `spawn('journalctl', ['-fu', 'charging-master-updater.service', '--output=cat', '--lines=100'])` piped into a `ReadableStream` that a Route Handler returns as `text/event-stream`. Reuse the SSE stack that already exists for live charging curves.

```ts
// src/app/api/update/log/route.ts
import { spawn } from 'node:child_process';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const encoder = new TextEncoder();
  const proc = spawn('journalctl', [
    '-fu', 'charging-master-updater.service',
    '--output=cat',
    '--lines=100',
    '--no-pager',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  const stream = new ReadableStream({
    start(controller) {
      const send = (chunk: Buffer) => {
        for (const line of chunk.toString('utf8').split('\n')) {
          if (line) controller.enqueue(encoder.encode(`data: ${line}\n\n`));
        }
      };
      proc.stdout.on('data', send);
      proc.stderr.on('data', send);
      proc.on('close', () => {
        controller.enqueue(encoder.encode('event: end\ndata: {}\n\n'));
        controller.close();
      });
      request.signal.addEventListener('abort', () => {
        proc.kill('SIGTERM');                         // critical: no zombie journalctl
        controller.close();
      });
    },
    cancel() { proc.kill('SIGTERM'); },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
```

**Key correctness points (the pitfalls that bite people):**

- **Process cleanup on disconnect:** `request.signal.addEventListener('abort', …)` plus `cancel()` in the stream. Without both, a browser refresh leaves a zombie `journalctl -f` running forever. Test this with `ps aux | grep journalctl` after closing the browser tab.
- **`--output=cat`:** strips journald's `<timestamp> <host> <unit>:` prefix so the UI shows clean log lines. If the operator wants timestamps, format them client-side from the SSE event time.
- **`--lines=100`:** shows the tail of the last run immediately on connect, so opening the page mid-update still works.
- **Backpressure:** `ReadableStream` + Node streams handle this natively; `journalctl` respects SIGPIPE. We don't need a third-party stream library.
- **`runtime = 'nodejs'`:** `spawn` is not available on the Edge runtime. Must be declared explicitly.
- **`dynamic = 'force-dynamic'`:** prevents Next.js from trying to static-optimize the route.
- **`X-Accel-Buffering: no`:** defensive header for any reverse proxy (nginx, Caddy) in front of the LXC. Not needed today (the app is reached directly on `:3000`) but free insurance.

**Why not a library?** `tail-file`, `tail-stream`, `journalctl-parser` all exist. None is necessary: we tail a journald unit (not a file), and we don't parse — we relay raw lines. A library would be dead weight.

### 7. What NOT to add — explicit "do not use" list

| Package | Why it's tempting | Why it's wrong for this project |
|---|---|---|
| **`electron-updater`** | Famous "in-app updater" name | It's Electron-only (Squirrel, delta updates, code signing). We're a long-running Next.js server, not a desktop app. Completely irrelevant. |
| **`update-notifier`** | Sounds like exactly our feature | Built for CLI tools to nag users to `npm install -g foo@latest` on startup. No pipeline, no rollback, no git, no systemd integration. |
| **`pm2`** | "Zero-downtime reloads and auto-restart" | We already have systemd doing exactly that. PM2 layered on systemd is two process supervisors fighting each other. The milestone explicitly uses `systemctl restart`. |
| **`pm2-runtime`** | Variant of the above for containers | Same reason. |
| **`forever`** | Alternative to PM2 | Unmaintained (last release 2020). Same layering problem. |
| **`@octokit/rest` / `@octokit/request`** | "Official" GitHub client | 300+ kB for one unauthenticated GET. Native `fetch` does the job in 20 lines. |
| **`simple-git`** | Clean Promise API over git | Wraps the same binary we'd spawn directly; hides stdout/stderr we need for the SSE log; five transitive deps for zero capability gain. |
| **`isomorphic-git`** | Pure-JS git, no binary needed | We already have the git binary on the LXC. Pure-JS git introduces pack-file edge cases and performance cliffs we don't want during a broken-deploy panic. |
| **`nodegit`** | Native libgit2 bindings | Heavy native build step, frequently breaks on Node major upgrades, no advantage over shelling out. |
| **`node-cron` / `cron` / `croner`** | "Industry standard" scheduler | Overkill for a single fixed 6-hour interval. `setInterval` is clearer and dependency-free. |
| **`agenda`, `bree`, `bull`** | Job queue libraries | Require Redis/Mongo or a worker thread model. We have one scheduled task. Wrong scale. |
| **`systemctl`** (the npm package) | Named like what we want | Tiny unmaintained wrapper around `child_process.exec('systemctl …')`. Adds nothing. |
| **`node-systemd` / `sd-daemon`** | systemd integration | For writing services that notify systemd about readiness (`sd_notify`). Unrelated to triggering other units. |
| **`tail-stream`, `tail-file`, `read-last-lines`** | Log tailing | We tail a journald unit, not a file. `journalctl -f` is the right tool. |
| **`execa`** (9.6.1) | Nicer `child_process` ergonomics | We spawn exactly three commands (`systemctl`, `journalctl`, optionally `git`) in well-known shapes. Native `node:child_process` is fine and one less supply-chain dep. |
| **`dotenv`** | Common env-loading helper | Next.js already loads `.env*` files natively. Adding dotenv creates dual-loading bugs. |
| **`next-runtime-env`** | "Runtime" env vars for Next.js | Only needed when you can't rebuild between env changes. Our updater always rebuilds, so build-time `env` injection (section 4) is strictly better. |

## Installation

The answer for this milestone is refreshingly boring:

```bash
# Nothing to install for v1.2.
# All required tools are either (a) already in package.json or
# (b) part of the Debian base system (git, systemctl, journalctl).
```

Systemd unit to create (configuration, not code — included here because it's part of "stack"):

```ini
# /etc/systemd/system/charging-master-updater.service
[Unit]
Description=Charging-Master self-update pipeline
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=/opt/charging-master
ExecStart=/opt/charging-master/scripts/update/run-update.sh
StandardOutput=journal
StandardError=journal
# Inherit environment (PATH etc.) from the system; do not set User=
# because the app and updater both run as root in this LXC.

[Install]
# Intentionally no [Install] section — this unit is never enabled,
# it is only triggered on demand by `systemctl start`.
```

## Integration Points with the Existing Stack

| Touch point | Existing file / module | What the self-update feature adds |
|---|---|---|
| `next.config.ts` | already present, 8 lines | +15 lines for `env` block reading git SHA + build time |
| `instrumentation.ts` | does not exist yet | new file, ~10 lines, boots the 6 h scheduler |
| `src/db/schema.ts` (Drizzle) | existing SQLite schema | + `update_state` table (singleton row) and `update_log` table (append-only) |
| `src/modules/update/` | does not exist | new module: `github-client.ts`, `scheduler.ts`, `systemctl.ts`, `state.ts` |
| `src/app/api/version/route.ts` | does not exist | reads `process.env.NEXT_PUBLIC_COMMIT_SHA` + build time; used by the post-restart browser poll |
| `src/app/api/update/check/route.ts` | does not exist | force-runs a GitHub check on demand (UI "check now" button) |
| `src/app/api/update/trigger/route.ts` | does not exist | spawns `systemctl start --no-block charging-master-updater.service` |
| `src/app/api/update/log/route.ts` | does not exist | SSE stream of `journalctl -fu charging-master-updater` |
| `src/app/(settings)/update/page.tsx` | does not exist | UI: current version, last check, update-available badge, update button, live log viewer |
| `scripts/update/run-update.sh` | does not exist | the bash pipeline (git fetch/reset/install/build/restart) with rollback trap |

## Flags for the Downstream Roadmap

1. **`next.config.ts` git call must be fault-tolerant** — the `execSync('git rev-parse HEAD')` call runs during `next build`. If the updater is invoked in a detached worktree or mid-rebase, we want `'unknown'` instead of a build failure. The code above handles this with a try/catch.
2. **The `--no-block` flag in `systemctl start` is load-bearing.** Omit it and the API route hangs, the HTTP client times out, and the UI thinks the update failed even though it succeeded. Add a test that asserts the spawn args include `--no-block`.
3. **Rebuild is mandatory because `NEXT_PUBLIC_*` is build-time.** The updater must run `pnpm build` — skipping the build step would leave the UI reporting the old SHA even though `git reset` already moved HEAD. The pipeline must fail loudly if `pnpm build` is skipped.
4. **Process cleanup on SSE disconnect is the #1 log-tailing foot-gun.** The implementation must handle `request.signal.abort` AND the `ReadableStream` `cancel()` callback, and must `proc.kill('SIGTERM')` in both. Add a smoke test that opens and closes an SSE connection 10 times and then counts `journalctl` processes.
5. **Rollback must include rebuild.** Resetting the git SHA back is necessary but not sufficient — the previous `.next/` build artefacts from before the update have been overwritten by the failed `pnpm build`. The rollback trap in `run-update.sh` must re-run `pnpm install && pnpm build` against the old SHA before `systemctl restart`.
6. **ETag persistence lives in SQLite, not memory.** The app restarts during every update, so in-memory ETag caches are useless. Store the ETag in `update_state` next to `last_known_remote_sha`.
7. **GitHub call always sets `User-Agent` and `X-GitHub-Api-Version`.** Missing `User-Agent` gives a 403; missing API version means GitHub can silently change the response shape.

## Sources

- [GitHub REST rate limits docs](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api) — confirms unauthenticated 60 req/h and that `304 Not Modified` does not consume budget
- [Next.js environment variables guide](https://nextjs.org/docs/pages/guides/environment-variables) — canonical `NEXT_PUBLIC_*` inlining at build time
- [vercel/next.js discussion #15849 — "Where to get my github commit SHA for sentry setup"](https://github.com/vercel/next.js/discussions/15849) — authoritative pattern for reading `git rev-parse HEAD` in `next.config.ts`
- [vercel/next.js discussion #50181 — access build timestamps and git hash](https://github.com/vercel/next.js/discussions/50181) — same pattern, different motivation
- [mqtt.js / Shelly unchanged — see existing STACK decisions in CLAUDE.md]
- [npm: simple-git 3.35.2](https://www.npmjs.com/package/simple-git) — verified version and dep tree via `npm view simple-git` on 2026-04-10
- [npm: @octokit/rest 22.0.1](https://www.npmjs.com/package/@octokit/rest) — verified version on 2026-04-10
- [npm: isomorphic-git 1.37.5](https://www.npmjs.com/package/isomorphic-git) — verified version on 2026-04-10
- [npm: croner 9.6.1](https://www.npmjs.com/package/croner) — verified version on 2026-04-10
- [npm: node-cron 4.2.1](https://www.npmjs.com/package/node-cron) — verified version on 2026-04-10
- [ArchWiki: Polkit](https://wiki.archlinux.org/title/Polkit) — reference for the (currently unneeded) non-root systemd trigger pattern
- [systemd.exec / systemctl(1) man pages] — `--no-block` semantics for `systemctl start`
