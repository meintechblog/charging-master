# Architecture Research — Self-Update (v1.2)

**Domain:** In-app self-update for a systemd-managed Next.js 15 + custom-server Node app on Debian LXC
**Researched:** 2026-04-10
**Confidence:** HIGH (existing architecture verified from source; external decisions already locked by milestone brief)

---

## Context Anchors (what we already have)

Before proposing new structure, the following existing facts drive every decision below. I verified them in source:

- **Custom HTTP server entry point:** `server.ts` at repo root, launched by systemd via `ExecStart=/usr/bin/npx tsx server.ts`. This is *not* a standalone Next.js app — `next()` is used in programmatic mode (`app.prepare()` + `createServer`). That means we have a **real, long-lived Node process** owned by us, not serverless route handlers. Every singleton we need (EventBus, HttpPollingService, ChargeMonitor, NotificationService, SessionRecorder) is instantiated *once* in `main()` and then exposed via `globalThis.__eventBus`, `globalThis.__httpPollingService`, etc.
- **Existing SSE pattern:** `src/app/api/sse/power/route.ts` uses `runtime = 'nodejs'`, `dynamic = 'force-dynamic'`, a `ReadableStream`, and subscribes to the `EventBus` via `globalThis.__eventBus`. Cleans up on `request.signal.abort`.
- **Settings storage:** already persisted as key/value in the `config` table via `src/app/api/settings/route.ts`. Reusable for storing "last update check" metadata, but **not** for rollback state (see §6).
- **systemd unit:** single `charging-master.service` defined in `install.sh`, `WorkingDirectory=/opt/charging-master`, runs as **root** (the install script requires root, there is no `User=` directive, so it inherits root from systemd). This is the decisive fact that makes polkit unnecessary.
- **Install directory:** `/opt/charging-master` is a git clone — the updater can operate on it directly with `git fetch`/`git reset --hard`.
- **No separate build artifact dir to worry about:** `next build` writes to `.next/` inside the clone. The build step will need to survive the running process holding file handles (mitigated by the fact that build runs in a separate one-shot process, then restart).

These anchors mean the new feature can follow a very natural path: **extend `main()` in `server.ts` to boot an `UpdateChecker` singleton, add an `src/modules/self-update/` domain, add API routes, add one systemd one-shot unit, done.** No polkit, no separate update daemon, no RPC boundary tricks.

Important correction to the brief: the brief says "HttpPollingService appears to use a route-handler boot hook" — **it does not.** I verified: `HttpPollingService` is instantiated from `server.ts` line 20, started from line 40. The boot pattern is "long-lived Node process with services wired in `main()`", not a route-handler side effect. This is better news for us — we have a clean hook point.

---

## System Overview

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          Browser (Settings / Update UI)                  │
│   ┌──────────────┐  ┌────────────────┐  ┌────────────────────────────┐  │
│   │ VersionBadge │  │ UpdateButton   │  │ LiveLogPanel (EventSource) │  │
│   └──────┬───────┘  └───────┬────────┘  └──────────────┬─────────────┘  │
└──────────┼──────────────────┼──────────────────────────┼────────────────┘
           │ GET /api/version │ POST /api/update/start   │ GET /api/update/log (SSE)
           ▼                  ▼                          ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                    Next.js Route Handlers (thin)                         │
│   ┌────────────────┐ ┌─────────────────┐ ┌────────────────────────────┐ │
│   │  /api/version  │ │ /api/update/*   │ │ /api/update/log (SSE)      │ │
│   └────────┬───────┘ └────────┬────────┘ └────────────┬───────────────┘ │
└────────────┼──────────────────┼───────────────────────┼─────────────────┘
             │                  │                       │ spawn journalctl -fu
             ▼                  ▼                       ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                 src/modules/self-update  (domain singleton)              │
│   ┌─────────────────┐  ┌──────────────────┐  ┌──────────────────────┐   │
│   │ UpdateChecker   │  │ UpdateTrigger    │  │ JournalTailer        │   │
│   │ (6h interval)   │  │ (systemctl)      │  │ (per-stream child)   │   │
│   └────────┬────────┘  └────────┬─────────┘  └──────────────────────┘   │
│            │                    │                                       │
│            ▼                    ▼                                       │
│   ┌────────────────────────────────────────────────────────────────┐    │
│   │  UpdateStateStore   (reads src/lib/version.ts baked constants, │    │
│   │  writes /opt/charging-master/.update-state/state.json)         │    │
│   └────────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────────┘
                                  │
                 ┌────────────────┼────────────────┐
                 ▼                ▼                ▼
        ┌──────────────┐ ┌──────────────┐ ┌──────────────────┐
        │ GitHub API   │ │ systemctl    │ │ .update-state/   │
        │ (commits)    │ │ start        │ │ state.json       │
        └──────────────┘ │ updater.svc  │ └──────────────────┘
                         └──────┬───────┘
                                ▼
┌──────────────────────────────────────────────────────────────────────────┐
│           charging-master-updater.service  (systemd Type=oneshot)        │
│                                                                          │
│  scripts/update/run-update.sh                                            │
│    1. read .update-state/state.json → PRIOR_SHA                          │
│    2. git stash push -u  (best-effort)                                   │
│    3. git fetch origin main                                              │
│    4. git reset --hard origin/main  (→ record NEW_SHA)                   │
│    5. pnpm install --frozen-lockfile  (fallback: pnpm install)           │
│    6. pnpm build                                                         │
│    7. write state.json { status: ready-to-restart, priorSha: PRIOR_SHA,  │
│                          newSha: NEW_SHA, finishedAt: ... }              │
│    8. systemctl restart charging-master  ← app process dies here         │
│                                                                          │
│  on ANY step failure:                                                    │
│    - git reset --hard PRIOR_SHA                                          │
│    - pnpm install && pnpm build   (rollback build)                       │
│    - write state.json { status: rolled-back, error: ... }                │
│    - exit 1  (systemd marks unit failed)                                 │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## Q1 — Module Placement

### Where the new domain lives

```
src/
├── lib/
│   └── version.ts                 # NEW — baked build constants consumed by server+client
├── modules/
│   └── self-update/               # NEW — domain
│       ├── update-checker.ts      # Long-lived 6h poller (boot-time singleton)
│       ├── github-client.ts       # Tiny fetch wrapper for /repos/.../commits/main
│       ├── update-trigger.ts      # Spawns `systemctl start charging-master-updater.service`
│       ├── update-state-store.ts  # Read/write .update-state/state.json
│       ├── journal-tailer.ts      # Spawns `journalctl -fu ...` per SSE subscriber
│       ├── types.ts               # UpdateState, CommitInfo, UpdateEvent, etc.
│       └── __tests__/
│           ├── github-client.test.ts
│           ├── update-state-store.test.ts
│           └── update-checker.test.ts
└── app/
    └── api/
        ├── version/
        │   └── route.ts           # GET current + latest + state
        └── update/
            ├── start/route.ts     # POST — triggers systemctl start
            ├── status/route.ts    # GET — reads UpdateStateStore
            └── log/route.ts       # GET — SSE, tails journalctl
```

### File-by-file responsibilities

| File | Type | Responsibility | Depends on |
|------|------|----------------|------------|
| `src/lib/version.ts` | module (server+client safe) | Exports `CURRENT_SHA`, `CURRENT_SHA_SHORT`, `BUILD_TIME_ISO`, `REPO_URL`, `BRANCH`. **Compile-time constants** injected at build (see §3). Pure module — no runtime deps. | nothing |
| `src/modules/self-update/types.ts` | types | `UpdateState`, `UpdateStatus` (`idle`\|`checking`\|`update-available`\|`updating`\|`ready-to-restart`\|`rolled-back`\|`error`), `CommitInfo`, `PersistedState`. | nothing |
| `src/modules/self-update/github-client.ts` | function module | `fetchLatestCommit(owner, repo, branch): Promise<CommitInfo>` — plain `fetch()` against `https://api.github.com/repos/.../commits/main`. Handles 304 (ETag), 403 (rate limit). Returns `{ sha, message, author, committedAt }`. No GitHub token (public repo, 60 req/h is plenty for one check every 6h). | `server-only` |
| `src/modules/self-update/update-state-store.ts` | class | Owns `/opt/charging-master/.update-state/state.json`. API: `read(): PersistedState \| null`, `write(patch)`, `markChecking()`, `markUpdating()`, `markReadyToRestart(newSha)`, `markRolledBack(err)`. Atomic writes via tmp-file + rename. Called by Node app **and** by the updater shell script (keep schema stable). | `fs`, `path`, `server-only` |
| `src/modules/self-update/update-checker.ts` | class | **Long-lived singleton.** Constructor takes `EventBus`, `GitHubClient`, `UpdateStateStore`. `start()` kicks an immediate check then `setInterval(() => this.check(), 6 * 60 * 60 * 1000)`. `check()` calls GitHub, compares SHA to `CURRENT_SHA` from `src/lib/version.ts`, persists result, emits `update:check` on EventBus. `stop()` clears interval. | EventBus, state-store, github-client, version |
| `src/modules/self-update/update-trigger.ts` | function module | `triggerUpdate(): Promise<{ ok: boolean; error?: string }>`. Uses `child_process.spawn('systemctl', ['start', 'charging-master-updater.service'], { detached: true, stdio: 'ignore' })` and `.unref()`s the child so **the parent Node process does not keep a handle on the systemctl call** (critical for Q5). Returns as soon as systemctl accepts the start request. Writes `status: 'updating'` via state store *before* spawning. | `child_process`, state-store |
| `src/modules/self-update/journal-tailer.ts` | class | Per-SSE-subscriber ephemeral helper. `tail(onLine, onClose): () => void` — spawns `journalctl -fu charging-master-updater.service -n 500 --output=cat`, streams stdout lines via callback, returns a kill function. **Explicitly bypasses EventBus** (see §7). | `child_process` |
| `src/app/api/version/route.ts` | Next.js GET handler | Returns `{ current: { sha, shortSha, buildTime }, latest: state.latestCommit ?? null, status: state.status, lastCheckedAt }`. **Poll target used by the browser to detect reboot** (§5). Must be fast, no external calls. | `src/lib/version.ts`, state store |
| `src/app/api/update/start/route.ts` | POST handler | Validates no update in progress, calls `triggerUpdate()`, returns `{ ok: true }`. | update-trigger |
| `src/app/api/update/status/route.ts` | GET handler | Returns full state.json. Used when browser reconnects after restart. | state store |
| `src/app/api/update/log/route.ts` | SSE GET handler | Creates `ReadableStream`, instantiates `JournalTailer`, pipes lines as `data:` events. Cleans up on `request.signal.abort`. | journal-tailer |

### What goes in `src/lib/` vs `src/modules/`

| Lives in `src/lib/` | Lives in `src/modules/self-update/` |
|---------------------|-------------------------------------|
| `version.ts` — pure constants, safe to import from both server and client components (Next.js client bundler can read it) | Everything stateful or I/O-bound: the poller, the state store, the trigger, the tailer |
| No self-update business logic. | All business logic. |

**Rationale (matches existing convention):** `src/lib/` currently holds `env.ts`, `format.ts`, `utils.ts` — all pure/near-pure. `src/modules/` holds things with lifecycle: `shelly/http-polling-service.ts`, `charging/charge-monitor.ts`, `notifications/notification-service.ts`. The new domain matches `notifications` and `shelly` in shape.

---

## Q2 — Background Poller Lifetime

### The critical fact

`server.ts` **is** the long-lived process. It already boots `HttpPollingService`, `ChargeMonitor`, `NotificationService`, `SessionRecorder` as singletons in `main()`. So: **boot `UpdateChecker` from `server.ts`, same as every other long-lived service.** No route-handler side effect, no separate entry point, no timer unit.

### Modification to `server.ts`

Add right after `sessionRecorder.start()`, before `globalThis` exposure:

```typescript
// Initialize self-update checker
import { UpdateChecker } from './src/modules/self-update/update-checker';
import { UpdateStateStore } from './src/modules/self-update/update-state-store';
import { GitHubClient } from './src/modules/self-update/github-client';

const updateStateStore = new UpdateStateStore('/opt/charging-master/.update-state');
const githubClient = new GitHubClient();
const updateChecker = new UpdateChecker(eventBus, githubClient, updateStateStore);
updateChecker.start(); // immediate check + 6h interval

// Expose for route handlers
globalThis.__updateStateStore = updateStateStore;
globalThis.__updateChecker = updateChecker;
```

And in `shutdown`: `updateChecker.stop();` — *before* `server.close()`. This way SIGTERM from `systemctl restart` cleanly clears the interval.

### Tradeoffs considered

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| **Boot from `server.ts` (chosen)** | Matches existing pattern perfectly. Single source of truth for app lifecycle. Interval guaranteed to run exactly once. Easy shutdown hook. Dev mode (`tsx watch server.ts`) and prod identical. | None that matter. | ✅ |
| Route-handler side effect | Would work if we *didn't* have a custom server. | Race on first request. Not idempotent without guards. Dev mode HMR can double-boot. Inconsistent with `HttpPollingService`. | ❌ |
| Separate `update-daemon.ts` entry point as its own systemd unit | Total isolation — poller survives main app restart cycles. | Two processes to manage. Shared SQLite → potential writer contention. Duplicate logging. Poller doesn't need to survive restarts — missing one 6h cycle during an update is fine. | ❌ |
| `systemd.timer` unit that runs a check script every 6h | "systemd-native". Survives app crashes. | We don't have a daemon to call; would duplicate GitHub-diffing logic outside TS. Can't push `update:check` into EventBus without HTTP call. Fighting the architecture. | ❌ |

### Dev mode note

`pnpm dev` = `tsx watch server.ts`. On file change, tsx re-executes `main()`, which would create a *new* interval. That would leak intervals in dev. Mitigation: `UpdateChecker.start()` is idempotent (guards with `if (this.interval) return;`), and `tsx watch` sends SIGTERM first so `shutdown()` fires and clears it. Already handled by the same SIGTERM path that HttpPollingService relies on.

---

## Q3 — Version Baking at Build Time

### Design principle

The running process must know the git SHA it was built from, **and that SHA must survive through `next build` and `tsx server.ts`**. Three things to handle:

1. **Server-side code** (`server.ts`, route handlers) — runs via `tsx`, sees process.env and can read files at runtime.
2. **Client bundle** (Settings page in the browser) — must be able to render `VersionBadge`, so the SHA must be inlined into the bundle at build time.
3. **Single source of truth** — don't have different paths for server and client reading different numbers.

### Solution: generated `src/lib/version.ts` written by a prebuild script

**Why this shape (and not, say, `NEXT_PUBLIC_*` env vars):**

- `NEXT_PUBLIC_*` *would* work for the client side, but then server code reads env and client code reads a constant — two paths, easy to drift.
- A generated `.ts` file is a constant that both server and client import from `@/lib/version`. Next.js inlines constants from imported modules into the client bundle automatically. One source of truth, two consumers, zero drift.
- Survives `next build` because the file exists on disk, is compiled in, and is bundled into `.next/`. The file is git-ignored — regenerated on every build.

### File plan

**NEW: `scripts/build/generate-version.mjs`**

```javascript
// Runs before `next build` (and before `tsx server.ts` in dev).
// Writes src/lib/version.ts with baked constants from git.
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

let sha;
try { sha = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim(); }
catch { sha = process.env.GIT_SHA ?? 'unknown'; }

const shortSha = sha.slice(0, 7);
const buildTime = new Date().toISOString();

let branch;
try { branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim(); }
catch { branch = 'unknown'; }

const out = resolve('src/lib/version.ts');
mkdirSync(dirname(out), { recursive: true });

writeFileSync(out, `// AUTO-GENERATED by scripts/build/generate-version.mjs — do not edit.
// Regenerated on every build. Git-ignored.

export const CURRENT_SHA = ${JSON.stringify(sha)};
export const CURRENT_SHA_SHORT = ${JSON.stringify(shortSha)};
export const BUILD_TIME_ISO = ${JSON.stringify(buildTime)};
export const BRANCH = ${JSON.stringify(branch)};
export const REPO_URL = "https://github.com/meintechblog/charging-master";
`);

console.log(`[version] baked ${shortSha} @ ${buildTime}`);
```

**MODIFY: `package.json` scripts**

```json
{
  "scripts": {
    "gen:version": "node scripts/build/generate-version.mjs",
    "dev": "pnpm gen:version && tsx watch server.ts",
    "build": "pnpm gen:version && next build",
    "start": "NODE_ENV=production tsx server.ts"
  }
}
```

Note: `start` does **not** regenerate. The file that `build` created is what gets baked into the already-compiled `.next/` bundle. This is correct: start-time SHA ≠ build-time SHA would be a bug.

**MODIFY: `.gitignore`** — add `src/lib/version.ts`.

**MODIFY: `install.sh`** — already runs `pnpm build` after `git clone` and after `git reset --hard` in the update path. No change needed beyond committing the new script.

### Consumption

**Server-side consumer — `src/app/api/version/route.ts`:**

```typescript
import { CURRENT_SHA, CURRENT_SHA_SHORT, BUILD_TIME_ISO } from '@/lib/version';

export async function GET() {
  const state = globalThis.__updateStateStore?.read();
  return Response.json({
    current: { sha: CURRENT_SHA, shortSha: CURRENT_SHA_SHORT, buildTime: BUILD_TIME_ISO },
    latest: state?.latestCommit ?? null,
    status: state?.status ?? 'idle',
    lastCheckedAt: state?.lastCheckedAt ?? null,
  });
}
```

**Client-side consumer — `VersionBadge.tsx` (client component):**

```typescript
'use client';
import { CURRENT_SHA_SHORT, BUILD_TIME_ISO } from '@/lib/version';

export function VersionBadge() {
  return <div>{CURRENT_SHA_SHORT} · {new Date(BUILD_TIME_ISO).toLocaleString()}</div>;
}
```

Because `src/lib/version.ts` contains only literal exports, Next.js tree-shakes and inlines them into the client bundle at `next build` time. The client bundle becomes immutable until the next `next build`. This is exactly the guarantee we want.

### First-install edge case

During the very first install via `install.sh`, the repo is cloned *before* `pnpm build`, so `git rev-parse HEAD` is valid at build time. The `try/catch` fallback to `'unknown'` is only a safety net for weirder scenarios (e.g., building from a tarball). Document that `'unknown'` as a current SHA disables update detection (every GitHub SHA will look like a new version) — that's a loud enough failure.

---

## Q4 — Systemd Units

### Units required

| Unit | Type | Purpose | Needed for v1.2? |
|------|------|---------|------------------|
| `charging-master.service` | `simple` (existing) | Main app process, runs `tsx server.ts`. Already exists. | Modified — see below. |
| `charging-master-updater.service` | **`oneshot`** | Runs the update pipeline, triggered on-demand. | **Yes — NEW.** |
| `charging-master-updater.timer` | `timer` | Scheduled periodic updates. | **No.** The 6h check is a poll, not an auto-update. User clicks a button; we don't auto-apply. |
| `charging-master-updater.path` | `path` | Watch a file → trigger unit. | **No.** We trigger via `systemctl start` directly from Node; no need for a filesystem trigger indirection. |

### The updater unit (NEW)

**File: `/etc/systemd/system/charging-master-updater.service`** (written by `install.sh`)

```ini
[Unit]
Description=Charging-Master Self-Updater (one-shot)
# Intentionally no After= or Requires= on charging-master.service —
# the updater MUST be able to run even if the main service is in a
# crashed state (rollback scenario).

[Service]
Type=oneshot
WorkingDirectory=/opt/charging-master
ExecStart=/opt/charging-master/scripts/update/run-update.sh
# Give pnpm build plenty of headroom — on a small LXC this can be 3-5 min
TimeoutStartSec=900
# Standard output → journal, picked up by journalctl -fu for the log SSE
StandardOutput=journal
StandardError=journal
# Env for git/pnpm
Environment=HOME=/root
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# No User=, no Group= — runs as root, same as the main service
# No RemainAfterExit — we want the unit to be in "inactive" state once done,
#   so the next trigger is clean.

[Install]
# Intentionally no [Install] section — this unit is started on-demand,
# never enabled. systemctl start is the only trigger.
```

**File: `scripts/update/run-update.sh`** (NEW, committed to repo, executable)

This is the actual pipeline. Lives in the repo (not written by `install.sh`) so it gets updated *with* the app.

```bash
#!/usr/bin/env bash
set -euo pipefail

STATE_DIR="/opt/charging-master/.update-state"
STATE_FILE="$STATE_DIR/state.json"
mkdir -p "$STATE_DIR"

cd /opt/charging-master

PRIOR_SHA="$(git rev-parse HEAD)"

write_state() {  # usage: write_state STATUS [KEY=VAL ...]
  local status="$1"; shift
  # naive JSON write — good enough, single-writer
  {
    printf '{"status":"%s","priorSha":"%s","updatedAt":"%s"' \
      "$status" "$PRIOR_SHA" "$(date -u +%FT%TZ)"
    for kv in "$@"; do
      printf ',"%s":"%s"' "${kv%%=*}" "${kv#*=}"
    done
    printf '}\n'
  } > "$STATE_FILE.tmp"
  mv "$STATE_FILE.tmp" "$STATE_FILE"
}

rollback() {
  local reason="$1"
  echo "[updater] ROLLBACK: $reason" >&2
  git reset --hard "$PRIOR_SHA" || true
  pnpm install --frozen-lockfile || pnpm install || true
  pnpm build || true
  write_state "rolled-back" "error=$reason"
  exit 1
}

trap 'rollback "unexpected-error-line-$LINENO"' ERR

write_state "updating" "step=fetching"
git stash push -u -m "pre-update-$(date +%s)" || true
git fetch origin main
write_state "updating" "step=resetting"
git reset --hard origin/main
NEW_SHA="$(git rev-parse HEAD)"

write_state "updating" "step=installing" "newSha=$NEW_SHA"
pnpm install --frozen-lockfile || pnpm install

write_state "updating" "step=building" "newSha=$NEW_SHA"
pnpm build

write_state "ready-to-restart" "newSha=$NEW_SHA"
echo "[updater] Build complete, restarting charging-master.service"

# Fire and don't wait — systemd handles the actual restart.
systemctl restart charging-master.service
```

### The permission question

**Option A (chosen): run the main app as root.**
Pros: no polkit, no sudoers, no `NOPASSWD`. `systemctl start charging-master-updater` just works. Matches current reality — the existing service has no `User=` and is installed as root via `install.sh`. File ownership of `/opt/charging-master` is already root.
Cons: main app process has full root. In a **single-user local-network LXC with no authentication** this is already the operating assumption. The app is behind a trusted LAN boundary.

**Option B (rejected): run app as dedicated user + polkit rule.**
Would require `/etc/polkit-1/rules.d/50-charging-master.rules` granting `org.freedesktop.systemd1.manage-units` scoped to `charging-master-updater.service` for a `charging-master` user. More moving parts, more files to install, more debugging surface, no security gain in this environment (LAN-only, no auth anywhere).

**Verdict: Option A.** Document in CLAUDE.md that the app runs as root and this is intentional for update privileges. Flag it as a risk if the user ever decides to expose the app beyond LAN.

### Modification to `charging-master.service`

Current unit already has `KillMode=control-group` and `TimeoutStopSec=5` — both exactly what we need. No structural change required. Just ensure `Restart=on-failure` and `RestartSec=5` remain (already present) so a successful `systemctl restart` from the updater actually restarts, and a failed boot retries a few times before giving up.

---

## Q5 — The Restart Problem (the hard one)

### Problem statement

The Node process that receives `POST /api/update/start` is the same process that will be killed when the updater does `systemctl restart charging-master.service`. We need:

- **(a)** The browser to see live log output from the moment the user clicks "Update" until the restart actually happens.
- **(b)** The browser to know when the new version has booted so it can auto-reload.
- **(c)** The `systemctl restart` command itself to not be killed mid-flight when its parent (the Node app) dies.

### The key insight — decoupling via systemd

`systemctl start charging-master-updater.service` returns **as soon as systemd accepts the request**. The updater unit runs in a systemd-owned cgroup, completely independent of the Node app's cgroup. When the Node app dies (step 8 of the updater), the updater's own cgroup is untouched. The updater is a child of PID 1, not of Node.

Concretely: `child_process.spawn('systemctl', ['start', 'charging-master-updater.service'], { detached: true, stdio: 'ignore' }).unref()` — after `unref()`, the Node event loop doesn't block on the child; and because systemd takes over the actual unit execution, even if the spawn handle is GC'd or the Node process dies, the updater unit keeps running. **This solves (c) automatically.**

### The sequence

```
Browser                 Node app              systemd             Updater unit            journald
  │                        │                     │                      │                     │
  │ 1. POST /api/update/start                    │                      │                     │
  ├───────────────────────▶│                     │                      │                     │
  │                        │ 2. write state.json │                      │                     │
  │                        │    status=updating  │                      │                     │
  │                        │                     │                      │                     │
  │                        │ 3. spawn systemctl start (detached, unref) │                     │
  │                        ├────────────────────▶│                      │                     │
  │                        │                     │ 4. fork updater unit │                     │
  │                        │                     ├─────────────────────▶│                     │
  │                        │                     │                      │                     │
  │ 5. 200 OK {ok:true}    │                     │                      │                     │
  │◀───────────────────────┤                     │                      │                     │
  │                        │                     │                      │                     │
  │ 6. GET /api/update/log (SSE)                 │                      │                     │
  ├───────────────────────▶│                     │                      │                     │
  │                        │ 7. spawn            │                      │                     │
  │                        │    journalctl -fu charging-master-updater  │                     │
  │                        │◀────────────────────┼──────────────────────┼─────────────────────┤
  │                        │                     │                      │ 8. git fetch/reset  │
  │                        │                     │                      ├────────────────────▶│
  │                        │                     │                      │    (logs to journal)│
  │ 9. event:log data:...  │◀── journalctl stdout (streamed line by line)                     │
  │◀───────────────────────┤                     │                      │                     │
  │                        │                     │                      │ 10. pnpm install    │
  │                        │                     │                      │                     │
  │ 11. event:log ...      │                     │                      │                     │
  │◀───────────────────────┤                     │                      │ 12. pnpm build      │
  │                        │                     │                      │                     │
  │                        │                     │                      │ 13. write state.json│
  │                        │                     │                      │     ready-to-restart│
  │                        │                     │                      │                     │
  │                        │                     │                      │ 14. systemctl       │
  │                        │                     │                      │     restart main    │
  │                        │                     │◀─────────────────────┤                     │
  │                        │                     │                      │                     │
  │                        │◀ 15. SIGTERM ───────┤                      │                     │
  │                        │                     │                      │                     │
  │                        │ 16. shutdown() runs │                      │                     │
  │                        │    - clear poller   │                      │                     │
  │                        │    - kill journalctl child                 │                     │
  │                        │    - server.close() │                      │                     │
  │ 17. SSE connection dropped                   │                      │                     │
  │◀╳╳╳╳╳╳╳╳╳╳╳╳╳╳╳╳╳╳╳╳╳╳╳┤                     │                      │                     │
  │                        │    (process exits)  │                      │                     │
  │                        │                     │ 18. fork new Node    │                     │
  │                        │                     │    process           │                     │
  │                        │                     │──────────────────────┼────┐                │
  │                        │                     │                      │    │                │
  │                        │                  (new Node app)            │    │                │
  │                        │◀─────────────────────┼──────────────────────┼────┘                │
  │                        │ 19. main() runs     │                      │                     │
  │                        │    reads version.ts │                      │                     │
  │                        │    with NEW_SHA     │                      │                     │
  │                        │    boots services   │                      │                     │
  │                        │    server.listen()  │                      │                     │
  │                        │                     │                      │                     │
  │ 20. GET /api/version (retried every 2s by UI)│                      │                     │
  ├───────────────────────▶│                     │                      │                     │
  │ 21. {sha: NEW_SHA}     │                     │                      │                     │
  │◀───────────────────────┤                     │                      │                     │
  │                        │                     │                      │                     │
  │ 22. UI notices sha changed → window.location.reload()               │                     │
  │                        │                     │                      │                     │
```

### How each requirement is satisfied

- **(a) Streaming progress until restart:** Steps 6–16. The SSE route spawns its own `journalctl -fu charging-master-updater` child, which reads the systemd journal in real time. Every line the updater prints lands in the journal (stdout was routed to journal via the service unit's `StandardOutput=journal`), journalctl streams it, the SSE route pipes it to the browser. This continues right up until step 15 when SIGTERM arrives.

- **(b) Detecting the new version has booted:** Steps 20–22. The browser, upon noticing the SSE connection drop (step 17), starts polling `GET /api/version` every 2s. As soon as that endpoint responds with a SHA *different* from the one the UI was rendered with, the UI triggers `window.location.reload()`. Works because:
  - Before restart: `/api/version` returns old SHA.
  - During restart: `/api/version` is unreachable → browser keeps polling.
  - After restart: `/api/version` returns NEW_SHA → UI reloads → new bundle served with new baked version.
  - Important: the UI must remember the *initial* SHA it loaded with (from the baked `src/lib/version.ts` it shipped with), not the one it read via the API during the session. Otherwise, an "update_available" state change would cause a false reload.

- **(c) Restart survives its own parent dying:** Guaranteed by the `oneshot` + `detached` + `unref()` + systemd-owned cgroup chain described above. The updater is a child of systemd (PID 1), not of Node. When Node dies, the updater is oblivious.

### Failure during restart (edge case, unhandled in v1.2)

If `systemctl restart charging-master.service` fails because NEW_SHA's code has a startup bug:
1. systemd marks `charging-master.service` as failed.
2. `Restart=on-failure` + `RestartSec=5` → systemd retries a few times.
3. If retries exhaust, the service stays failed. Browser polling `/api/version` times out forever.
4. User must ssh in and fix manually.

**This is an accepted limitation for v1.2.** A future phase could add a watchdog unit that, if `charging-master.service` fails within N seconds of an update, auto-triggers a rollback via another one-shot unit. Out of scope for v1.2 — flag in roadmap.

---

## Q6 — Rollback State Persistence

### Requirements

- Must be readable by the Node app (TypeScript) **and** the updater shell script.
- Must survive the Node app being killed.
- Must survive the updater crashing halfway.
- Must be deterministically located so both sides agree.

### Non-starters

- **systemd `Environment=`:** set at unit-file-write time, not dynamic. Can't update between runs.
- **`EnvironmentFile=` with a file the app writes:** works, but requires a reload of the unit to re-read, and has no concurrency story. Overcomplex.
- **SQLite `config` table:** Node can read/write it easily, but the shell updater can't reliably read it without depending on `sqlite3` CLI being installed, and can't sanely write JSON into a key/value table on failure paths. Rejected.

### Chosen: `/opt/charging-master/.update-state/state.json`

A single JSON file at a well-known path. Atomic writes. Plain text that bash can read/write trivially.

**Path:** `/opt/charging-master/.update-state/state.json`
**Git-ignored.** Created with `mkdir -p` on first write.

**Schema:**
```json
{
  "status": "idle | checking | update-available | updating | ready-to-restart | rolled-back | error",
  "priorSha": "abc123...",
  "newSha": "def456...",
  "latestCommit": {
    "sha": "...",
    "message": "...",
    "committedAt": "2026-04-10T12:00:00Z"
  },
  "lastCheckedAt": "2026-04-10T12:00:00Z",
  "step": "fetching | installing | building | restarting",
  "error": null,
  "updatedAt": "2026-04-10T12:00:00Z"
}
```

### Writers and readers

| Writer | When | What fields |
|--------|------|-------------|
| `UpdateChecker` (Node, 6h) | After GitHub poll | `status` (idle/update-available), `latestCommit`, `lastCheckedAt` |
| `UpdateStateStore.markUpdating()` (Node, on POST /api/update/start) | Before spawning systemctl | `status=updating`, `step=starting` |
| `scripts/update/run-update.sh` (bash) | At each pipeline step and on error | `status`, `priorSha`, `newSha`, `step`, `error` |
| New Node process after restart | On boot | Reads state.json to restore UI status. If `status=ready-to-restart` and current SHA equals `newSha`, transitions to `idle`. |

| Reader | When | Why |
|--------|------|-----|
| `GET /api/version` | Every request (especially browser post-restart polling) | Report current status |
| `GET /api/update/status` | Browser on reconnect | Full state for UI |
| `UpdateChecker.check()` | Every 6h | Only set status if currently `idle` (don't clobber an in-flight update) |
| `run-update.sh` at start | Uses `git rev-parse HEAD` directly to capture PRIOR_SHA (more reliable than trusting state.json) | PRIOR_SHA is also written to state.json for the UI to display |

### Lifecycle

- **First boot ever:** file does not exist. `UpdateStateStore.read()` returns `null` → treated as `{status: 'idle'}`.
- **Happy path:** `idle` → `checking` → `update-available` → (user clicks) → `updating` → `ready-to-restart` → (process dies, new process starts) → new process reads, sees `status=ready-to-restart` and `newSha === CURRENT_SHA`, writes `idle`.
- **Rollback:** `updating` → (updater crashes during install/build) → `rolled-back` with `error` message → (Node app was never killed) → the still-running old-SHA Node app reads the file on next `/api/update/status` GET and shows "Update failed, rolled back to {priorSha}".
- **Rollback mid-build:** updater script's `trap ERR` fires, rollback runs, state file gets `rolled-back`, updater exits 1 without issuing restart. Main app never died. Perfect.
- **Stale state recovery:** if updater is SIGKILL'd (no traps fire) and leaves state as `updating`, next Node boot compares `newSha` in file to current `CURRENT_SHA` — if equal, mark idle; if different, mark `rolled-back-stale`.

### Concurrency

Single-writer-at-a-time by design: Node writes only when an update is *not* in progress; the updater script writes only when Node has handed off. The handoff point is the `systemctl start` call. No locks needed.

Atomicity: `UpdateStateStore.write()` uses the standard tmp-file-plus-rename pattern (`fs.writeFileSync(tmp, json); fs.renameSync(tmp, target)`). Bash writer uses same pattern (`... > "$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"`).

---

## Q7 — SSE Log Streaming

### Design

**Bypass EventBus entirely.** Here's why:

EventBus is designed for **fan-out of shared state** to multiple subscribers. Power readings go to every connected browser; charge events go to every connected browser. That's the right shape for those events.

A journal tail is different:
1. **Per-subscriber, not shared:** each SSE connection wants its own independent journalctl stream from a point in time ("last 500 lines" as context, then follow).
2. **External data source:** the data isn't generated inside the Node process — it's coming from a `journalctl` child process. Funneling it through EventBus adds a pointless middle layer and requires lifecycle management to start/stop the journalctl child based on whether anyone is listening.
3. **Ephemeral:** journal tailing is only meaningful during an active update. Not a steady-state event stream.

### Implementation

**`src/modules/self-update/journal-tailer.ts`:**

```typescript
import 'server-only';
import { spawn, type ChildProcess } from 'node:child_process';

export class JournalTailer {
  tail(onLine: (line: string) => void, onExit: () => void): () => void {
    const child: ChildProcess = spawn(
      'journalctl',
      ['-fu', 'charging-master-updater.service', '-n', '500', '--output=cat'],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );

    let buffer = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) onLine(line);
    });
    child.on('exit', () => onExit());

    return () => { child.kill('SIGTERM'); };
  }
}
```

**`src/app/api/update/log/route.ts`:**

```typescript
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { JournalTailer } from '@/modules/self-update/journal-tailer';

export async function GET(request: Request) {
  const encoder = new TextEncoder();
  const tailer = new JournalTailer();
  let killTail: (() => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      killTail = tailer.tail(
        (line) => {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ line })}\n\n`));
          } catch { /* closed */ }
        },
        () => {
          try { controller.close(); } catch { /* already closed */ }
        }
      );

      request.signal.addEventListener('abort', () => {
        killTail?.();
        try { controller.close(); } catch { /* already closed */ }
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
```

### Why this is the right pattern

- **Structural parallel to `sse/power/route.ts`:** same `runtime='nodejs'`, same `dynamic='force-dynamic'`, same `ReadableStream` idiom, same abort cleanup. A reviewer looking at both files will recognize the pattern instantly.
- **Child process cleanup is deterministic:** abort fires → `killTail()` → SIGTERM to journalctl → child exits → `onExit` fires → controller closes. Two exit paths, both clean.
- **During the restart:** when the Node app receives SIGTERM from the updater's `systemctl restart`, the request's abort signal fires (via `server.close()` dropping the connection), killing journalctl cleanly. Then Node exits. No orphaned journalctl child process.

### Optional EventBus integration (recommended, scope-compatible)

The `update:check` event (when the 6h poller finds a new commit) **should** go through EventBus — that's shared state multiple subscribers care about (VersionBadge, update status pill). Emit from `UpdateChecker.check()`:

```typescript
this.eventBus.emit('update:check', { status, latestCommit, lastCheckedAt });
```

A new SSE endpoint `/api/sse/update` (or extension of existing `/api/sse/power` with an `update` event type) can stream these. **But log lines specifically** — no. Those are per-connection.

---

## Q8 — Failure Surface Map

| # | Where it can fail | Layer that catches | User sees |
|---|-------------------|--------------------|-----------|
| 1 | GitHub API unreachable during 6h check | `UpdateChecker.check()` try/catch → sets `status=idle`, logs, bumps `lastCheckedAt` with error field | Settings shows "Last check: {time} · failed" but no blocking error |
| 2 | GitHub API rate-limited (403) | `GitHubClient.fetchLatestCommit()` → distinguishes from network error, state stores `lastCheckError='rate-limited'` | Same as #1 plus tooltip hint |
| 3 | User clicks Update while update already in progress | `POST /api/update/start` reads state.json, 409 if `status !== idle && status !== update-available` | UI disables button when status is `updating`/`ready-to-restart`; if race, toast "Update already running" |
| 4 | `systemctl start` command itself fails (unit not installed, permission denied) | `update-trigger.ts` checks spawn error event, returns `{ok:false, error}` | UI toast "Failed to trigger updater: {error}" — no update started, state remains idle |
| 5 | `git fetch` fails (no internet, DNS, GitHub down) | `run-update.sh` `trap ERR` → rollback (no-op because nothing changed) → exit 1 | State file shows `rolled-back` with error. UI banner "Update failed: fetch error. Rolled back (no changes)." |
| 6 | `git reset --hard` fails (disk full?) | `run-update.sh` `trap ERR` → rollback via `git reset --hard PRIOR_SHA` | Same banner |
| 7 | `pnpm install` fails (network mid-install, npm registry hiccup, peer dep conflict) | `run-update.sh` `trap ERR` → rollback: reset SHA, reinstall old deps, rebuild | Banner "Update failed during install. Rolled back to {priorSha}." Main app still running on old code — never died. |
| 8 | `pnpm build` fails (TypeScript error in new commit, missing env var) | Same as #7 | Banner "Update failed during build. Rolled back." |
| 9 | Rollback `pnpm install` itself fails | `run-update.sh` continues (best-effort rollback, `\|\| true`), writes `rolled-back` with error detail | Banner "Update failed AND rollback partially failed. SSH in to fix." |
| 10 | Disk full during build | Caught by `set -e` in shell script → rollback | Banner, plus user can see the disk-full line in the live log panel |
| 11 | `systemctl restart charging-master.service` issued but new code has startup bug | **Not caught in v1.2.** systemd marks main service failed, Restart=on-failure retries a few times then gives up. | Browser polling `/api/version` times out forever. No auto-rollback of a bad startup. **Known limitation** — flag in roadmap. User must ssh in. |
| 12 | Updater process killed externally (SIGKILL, OOM) | No trap fires — state file stuck in `updating`. | Next boot of Node app: `UpdateStateStore.read()` sees `status=updating`, compares `newSha` to current git SHA. If they match → treat as successful; transition to idle. If they differ → mark `rolled-back-stale` and alert. |
| 13 | State file corrupted / partial write | `UpdateStateStore.read()` catches JSON parse error → returns `null` → treated as idle | Settings shows "idle", no update metadata visible until next check |
| 14 | `journalctl` child in log SSE crashes mid-stream | `child.on('exit')` → SSE route closes stream | Browser EventSource reconnects automatically; fresh journalctl child spawned |
| 15 | Browser loses SSE connection during update (WiFi blip) | EventSource auto-reconnects; reconnect on the log endpoint starts a new journalctl (with `-n 500` replay of recent lines) | User sees "reconnecting..." briefly then resumes |
| 16 | Two browser tabs both subscribed to log SSE | Each gets its own journalctl child — independent streams, both work | Both tabs see identical log output |
| 17 | Update succeeds but browser never notices (user closed tab) | No problem — state file is source of truth. Next visit, UI reads `/api/version` and shows new SHA + "Updated {time} ago" | User sees current version on next visit |
| 18 | Pre-build `generate-version.mjs` fails during updater's pnpm build | Shell trap → rollback. Rollback `pnpm build` also calls `gen:version`. If the root cause is "not a git repo", both fail; `\|\| true` on rollback lets it continue, but next startup may have stale/missing version.ts. | Mitigation: the fallback to `'unknown'` SHA in `generate-version.mjs` keeps the build functioning even in that case. |

---

## Q9 — Phase Breakdown

Suggested split for the milestone. Order is driven by what blocks what.

### Phase 1 — Version awareness foundation (blocks everything)

**Scope:**
- `scripts/build/generate-version.mjs`
- `src/lib/version.ts` (generated, git-ignored)
- `.gitignore` entry
- `package.json` script updates (`gen:version`, modify `dev` and `build`)
- `src/app/api/version/route.ts` — initially returns only `current`, no `latest`/`status`
- Minimal `VersionBadge` client component in settings page
- Smoke test: build, start, GET `/api/version`, see SHA

**Rationale for going first:** Everything downstream — the GitHub checker, the UI "update available" badge, the browser's post-restart detection — depends on the running process knowing its own SHA. This is the cheapest, most orthogonal piece. No systemd, no networking. Can land in a day.

**Output:** App knows its version. UI displays it. `/api/version` works.

### Phase 2 — GitHub polling & update state

**Scope:**
- `src/modules/self-update/types.ts`
- `src/modules/self-update/github-client.ts`
- `src/modules/self-update/update-state-store.ts` (JSON file at `.update-state/state.json`, atomic writes)
- `src/modules/self-update/update-checker.ts` (6h interval)
- Modify `server.ts` to boot the checker
- Extend `/api/version` to include `latest`, `status`, `lastCheckedAt`
- `src/app/api/update/status/route.ts`
- VersionBadge: show "Update available: {shortSha}" when `latest.sha !== current.sha`
- EventBus: add `update:check` emit from `UpdateChecker` and wire VersionBadge to live-update via new SSE event type (nice-to-have, can defer)
- Tests for github-client (mock fetch), update-state-store (tmp dir), update-checker (fake timers)

**Rationale:** This is pure read-only. Worst case it's wrong about an update being available. Nothing gets installed. Safe to ship and iterate.

**Output:** App polls GitHub every 6h, persists state, UI shows "update available" badge. No actual update capability yet.

**Can parallelize with Phase 3?** Mostly yes — Phase 3 is systemd/shell and Phase 2 is TS. Could be two parallel work streams if splitting across contributors. Single contributor: serial is fine.

### Phase 3 — Updater unit & pipeline script

**Scope:**
- `scripts/update/run-update.sh` with full pipeline + rollback
- `/etc/systemd/system/charging-master-updater.service` unit
- `install.sh` modifications to install the new unit and mark script executable
- Manual test matrix on a throwaway LXC:
  - happy path update
  - `git fetch` fails (disconnect network mid-update)
  - `pnpm install` fails (inject bad `package.json`)
  - `pnpm build` fails (inject TS error)
  - kill updater mid-build (SIGKILL) → verify stale state detection on next boot
- Manual invocation: `sudo systemctl start charging-master-updater.service` with `journalctl -fu` open in another terminal

**Rationale:** Shell + systemd can be developed and tested independently of the Node app. By the end of this phase, you can trigger updates from the command line. The web UI doesn't need to exist yet.

**Output:** Working updater unit, tested rollback in all failure modes.

### Phase 4 — UI integration & restart handoff

**Scope:**
- `src/modules/self-update/update-trigger.ts` (spawn systemctl, detached, unref)
- `src/modules/self-update/journal-tailer.ts`
- `src/app/api/update/start/route.ts`
- `src/app/api/update/log/route.ts` (SSE)
- Settings page UI:
  - UpdateButton (disabled unless `update-available`)
  - LiveLogPanel (opens when update starts, tails journal)
  - Post-restart detection: poll `/api/version` every 2s after SSE drops, compare to *initial* SHA, reload on change
- Graceful shutdown additions in `server.ts` (stop update-checker, kill any live journal tailers)
- End-to-end test on real LXC: click button → watch logs stream → observe restart → browser auto-reloads → new version displayed

**Rationale:** This is the last piece because it ties Phases 1–3 together. Without Phase 3's shell script, there's nothing to trigger. Without Phase 2's state, there's nothing to gate the button on. Without Phase 1's version baking, the browser can't detect the post-restart version change.

**Output:** User clicks button → update happens → browser reloads to new version. The feature.

### Build order summary

```
Phase 1  ──────────────────┐
 (version baking)          │
                           ▼
Phase 2  ─────►  Phase 4
 (GitHub poll +           ▲
  state store)            │
                           │
Phase 3  ─────────────────┘
 (updater unit +
  pipeline script)
```

Phase 1 unblocks everything. Phases 2 and 3 are independent (can parallelize). Phase 4 integrates all three.

### Scope notes for the roadmapper

- **Recommended complexity labels:** Phase 1 = S, Phase 2 = M, Phase 3 = M, Phase 4 = L (the restart handoff and the UI polish are the meaty bits).
- **Known deferrals (flag in roadmap, out of scope v1.2):** watchdog for failed post-restart boot (Q5 edge case #11), UI for manual rollback button, update history log, update verification (GPG signing / SHA allowlist).

---

## Integration Points

### External services

| Service | Integration Pattern | Notes |
|---------|---------------------|-------|
| GitHub API | `GET /repos/meintechblog/charging-master/commits/main` via native `fetch` every 6h | Unauthenticated (public repo, 60 req/h limit, we use 4/day). Use ETag/If-None-Match to be polite. |
| systemd | `systemctl start charging-master-updater.service` via `child_process.spawn`, detached+unref | Runs as root so no polkit. The unit itself does `systemctl restart charging-master.service` at the end. |
| journald | `journalctl -fu charging-master-updater.service -n 500 --output=cat` via `child_process.spawn`, per SSE subscriber | Transient, cleaned up on abort. |
| git | `git fetch origin`, `git reset --hard`, `git rev-parse HEAD`, `git stash push -u` — all from shell script and prebuild script | Run inside `/opt/charging-master`, as root. |
| pnpm | `pnpm install --frozen-lockfile`, `pnpm build` — from shell script | Needs internet access during install. |

### Internal boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| `server.ts` → `UpdateChecker` | Direct instantiation in boot sequence (same pattern as HttpPollingService) | Via `globalThis.__updateChecker` for route-handler access |
| `UpdateChecker` → `EventBus` | `eventBus.emit('update:check', state)` | Consumed by any future SSE stream that wants live update-available badges |
| Route handlers → `UpdateStateStore` | Direct read/write via `globalThis.__updateStateStore` | Matches `globalThis.__eventBus` pattern |
| Node app ↔ updater shell script | File-based handoff via `.update-state/state.json` + systemd `start` | Deliberately loose coupling — the updater must run independently |
| Updater shell script → main service | `systemctl restart charging-master.service` | Fire-and-forget; systemd owns lifecycle from here |
| Browser → server | HTTP (version + update endpoints) + SSE (log streaming) | SSE pattern identical to existing `sse/power/route.ts` |

---

## Anti-Patterns to Avoid

### AP1: Writing `src/lib/version.ts` as a runtime file-read

**Mistake:** `export const CURRENT_SHA = fs.readFileSync('.git/HEAD').toString();`
**Why bad:** Breaks in the client bundle (no `fs`), breaks in production where `.git` may or may not be present, defeats build-time baking. Not deterministic across restarts if the git state changes.
**Do:** Generate a constants file at build time (§3).

### AP2: Triggering the updater via `child_process` without `detached: true, unref()`

**Mistake:** `await execAsync('systemctl start charging-master-updater.service')`
**Why bad:** The `await` ties the Node process to the systemctl call. If Node receives SIGTERM before systemctl returns, the exec promise rejects and the update may not have been triggered. Worse, even with success, Node holds a child reference until GC.
**Do:** `spawn('systemctl', ['start', ...], { detached: true, stdio: 'ignore' }).unref()`. Fire-and-forget.

### AP3: Storing rollback SHA in the SQLite `config` table

**Mistake:** `INSERT INTO config (key, value) VALUES ('update.priorSha', 'abc123')`
**Why bad:** The bash updater would need `sqlite3` CLI installed *and* a reliable way to update during rollback. If the app process is dead, the SQLite file may be in WAL mode and writes from outside are risky. Coupling the updater to SQLite creates a dependency the updater doesn't need.
**Do:** Plain JSON file at `.update-state/state.json` (§6).

### AP4: Routing journal log lines through EventBus

**Mistake:** `eventBus.emit('log', line)` inside the journalctl tailer.
**Why bad:** EventBus is for shared state broadcast to many subscribers. Journal logs are per-update, per-tab, ephemeral. Going through EventBus means the tailer child process is either always running (wasteful) or has to be lifecycle-managed from the bus (complex). Easier to let each SSE connection own its journalctl child directly.
**Do:** Direct `spawn` in the log SSE route handler (§7).

### AP5: Making the updater wait for main service restart to succeed

**Mistake:** `systemctl restart --wait charging-master.service` in the updater script, with `|| rollback`
**Why bad:** `systemctl restart` doesn't have a usable health-check semantic — it returns when the new process has been *forked*, not when it's *healthy*. The updater can't see "does the app respond to HTTP yet?" Waiting naively will timeout on perfectly healthy restarts.
**Do:** Fire-and-forget restart at end of updater. Accept that "new code won't boot" is an unhandled edge case for v1.2 (Q8 #11). A future watchdog phase can add a post-restart health check.

### AP6: Running `pnpm build` from inside the Node app process

**Mistake:** Calling `spawn('pnpm', ['build'])` from an API route.
**Why bad:** The running Node process holds file handles to `.next/`. `next build` rewrites those files. On Linux this usually "works" due to inode semantics, but SQLite and Next.js caches can end up in weird states. Also: the build takes 2+ minutes; the route handler would have to hold the request open that long.
**Do:** All build/install work happens in the **separate** updater oneshot process, not in the app process.

---

## Scaling / Future Considerations

Not really applicable for a single-user LAN app, but for completeness:

| Concern | At current (1 user, 1 LXC) | Future (multiple LXCs, shared config) |
|---------|----------------------------|---------------------------------------|
| Update coordination | N/A — one box | Would need a centralized release manifest + staggered rollout. Out of scope forever per PROJECT.md. |
| Update verification | None — we trust GitHub over HTTPS | Could add SHA allowlist or GPG-signed tags. Worth reconsidering if the app ever leaves the LAN. |
| Rollback to arbitrary version | Only to prior HEAD | Could store a ring buffer of N recent SHAs in state.json. Easy to add later. |
| Update cancellation | Not supported — once started, runs to completion or fails | Would require `systemctl stop charging-master-updater.service` path. Trivial to add if needed. |

---

## Sources

- Existing source code (verified):
  - `/Users/hulki/codex/charging-master/server.ts` — custom Node server entrypoint with singleton lifecycle pattern
  - `/Users/hulki/codex/charging-master/src/modules/shelly/http-polling-service.ts` — reference for boot-time singleton service
  - `/Users/hulki/codex/charging-master/src/modules/events/event-bus.ts` — EventBus API to extend
  - `/Users/hulki/codex/charging-master/src/app/api/sse/power/route.ts` — SSE pattern to mirror in log endpoint
  - `/Users/hulki/codex/charging-master/install.sh` — existing systemd unit definition, root execution context confirmed
  - `/Users/hulki/codex/charging-master/package.json` — scripts structure and existing dependencies
  - `/Users/hulki/codex/charging-master/next.config.ts` — confirms no server-side config tricks in use
  - `/Users/hulki/codex/charging-master/src/app/api/settings/route.ts` — reference for thin route-handler pattern
- Verified decisions from milestone brief (locked externally): dedicated one-shot updater unit, `git stash → fetch → reset → install → build → restart` pipeline, auto-rollback to prior HEAD SHA, 6h polling, version = git HEAD SHA baked at build time.

---
*Architecture research for: self-update (charging-master v1.2)*
*Researched: 2026-04-10*
*Confidence: HIGH — grounded in verified existing source; no uncharted external dependencies beyond standard Node/systemd primitives.*
