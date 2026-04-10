# Pitfalls Research — Milestone v1.2 Self-Update

**Domain:** In-app self-update for a long-running Node.js systemd service (Next.js 15 + better-sqlite3 + pnpm + git + GitHub API + SSE)
**Researched:** 2026-04-10
**Confidence:** HIGH (systemd, git, better-sqlite3, GitHub REST conventions are well-documented and stable; a few pnpm@10 edge cases flagged as MEDIUM)

> This file supersedes the v1.0 PITFALLS.md. The v1.0 research covered MQTT/IoT/charging. Milestone v1.2 adds self-update; the pitfalls below are scoped to that feature set.

## Critical Pitfalls

### Pitfall 1: The "kill your own parent" problem (updater is a child of the process it restarts)

**What goes wrong:**
If the Node.js process (`charging-master.service`) calls `child_process.spawn("bash", ["update.sh"])` or even `execa("systemctl", ["restart", "charging-master.service"])` inline, the child inherits the cgroup of the parent service. The moment systemd restarts `charging-master.service`, the default `KillMode=control-group` sends SIGTERM to every PID in the cgroup — including the update script. The updater dies mid-`pnpm install`, leaving `node_modules/` half-written, a half-cloned git tree, or a half-built `.next/`.

**Why it happens:**
Developers reach for `child_process.exec("git pull && pnpm install && pnpm build && systemctl restart charging-master")` as the obvious one-liner. It works in dev when run by hand. It breaks as soon as the command is triggered from inside the service. The cgroup inheritance is invisible unless you know to look for it.

**Concrete failure:**
- User clicks "Update".
- Node runs `spawn("/usr/local/bin/charging-master-update.sh")`. Script starts `pnpm install`.
- 30 seconds later the script calls `systemctl restart charging-master.service`.
- systemd stops the unit → cgroup killed → pnpm install SIGTERM'd mid-write → `node_modules/better-sqlite3/build/Release/` now contains a truncated `.node` file.
- systemd starts the unit → `require('better-sqlite3')` → `Error: Could not locate the bindings file` → systemd tries again → same error → `StartLimitBurst` reached → unit enters `failed` state.
- No rollback runs because the updater died three steps ago. App is down.

**How to prevent it (actionable):**
Do **not** run the update pipeline as a child of `charging-master.service`. Instead:

1. Create a dedicated one-shot unit `charging-master-updater.service` (`Type=oneshot`, `RemainAfterExit=no`) that runs the update script. This unit is **not** a child of `charging-master.service` — it is a sibling managed directly by PID 1.
2. The Node process triggers the update by calling `systemctl start --no-block charging-master-updater.service` (via `execFile`, not shell). `--no-block` returns immediately; the call does not wait for the unit to finish.
3. Because `systemctl start` only *enqueues* the job with PID 1, the updater unit runs inside its own cgroup. When that unit later issues `systemctl restart charging-master.service`, only the main service is stopped — the updater keeps running.
4. Do not put `BindsTo=` or `PartOf=` coupling between the two units.
5. Grant the main service the minimal polkit rule or add an `ExecStart=/bin/systemctl start --no-block charging-master-updater.service` wrapped through a scoped polkit rule for `org.freedesktop.systemd1.manage-units` on that unit — *not* global sudo.

**Alternative considered (rejected):** `systemd-run --scope --unit=updater`. `--scope` runs the process as a child of the invoker, which is exactly what we're trying to avoid. `systemd-run --user` + detach would also work but complicates permissions. A **pre-registered unit file** is simpler and auditable.

**Warning sign during development:**
`systemctl status charging-master-updater.service` shows `Main PID: 0` or the unit never appears as "active" after trigger → Node is spawning the script inline instead of via systemctl.

**Phase to address:** Phase 1 (Updater systemd unit + trigger mechanism). This is the load-bearing decision — build it right before writing a single line of update logic.

---

### Pitfall 2: pnpm install races and leftover native bindings

**What goes wrong:**
Two things can race during `pnpm install`:
1. The main `charging-master.service` is still running and holds open file handles on `node_modules/better-sqlite3/build/Release/better_sqlite3.node` and on cached `.next/` files. On Linux, unlinking a file with open handles works, but `pnpm` may write a new binding *in place*, and the old process still sees the old mmap while the new process can't load the half-written new one.
2. A second `pnpm install` is triggered (user clicks Update twice, or a scheduled background check fires during a user-initiated update). pnpm@10 acquires a store lock, but the project-level `node_modules/.pnpm/` state can be left inconsistent if the second invocation SIGTERMs the first.

pnpm@10 specifically has known issues with `better-sqlite3` bindings ("Could not locate the bindings file" after install), and `onlyBuiltDependencies: ["better-sqlite3"]` in `package.json` (which this project already has) only helps if `pnpm approve-builds` has run at least once in the target environment.

**Why it happens:**
Next.js + better-sqlite3 + pnpm all assume they have exclusive write access to `node_modules/` during install. Developers treat `pnpm install` as idempotent; it isn't when there's a live process mmap'ing a native binding.

**Concrete failure:**
`apower` readings stream normally. User clicks Update. Updater runs `pnpm install --frozen-lockfile`. The main service is still running. pnpm rewrites `better_sqlite3.node`. The main service's existing file descriptor still works, so there's no immediate error. Updater calls `systemctl restart charging-master.service`. New process boots, calls `require('better-sqlite3')`, and gets `Could not locate the bindings file` — because pnpm@10 wrote bindings to a path the new Node version (if Node was upgraded transitively) doesn't expect. Rollback is triggered. Rollback re-runs `pnpm install` against the *old* lockfile. Second race, same problem.

**How to prevent it (actionable):**
1. **Stop the main service before `pnpm install`, not after.** Order must be: `git fetch/reset` → `systemctl stop charging-master.service` → `pnpm install --frozen-lockfile` → `pnpm build` → `systemctl start charging-master.service` → health check. This creates a planned downtime window of 30-120 seconds, which is acceptable for a single-user LAN app.
2. Use `--frozen-lockfile` **unconditionally** in production updates. Never let the updater silently bump the lockfile.
3. Run `pnpm rebuild better-sqlite3` after install as a belt-and-braces step (cheap, deterministic, covers Node version drift).
4. Hold a **file lock** (`/var/lock/charging-master-update.lock` via `flock(1)`) around the entire updater script. The Node trigger endpoint must detect the lock and return `409 Conflict` if already locked. The systemd unit should use `ExecStart=/usr/bin/flock --nonblock /var/lock/charging-master-update.lock /usr/local/bin/charging-master-update.sh`.
5. Ensure `pnpm approve-builds` has been run during initial deployment. Include a post-install check in the updater: if `better_sqlite3.node` is missing after `pnpm install`, abort and rollback immediately rather than proceeding to build.

**Warning sign:**
Any "Could not locate the bindings file" in journalctl output, or `node_modules/better-sqlite3/build/Release/` missing the `.node` file.

**Phase to address:** Phase 2 (Updater script pipeline).

---

### Pitfall 3: better-sqlite3 / SQLite during the restart window

**What goes wrong:**
better-sqlite3 is synchronous; every write is a blocking `fsync()` at the OS level by default. When the charging app stops for an update, any of the following is likely in flight:
- An active charge session with a streaming `power_samples` INSERT every 1–2 seconds.
- An open read cursor from the dashboard's SSE stream.
- A checkpoint operation pending on the WAL file.

When SIGTERM arrives mid-transaction, better-sqlite3 *does* flush on process exit in the normal case, but if the updater uses `SIGKILL` (which systemd will do after `TimeoutStopSec`), the WAL file can be left in a state where:
- The `-wal` file has committed pages that haven't been checkpointed into the main `.db` file.
- Recovery runs fine on next open (SQLite is robust here).
- **BUT** if the update *also* touches the database path (e.g., the new code runs a migration that renames a column), the new connection may open the old WAL on a schema that no longer matches.

Additionally, if the `.db-wal` file is very large at the time of stop (heavy write session), the first new connection takes 30+ seconds to recover, and the health check after restart times out — triggering a rollback that wasn't needed.

**Why it happens:**
Developers assume "SQLite just works". It mostly does, but the combination of (a) restart mid-write (b) possible schema migration (c) health-check timeout races creates a narrow but repeatable corruption-adjacent window.

**Concrete failure:**
User is charging an iPad. Clicks Update. Main service SIGTERM'd, graceful shutdown aborts two open INSERTs. Updater runs migration via drizzle-kit push. Migration rewrites a constraint on `power_samples`. New server boots, opens DB, SQLite replays WAL into a schema that no longer has the old column shape. Recovery fails softly: foreign key violation logged, app boots but latest 30 seconds of charge samples are silently discarded. Session row shows `ended_at = null` forever.

**How to prevent it (actionable):**
1. **Pre-shutdown drain step.** Before the updater runs `systemctl stop charging-master.service`, call an HTTP endpoint on the app (`POST /api/internal/prepare-for-shutdown`) that (a) pauses new sample writes, (b) commits any open transaction, (c) runs `PRAGMA wal_checkpoint(TRUNCATE);` to force the WAL into the main DB file, (d) returns 200 when complete. Only then issue the stop.
2. **No migrations inside the auto-updater pipeline in v1.2.** Schema migrations are a separate concern and must be gated by a manual flag (`UPDATE_ALLOW_MIGRATIONS=1`). For v1.2 self-update, lock schema changes out of the auto-path; if a commit touches `drizzle/` migrations, the update-availability endpoint should flag it as "needs manual update" and refuse auto-apply.
3. **Health check on restart verifies DB open.** First probe after restart must be "can I `SELECT 1` from SQLite?" not just "did the HTTP port bind?". A bound port with a broken DB should count as failure and trigger rollback.
4. **Backup before update.** Updater copies `charging.db` + `charging.db-wal` + `charging.db-shm` to `charging.db.backup-<sha>` before the stop. Rollback path can restore this. Cost is a few hundred ms and some disk space.
5. `TimeoutStopSec=30` on the main service unit so graceful shutdown has time, and `KillSignal=SIGTERM` (the default).

**Warning sign:**
After a restart, `journalctl -u charging-master` shows "database is locked" or "SQLITE_BUSY" within the first few seconds → WAL recovery was interrupted or raced.

**Phase to address:** Phase 2 (Updater pipeline) for drain/backup; Phase 3 (Health check & rollback) for DB-open probe.

---

### Pitfall 4: Git state corruption during fetch/reset

**What goes wrong:**
Several git states can break the update:
- Working tree has **untracked** files the updater didn't expect. `git reset --hard <sha>` does **not** remove untracked files. Leftover `.env.local`, stale generated config, or the previous `.next/` cache all survive.
- Working tree has **modified tracked** files (e.g., a debug log somebody edited on the server). `git fetch` succeeds, `git reset --hard` discards them — may or may not be the desired behavior, but it is silent.
- A prior interrupted update left `.git/rebase-merge/` or `.git/MERGE_HEAD/` on disk. `git fetch` works, `git reset --hard` refuses because it considers the repo "in the middle of a rebase".
- Detached HEAD after `reset --hard <sha>` (which is actually what we want — we're not on a branch, we're on a SHA), but subsequent naive `git pull` calls will fail because there's no upstream.
- `.gitignored` files like `node_modules/` and `.next/` survive reset (correctly), but the rollback SHA expects different `node_modules/` contents.

**Why it happens:**
Git is very lenient; it does not enforce a "clean repo" invariant unless you explicitly ask for it. Developers write `git fetch && git reset --hard origin/main` assuming it's a clean-slate operation. It isn't.

**Concrete failure:**
Phase 1 leaves behind `.planning/debug/something.md`. Later, an update is triggered. Updater calls `git reset --hard <new-sha>`. Untracked debug files persist. Next update compares `git status --porcelain` and sees a dirty tree. Defensive check fires, refuses to update. App is stuck until someone SSHs in.

**How to prevent it (actionable):**
1. Before `git fetch`, assert repo cleanliness: `git status --porcelain` must return empty. If not, abort with a clear error that lists the offending files.
2. Before `git reset --hard`, check for in-progress operations: if `.git/MERGE_HEAD`, `.git/rebase-merge/`, `.git/rebase-apply/` or `.git/CHERRY_PICK_HEAD` exist, abort with explicit "git is in an in-progress state" error.
3. After `git reset --hard`, run `git clean -fdx -e node_modules -e .next -e data -e /charging.db*` to remove any untracked files except the explicit data directories. The `-e` excludes are critical: wiping `charging.db` would delete user data.
4. Never use `git pull`. Always use `git fetch` followed by `git reset --hard <explicit-sha>`. Record the SHA from the API response, don't trust `origin/main` to still point to the same thing seconds later.
5. Pin the `remote` config once at deploy time (`git remote set-url origin https://github.com/meintechblog/charging-master.git`); the updater never rewrites it.

**Warning sign:**
Updater log contains `fatal: You are in the middle of a ...` or `error: Your local changes to the following files would be overwritten`.

**Phase to address:** Phase 2 (Updater pipeline).

---

### Pitfall 5: pnpm-lock.yaml drift between main and local environment

**What goes wrong:**
If the `pnpm-lock.yaml` on `origin/main` was generated with a newer pnpm version (e.g., 11.x) than is installed on the LXC (e.g., 10.30.3), `pnpm install --frozen-lockfile` refuses to proceed: *"Cannot proceed with the frozen installation. The current lockfile format version is 9.0, but this pnpm version expects format X."* Similarly, if the lockfile references a package version that isn't in the configured registry cache, install fails.

Node version drift is a parallel hazard: the lockfile might pin a version of `better-sqlite3` compiled against Node 22, but the LXC is on Node 20. `pnpm install` succeeds but `pnpm rebuild` fails or the loaded `.node` binding mismatches.

**Why it happens:**
pnpm and Node get upgraded on the developer machine organically. The LXC is a frozen environment that rarely gets touched except during deploys. Drift accumulates silently.

**Concrete failure:**
Developer updates pnpm locally, pushes commit with new lockfile, user clicks Update. `pnpm install --frozen-lockfile` errors out with "Unsupported lockfile version". Updater enters rollback. Rollback also runs `pnpm install` on the old lockfile — which still works, so rollback succeeds. User sees "Update failed, rolled back" with a cryptic pnpm error.

**How to prevent it (actionable):**
1. **Pre-flight check before the update starts.** The update-availability endpoint (the GitHub poll) should fetch the `package.json` + `pnpm-lock.yaml` metadata for the candidate commit *before* triggering the update. Parse `packageManager` field and the lockfile `lockfileVersion`. If either is incompatible with what's installed, mark the update as `blocked: incompatible-tooling` in the UI and do not allow auto-apply.
2. Pin `packageManager` in `package.json` (already done: `"packageManager": "pnpm@10.30.3"`). Updater scripts use `corepack` to enforce exactly this version: `corepack prepare pnpm@10.30.3 --activate` before `pnpm install`.
3. Pin Node version via `.node-version` or `engines` in `package.json`. Updater rejects updates that bump the Node major version.
4. Run `pnpm install --frozen-lockfile --prefer-offline` so pnpm uses its content-addressed store first, reducing the chance of network-caused mid-install failures.

**Warning sign:**
`pnpm install` failing with "Unsupported lockfile version", "ERR_PNPM_OUTDATED_LOCKFILE", or "The current version of pnpm is not compatible with".

**Phase to address:** Phase 1 (version/compatibility check) — this is a pre-flight gate, not a pipeline step.

---

### Pitfall 6: Build failure mid-update — rollback must reinstall AND rebuild

**What goes wrong:**
Pipeline runs: `git reset → pnpm install (succeeds) → pnpm build (fails)`. Naive rollback: `git reset --hard <old-sha>`. This does **not** undo the `pnpm install` — `node_modules/` still has the new dependencies. Running the old code against new dependencies fails at runtime with mismatched module APIs.

The rollback pipeline must re-run the full `pnpm install` **and** `pnpm build` for the old SHA, and this second build can also fail (e.g., because `node_modules/` is now a hybrid of old and new state).

**Why it happens:**
Developers think of rollback as "git reset". Actually rollback is "redo the full install+build for the old SHA in a clean state". The asymmetry between "forward" and "backward" paths is easy to miss.

**Concrete failure:**
`pnpm install` succeeds for new SHA, `pnpm build` fails (e.g., TypeScript error in a file that depends on a newly-bumped dependency). Rollback triggers: `git reset --hard <old-sha>` → `pnpm install` (reinstalls old deps, succeeds) → `pnpm build` (fails! because `.next/cache/` has stale artifacts from the failed build). Rollback also fails. App is now stopped, no working `.next/`, no working deps. User sees "Update and rollback both failed".

**How to prevent it (actionable):**
1. **Blow away `.next/` before every build**, both forward and rollback. `rm -rf .next` is mandatory before `pnpm build`. Next.js build cache is not safe across different SHAs.
2. **The rollback path is just "run the pipeline with the old SHA".** Do not treat rollback as a smaller subset. Same script, same steps, different target SHA. Parameterize the pipeline by `TARGET_SHA`.
3. **Symlink swap pattern (recommended for robustness):** Deploy each build into `/opt/charging-master/releases/<sha>/` and maintain a symlink `/opt/charging-master/current -> releases/<sha>`. Rollback becomes atomic symlink swap to the previous release directory, no rebuild needed. Old releases kept for N generations. This dramatically reduces rollback complexity and failure modes. **Strongly recommended.**
4. If symlink swap is rejected as too invasive for v1.2: require the updater to save `node_modules.tar` + `.next.tar` to `/tmp/charging-master-snapshot-<sha>/` before starting, and rollback untars these into place. Slower but no rebuild needed.
5. If the rollback itself fails, escalate: see Pitfall 7.

**Warning sign:**
Any `pnpm build` failure after a successful `pnpm install`, or a second build failure during rollback.

**Phase to address:** Phase 2 (pipeline) + Phase 3 (rollback) — treat them as one design decision.

---

### Pitfall 7: Rollback itself fails (the escape hatch)

**What goes wrong:**
Forward update failed. Rollback runs. Rollback fails too — possible causes:
- Network died mid-update; can't re-fetch even the old state.
- Disk filled up during forward build, no space left for rollback build.
- Git repo is corrupted (loose object truncated) because the forward SHA's pack was partially written.
- `pnpm install` for old SHA now fails because the registry is down, the old cached tarballs were evicted, and there's no network.
- The main service unit is still `stopped` from the forward pipeline. Now there's nothing to fall back to — the box is down.

**Why it happens:**
Developers focus on "does the update work" and treat rollback as insurance that always works. It doesn't always.

**How to prevent it (actionable):**
1. **Keep the previous working `.next/` + `node_modules/` as a tarball snapshot at the start of the update.** Before `git fetch`, tar+gzip the live tree into `/var/lib/charging-master/snapshots/<sha>-prev.tgz`. Rollback extracts this tarball and restarts — no network, no pnpm, no git. Pure filesystem restore. This is the escape hatch.
2. **Reserve disk space.** Updater checks free disk before starting; if less than 2x the size of `.next/` + `node_modules/`, refuse the update with "insufficient disk space".
3. **Two-stage rollback:**
   - Stage 1: "clean rollback" — re-run pipeline against previous SHA. Normal expected path.
   - Stage 2: "emergency rollback" — if stage 1 fails, extract the tarball snapshot and force-start the service. No git, no pnpm.
   - Stage 3: "panic" — if even stage 2 fails, leave a `/var/lib/charging-master/PANIC` marker file, emit a Pushover notification ("charging-master update catastrophically failed, SSH required"), and stop trying.
4. The Pushover notification path must use `curl` directly (from the updater shell script) — not the Node app's notification code, because the Node app may be down.
5. `journalctl -u charging-master-updater -f` should always be sufficient to diagnose. Every stage logs a distinctive marker.

**Warning sign:**
PANIC file exists, or Pushover "update failed catastrophically" notification received.

**Phase to address:** Phase 3 (rollback + escape hatch).

---

### Pitfall 8: GitHub API rate limit (60/h unauthenticated) and ETag caching

**What goes wrong:**
The update check polls `GET https://api.github.com/repos/meintechblog/charging-master/commits/main`. Unauthenticated: **60 requests per hour per IP**. A single LXC is fine at a 6h poll (4/day). But:
- Every browser tab that opens the Settings page triggers a fresh check.
- A tight React `useEffect` dependency loop triggers 20 checks in 10 seconds during development.
- If the LXC is behind a shared NAT with other devices that also hit api.github.com, the 60/h is shared.
- After hitting the limit, subsequent calls return 403 with `X-RateLimit-Remaining: 0` — the update UI shows "check failed", forever, until the hour ticks over.

ETag support changes the math: GitHub returns `ETag` on responses; passing `If-None-Match: <etag>` on the next request returns `304 Not Modified` and **does not count against rate limit**. So a well-behaved client polling the same endpoint can poll effectively unlimited times while the resource is unchanged.

**Why it happens:**
Developers don't read the GitHub REST rate limit docs closely. They see "60/h" and panic, or they don't, and then get bitten.

**How to prevent it (actionable):**
1. **All GitHub API polling goes through the server only.** The browser never calls GitHub directly. The server caches the latest result (commit SHA, fetched-at timestamp, ETag) in SQLite. Browser hits `/api/version/check` which returns the cached value immediately if less than N minutes old, or triggers a fresh fetch otherwise.
2. **Implement ETag caching end-to-end.** Server stores the `ETag` header from the last GitHub response. On next fetch, include `If-None-Match: <stored-etag>`. On 304, do not increment any "new data" counter; just update the `checked_at` timestamp.
3. **Rate-limit the fetch itself server-side.** Minimum 5 minutes between GitHub calls regardless of how often the UI asks. The 6h scheduled poll is the primary driver; manual "check now" button should be rate-limited to once per 5 minutes.
4. **Read `X-RateLimit-*` response headers and store them.** If `X-RateLimit-Remaining` drops below 10, stop polling until `X-RateLimit-Reset` passes. Display "rate-limited, next check at HH:MM" in the UI.
5. **Do not auto-retry on 403.** A 403 with `X-RateLimit-Remaining: 0` is not a transient error; retrying makes it worse.
6. Optional: allow the user to paste a GitHub Personal Access Token into Settings for 5000/h. For a single-user LAN app, this is overkill but trivial to add if needed.

**Warning sign:**
Any response with `X-RateLimit-Remaining: 0`, or 403 from api.github.com.

**Phase to address:** Phase 1 (version/check endpoint and polling).

---

### Pitfall 9: Stale check results — the "displayed diff lies" problem

**What goes wrong:**
The check endpoint said "update available: commit abc123" at 10:00. User reads the changelog, decides to click Update at 10:15. Between 10:00 and 10:15, a new commit def456 was pushed. User clicks "Update". The updater fetches `origin/main`, which is now at `def456`, **not** `abc123`. User gets a version they didn't review.

Worse: the commit they clicked on was known-good, the new commit introduces the bug. Rollback works but the user is confused about what they actually got.

**Why it happens:**
Developers conflate "what the check endpoint returned" with "what main currently points to". The two diverge the moment a new commit is pushed.

**How to prevent it (actionable):**
1. **The update trigger takes an explicit `targetSha` parameter.** The UI sends the SHA it saw during the check. The updater uses `git fetch origin && git reset --hard <targetSha>`. If the SHA is no longer reachable (garbage collected, force-pushed over), the update fails with a clear "target commit no longer exists on origin" error.
2. **Do not pass branch names to `git reset`.** Always SHAs. `git reset --hard origin/main` is banned in the updater script.
3. **The UI displays the SHA it's about to apply**, not just the commit message. User sees `"Apply def456 (clicked on abc123)"` if drift happened, and the update button becomes "Recheck" instead.
4. **Refresh the check right before triggering.** The "Update" button click runs one last `/api/version/check` (cache-bypass, respecting the rate limit) and compares. If the SHA changed since the user opened the page, show a diff and re-require confirmation.

**Warning sign:**
User reports "I clicked on one commit but got a different one".

**Phase to address:** Phase 1 (check endpoint) + Phase 4 (UI).

---

### Pitfall 10: SSE stream during restart — browser doesn't know it's a new version

**What goes wrong:**
The update log UI reads from an SSE endpoint (`/api/updater/stream`) that tails `journalctl -u charging-master-updater`. The browser's `EventSource` auto-reconnects by default when the connection drops, which is nice. But:
- When `charging-master.service` restarts, the SSE stream dies. EventSource reconnects. It reconnects to the **new** server, which may have different code, different SSE semantics, or may still be booting (500 errors during boot).
- The browser keeps showing the old UI. The user's dashboard still says "v1.1.4" even though the server is now "v1.1.5". No auto-reload.
- If the new server is broken (boots, serves the old cached HTML from `.next/static/`, but API routes 500), the user is confused — "the update looks successful but nothing works".
- Service workers (if any) serve the old JS bundle from cache indefinitely.

**Why it happens:**
EventSource's auto-reconnect is a browser feature but doesn't know anything about application versioning. Developers assume "the page will just refresh".

**How to prevent it (actionable):**
1. **Every API response includes an `X-App-Version: <sha>` header.** The browser stores the SHA it first saw on page load. On every subsequent response (including SSE messages, which can carry a `version` field), if the SHA differs, the UI triggers `window.location.reload()`. This is the standard "hash mismatch → reload" pattern.
2. **The SSE stream emits a `version` event as its first message**, containing the server's current SHA and build time. The client compares; mismatch → reload.
3. **Poll `/api/version` during the update flow.** Once the UI knows an update is in progress, stop trusting the SSE stream's semantics and instead poll `/api/version` every 2 seconds. When it returns the new SHA with HTTP 200 and DB-ready, show "update complete" and trigger `location.reload()`.
4. **Use a timestamped query string on the client bundle URL.** Next.js handles bundle hashing; ensure `next.config.ts` doesn't set `generateBuildId` to a constant. Default behavior is fine but verify.
5. **Disable any service worker caching of the Next.js app shell** for v1.2. If we add one later, versioning becomes significantly more complex.
6. **`EventSource` gets explicit reconnect logic** wrapping the default: on error, close and reopen. Use `reconnecting-eventsource` or a small hand-rolled wrapper. Log reconnect attempts in dev console.
7. **Health gate:** the UI should show "waiting for server" (not "update complete") until `/api/version` returns HTTP 200 AND DB-ready AND SHA matches target. Three conditions, all or nothing.

**Warning sign:**
User reports "the page still shows the old version after update", or the SSE stream emits after-restart events but the UI doesn't reload.

**Phase to address:** Phase 4 (UI + SSE + reload choreography).

---

### Pitfall 11: Stale `.next/` cache and Next.js build artifacts

**What goes wrong:**
Next.js maintains `.next/cache/` across builds for speed. After a git reset, the cache still references file paths from the previous SHA. Usually this is fine (Next.js invalidates intelligently). Sometimes it isn't:
- Node version changed between builds → cache contains compiled artifacts incompatible with the new Node.
- A previous build crashed mid-write, leaving a corrupted cache file.
- Orphaned server files in `.next/server/` from a previous build layout that the new build doesn't overwrite.
- Next.js 15 sometimes leaves `.next/cache/webpack/` entries that reference deleted files.

The failure mode: `pnpm build` succeeds, but `pnpm start` crashes with `Cannot find module './chunks/xxx.js'` or similar path errors at runtime.

**Why it happens:**
Build caches are optimization-focused and assume a well-behaved development loop, not an arbitrary git-reset-and-rebuild workflow.

**How to prevent it (actionable):**
1. **`rm -rf .next` before every `pnpm build` in the updater pipeline.** Non-negotiable. Cache rebuild cost is 15-30 seconds, which is insignificant compared to correctness.
2. Do not rely on `.next/cache/`. It's an optimization for dev loops, not production deploys.
3. If using the symlink-swap pattern from Pitfall 6, each release directory has its own isolated `.next/`, and this problem disappears entirely.
4. **After `pnpm build`, sanity-check**: confirm `.next/BUILD_ID` exists and `.next/server/app/api/version/route.js` (or equivalent) exists before calling the build successful.

**Warning sign:**
`Cannot find module` errors at runtime after an apparently successful build.

**Phase to address:** Phase 2 (pipeline).

---

### Pitfall 12: systemd restart loop on bad commit

**What goes wrong:**
Update applies a commit that crashes on boot (e.g., a typo in a top-level module import, or a missing environment variable check). systemd tries to start it, it crashes, systemd restarts it (per `Restart=on-failure`), it crashes again. Default `StartLimitBurst=5` within `StartLimitIntervalSec=10s` means systemd gives up after 5 crashes in 10 seconds and marks the unit `failed`.

But — the updater script already exited after calling `systemctl restart charging-master.service` and seeing it "start". If the crash happens *after* systemd reported the unit as active, the updater thinks success and doesn't roll back. The service is then stuck in `failed` state indefinitely.

Worse variant: `Restart=always` without rate limits → the service thrashes forever, eating CPU, filling journal, and never triggering rollback.

**Why it happens:**
`systemctl restart` returns as soon as the unit is "active", not after it's proven stable. `Type=simple` services are marked active the instant the process is spawned, before any application-level initialization.

**How to prevent it (actionable):**
1. **Use `Type=notify` on the main service**, and have the Node process call `sd_notify(READY=1)` only after it has opened the DB, initialized the HTTP client for Shelly, and bound the port. The `systemctl restart` call then blocks until ready or timeout. Alternatively, since this is Next.js + tsx, use a readiness file touch from inside the app and have the updater wait for it.
2. **The updater script does NOT trust `systemctl restart` return.** After the restart, it polls `http://localhost:3000/api/version` for up to 60 seconds. Only after receiving `HTTP 200` with the expected new SHA does it declare success. If the poll times out or returns an unexpected SHA (still the old one, or an error), trigger rollback.
3. **Set sane systemd restart limits:** `Restart=on-failure`, `RestartSec=2s`, `StartLimitIntervalSec=60`, `StartLimitBurst=3`. After 3 failures in 60 seconds, the unit enters `failed` and stops thrashing. The updater's health-check loop will detect this (the `/api/version` poll will never succeed) and trigger rollback before systemd even gives up.
4. **Rollback trigger must survive unit `failed` state.** Since the updater is a *separate* unit (Pitfall 1), it can observe the main unit's state via `systemctl is-failed charging-master.service` and act even if the main unit is thoroughly dead.

**Warning sign:**
`systemctl status charging-master` shows `failed` state, or `systemctl show charging-master -p NRestarts` shows a high count after an update.

**Phase to address:** Phase 3 (health check + rollback) — explicit design requirement, not a footnote.

---

### Pitfall 13: Permissions drift — updater runs as a different user than the main service

**What goes wrong:**
Common pattern: main `charging-master.service` runs as `User=charging` (non-root). The updater is given more privileges (needs to call `systemctl`, maybe needs `sudo`). If the updater runs as `root`, `pnpm install` creates files in `node_modules/` owned by root. The main service (running as `charging`) then can't read/execute them, or writes to `.next/cache/` fail with EACCES.

Alternatively: everything runs as root (simpler on LXC, which this project uses). Then `pnpm install` warnings about running as root get ignored, some postinstall scripts refuse to run without `--unsafe-perm`, and better-sqlite3 may skip native build steps.

**Why it happens:**
LXC containers are often run as root by default, so developers don't think about user separation. When they eventually do (for polkit reasons), they retrofit it and forget about file ownership.

**How to prevent it (actionable):**
1. **Decide user strategy up front.** For this single-user LAN LXC app, running as root is acceptable (constraint: "Root-Zugang via SSH", already rooted). Document this decision and lock it in. Both `charging-master.service` and `charging-master-updater.service` run as root (`User=root`). All files in `/opt/charging-master/` are owned by root.
2. If a non-root user is chosen later, both units must use the same `User=` and `Group=`, and `/opt/charging-master/` ownership must be set accordingly.
3. **Never `chown` files inside the updater script** based on assumptions about which user "should" own them. This masks the real problem.
4. **After `pnpm install`, verify binding readability:** `stat node_modules/better-sqlite3/build/Release/better_sqlite3.node` and check mode bits. If not readable by the service user, abort.

**Warning sign:**
`EACCES` errors in journalctl after an update. Files in `node_modules/` with unexpected ownership.

**Phase to address:** Phase 1 (systemd units — decide + document).

---

### Pitfall 14: Disk full during git fetch or pnpm install

**What goes wrong:**
LXC containers often run with limited disk. A `pnpm install` can briefly use 2-3x the size of `node_modules/` (store + extracted + old + new). A `git fetch` on a busy repo can pull hundreds of MB of pack files. If disk fills mid-operation:
- `pnpm install` errors with ENOSPC, partially-written `node_modules/` state.
- `git fetch` errors with "fatal: sha1 file '.git/objects/pack/...' write error: No space left on device" and leaves the repo in a half-fetched state where subsequent fetches may fail in confusing ways.
- The snapshot tarball from Pitfall 7 can't even be written, so rollback has no escape hatch.

**Why it happens:**
Developers don't check disk space before operations that write a lot. "It worked on my 500GB laptop" ≠ "it works on an 8GB LXC".

**How to prevent it (actionable):**
1. **Pre-flight disk check.** Updater script runs `df -k /opt/charging-master` first. Require at least `3 * (size of current node_modules + .next)` free. Refuse with clear message if not.
2. **Clean up before fetching.** Run `pnpm store prune` and `git gc --auto` early in the pipeline. Cheap, reduces footprint.
3. **Snapshot tarball goes to a different filesystem than the working tree** if possible (e.g., `/var/lib/charging-master/snapshots/`). If disk fills during forward install, the rollback tarball on a separate partition survives. On LXC with a single rootfs, this is moot but document the intent.
4. **On ENOSPC, the updater immediately triggers rollback** from the pre-made tarball (not from a git+pnpm rebuild, which will also ENOSPC). Then it emits a Pushover "disk full during update" alert so the user can SSH in and clean up.
5. **Keep N old release directories only.** If using symlink-swap pattern, prune old releases down to N=2 (current + previous) before starting a new update, to free space.

**Warning sign:**
`ENOSPC`, "No space left on device", or `df` reporting <10% free on the working volume.

**Phase to address:** Phase 2 (pre-flight checks) + Phase 3 (rollback resilience).

---

### Pitfall 15: Concurrent update triggers (double-click, overlapping background check)

**What goes wrong:**
User clicks "Update" button. Nothing visible happens for 2 seconds (updater is starting). User clicks again. Two invocations of the update flow are now racing. Or: the 6h background check fires at the same moment the user manually clicks. Same race.

Results: two `git fetch` in the same repo (git locks `.git/index.lock`, second fails), two `pnpm install` (one corrupts the other's `node_modules/`), two `systemctl restart` (benign but confusing).

**Why it happens:**
HTTP handlers are stateless; developers forget that the underlying operation isn't.

**How to prevent it (actionable):**
1. **File lock as the single source of truth.** The updater systemd unit uses `ExecStart=/usr/bin/flock --nonblock /var/lock/charging-master-update.lock /usr/local/bin/charging-master-update.sh`. If a second instance is triggered while the lock is held, flock exits immediately with code 1, the unit marks `failed` (but cleanly — no side effects).
2. **The trigger endpoint in Node checks the lock too.** Before calling `systemctl start`, it checks whether the updater unit is currently active (`systemctl is-active charging-master-updater.service`). If yes, returns `409 Conflict` to the UI with "update already in progress". The UI disables the button.
3. **Updater records state in SQLite.** A `update_runs` table with `(id, started_at, target_sha, status, ended_at)` has at most one row with `status='running'`. The trigger endpoint checks this first, before even calling systemctl. Protects against edge cases where systemd state and actual script state diverge.
4. **UI button becomes disabled immediately on click**, not after server response. Prevents the double-click trivially.
5. **Scheduled background check never auto-applies; it only *reports*.** Apply is always user-initiated. This removes the entire class of "background update fires while user is clicking".

**Warning sign:**
`fatal: Unable to create '.git/index.lock': File exists.` in updater logs, or two `update_runs` rows with `status='running'`.

**Phase to address:** Phase 2 (trigger endpoint + lock).

---

### Pitfall 16: Partial rollback — git rolls back but artifacts don't, or vice versa

**What goes wrong:**
Rollback runs `git reset --hard <old-sha>` successfully but the subsequent `rm -rf .next && pnpm install && pnpm build` fails at the build step. Now the git tree is at the old SHA, but `.next/` is either empty or contains half the new build. Service starts, Next.js crashes, systemd restart-loops.

Variant: the updater uses the snapshot tarball (Pitfall 7 stage 2) to restore `node_modules/` and `.next/` but forgets to git-reset. Now the source files are at the new SHA but the build artifacts are for the old SHA. Runtime inconsistency.

**Why it happens:**
Rollback is a multi-step operation; each step has its own failure mode. Developers test the "happy rollback" path and forget to test "rollback fails halfway".

**How to prevent it (actionable):**
1. **Rollback is all-or-nothing and atomic where possible.** The symlink-swap pattern (Pitfall 6) makes this trivial: swap the symlink or don't. No partial state possible.
2. **Without symlink swap: three invariants that must hold together:**
   - `git rev-parse HEAD` == expected SHA.
   - `node_modules/` was produced by `pnpm install --frozen-lockfile` against **this** SHA's lockfile.
   - `.next/` was produced by `pnpm build` against **this** SHA's source.
3. **Record the "applied SHA" in a metadata file** `/opt/charging-master/.applied-sha` after a successful rollback or forward update. Health check reads it on boot and compares to `git rev-parse HEAD`; mismatch → refuse to start (`exit 1`), systemd marks `failed`, updater catches it.
4. **If rollback's build step fails, fall back immediately to the snapshot tarball.** Don't retry. Don't attempt partial states. Extract tarball, set `.applied-sha`, start service, done.
5. **Health check validates the full triplet:** DB opens, HTTP responds, `/api/version` returns the expected SHA, `.applied-sha` matches `git rev-parse HEAD`.

**Warning sign:**
Service starts but `/api/version` returns the wrong SHA, or `.applied-sha` doesn't match git state.

**Phase to address:** Phase 3 (rollback).

---

### Pitfall 17: LXC clock drift breaks GitHub ETag / rate-limit reset calculations

**What goes wrong:**
LXC containers inherit the host clock but can drift if `systemd-timesyncd` isn't enabled or the container config blocks it. Symptoms:
- `X-RateLimit-Reset` is a Unix timestamp; if our clock is 10 minutes ahead, we'll think the reset has already passed when it hasn't, and hammer the API into further rate-limit errors.
- TLS cert validation to api.github.com fails if clock skew exceeds a few minutes ("certificate is not yet valid").
- Log timestamps in journalctl are wrong, confusing debugging.

**Why it happens:**
LXC containers have weird clock-sync defaults. It's easy to deploy and not notice until something time-sensitive breaks.

**How to prevent it (actionable):**
1. **Include time sync in the deployment setup.** `systemctl enable --now systemd-timesyncd` as part of the LXC bootstrap. Verify with `timedatectl status` showing "System clock synchronized: yes".
2. **Updater script pre-flight: `timedatectl status | grep -q 'synchronized: yes'` or abort.** Blunt but effective.
3. **Don't compute "time until reset" using local clock delta; compute it by storing the *server's* `Date` response header** alongside `X-RateLimit-Reset`. If our clock drifts, the stored delta is still correct relative to GitHub's clock.
4. **TLS errors on api.github.com get a specific error message in the updater:** "clock may be skewed, check `timedatectl`".

**Warning sign:**
`certificate is not yet valid` or `certificate has expired` errors on api.github.com. `timedatectl` showing "System clock synchronized: no".

**Phase to address:** Phase 1 (bootstrap/setup docs) + Phase 1 (check endpoint defensive code).

---

### Pitfall 18: "Silent success" — systemd says active but the new code is broken

**What goes wrong:**
Worst class of failure: updater runs perfectly, `systemctl restart charging-master.service` succeeds, `systemctl status` reports `active (running)`, updater declares success, rollback doesn't trigger. But actually:
- Next.js bound the port but the API routes throw 500 on every request.
- The DB connection failed silently and the app serves stale cached HTML.
- The new code has a bug that only manifests when a real charge session is active.
- The app works for `/` but not for `/api/version` (e.g., because a new environment variable is missing).

From the outside (the updater's perspective), everything looks fine. From the user's perspective, the app is broken.

**Why it happens:**
"Service is active" ≠ "service is healthy". Developers conflate the two. systemd has no application-level health check built in.

**How to prevent it (actionable):**
1. **Mandatory post-restart health check in the updater.** After `systemctl restart`, poll `http://localhost:3000/api/version` every 1 second for up to 60 seconds. Required conditions for success:
   - HTTP 200.
   - Response body includes `sha` matching the target.
   - Response body includes `db: "ok"`.
   - Response body includes `uptime` > 2 seconds (to ensure it's really the new process, not leftover from before).
2. **The `/api/version` endpoint must itself exercise the critical dependencies.** It SELECTs from SQLite, it reads the pnpm-installed version of `better-sqlite3`, it confirms the Shelly HTTP poller loop started. If any fail, it returns HTTP 503 with a diagnostic. **This is not a static SHA endpoint; it's a health probe.**
3. **Deeper smoke test endpoint** `/api/version/smoke` that does a read-only exercise of the core feature paths (list devices, read latest sample, etc.). Updater calls this as a second-stage health check. If it fails, rollback.
4. **On health check failure, the updater rolls back immediately** without waiting for user input. The rationale: if we got this far and the new version is broken, the user is staring at a dead UI. Rollback and send Pushover notification.
5. **`sd_notify(READY=1)` only after all health conditions are met**, not after `server.listen()`. Combined with `Type=notify`, systemd itself will refuse to declare the unit "active" until the app is actually ready. (Dovetails with Pitfall 12.)

**Warning sign:**
User reports "I clicked Update, it said success, but the app is broken".

**Phase to address:** Phase 3 (health check) — this IS the reason Phase 3 exists.

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Inline `child_process.exec` instead of separate systemd unit | One file change, ~20 lines | Pitfall 1 (kill-your-parent), the entire v1.2 rots | **Never** for this feature |
| Skip the snapshot tarball escape hatch, rely on git+pnpm rollback only | Simpler pipeline | No recovery when network/disk fails mid-update | Acceptable only if a second rollback path exists (e.g., symlink swap) |
| No post-restart health check ("systemctl says active, good enough") | 30 fewer lines of code | Pitfall 18 silent failures, user loses trust in auto-update | **Never** |
| Use `git pull` instead of fetch+reset to explicit SHA | One command simpler | Pitfall 9 (stale diff), race condition on concurrent pushes | **Never** in automation |
| Polling GitHub without ETag support | 5 fewer lines of code | Rate-limit failures in weeks, visible UI breakage | Acceptable only with <12/day total polls from LXC and no browser tabs adding load |
| Symlink swap not used; overwrite in place | Fits existing directory layout | Pitfall 16 partial rollback, complicated recovery | Acceptable if snapshot tarball fallback is solid |
| Run both services as root | No user/permission questions | Pitfall 13 deferred, broader blast radius | Acceptable for this single-user LXC LAN-only app (documented in STACK) |
| `/api/version` as static SHA only (no DB probe) | Simpler endpoint | Pitfall 18 silent success | **Never** |
| Allow auto-apply of migrations in v1.2 | Simpler "it just works" UX | Pitfall 3 schema/WAL mismatch, data loss risk | **Never** in v1.2; defer to v1.3 with explicit migration tooling |
| Run updater as a child process of the Node app | Trivial to implement | Pitfall 1, project-ending | **Never** |

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| GitHub REST API | Polling without ETag, hitting 60/h limit | Cache ETag, use `If-None-Match`, 304s are free; also rate-limit server-side to >=5 min between calls |
| GitHub REST API | Trusting `origin/main` symbolic ref in updater | Resolve to explicit SHA in check endpoint, pass SHA to updater, `git reset --hard <sha>` not `<branch>` |
| systemd | `systemctl restart` returns success before app is ready | `Type=notify` + `sd_notify(READY=1)` after DB open; OR poll `/api/version` for up to 60s |
| systemd | `Restart=always` without rate limits | `Restart=on-failure` + `StartLimitBurst=3` + `StartLimitIntervalSec=60` |
| systemd | Triggering updater via `child_process` in Node | Use `systemctl start --no-block charging-master-updater.service` via `execFile`, never shell |
| pnpm | `pnpm install` without `--frozen-lockfile` in updater | Always `--frozen-lockfile`; lockfile drift is a blocker, not a warning |
| pnpm@10 + better-sqlite3 | "Could not locate the bindings file" after install | `pnpm approve-builds` on deploy; `pnpm rebuild better-sqlite3` after install as belt-and-braces |
| git | `git reset --hard` in a dirty tree silently discards changes | `git status --porcelain` pre-check; explicit error if dirty |
| git | Leftover `.git/rebase-merge/` or `.git/MERGE_HEAD` from prior interrupted op | Check for in-progress states before reset; abort with clear error |
| Next.js | `.next/cache/` not invalidated across git SHAs | `rm -rf .next` before every `pnpm build` in the updater |
| SQLite / better-sqlite3 | Stop service mid-transaction, lose uncommitted data | Pre-shutdown HTTP endpoint forces `PRAGMA wal_checkpoint(TRUNCATE)` + commits open txns before stop |
| SSE | Browser auto-reconnects to new server without knowing it's a new version | `X-App-Version` header or first SSE event carries SHA; client reloads on mismatch |
| Pushover (in updater) | Relying on Node app to send "update failed" notification | Updater shell script calls `curl` directly to api.pushover.net so it works even when Node is dead |
| LXC | Clock drift breaks TLS to api.github.com | `systemctl enable --now systemd-timesyncd`; updater pre-flight checks `timedatectl` |

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Polling GitHub on every browser page load | Rate limit exhaustion within hours | Server caches result; browser only reads cache | First day of deployment if multiple browser tabs |
| SSE stream of journalctl without backpressure | Memory balloon in Node when user opens update log and leaves tab | Use `journalctl --since=...` with a cursor, not `-f` from the start; cap buffered lines | Long updates (>5 min) |
| Unbounded `update_runs` table growth | SQLite slowly grows, queries on "latest run" slow | `DELETE FROM update_runs WHERE id NOT IN (SELECT id FROM update_runs ORDER BY id DESC LIMIT 50)` after each run | After months of updates |
| Re-running `pnpm install` without `--prefer-offline` | Slow updates, unnecessary network use | `--frozen-lockfile --prefer-offline` | Every update when network is slow |
| `git fetch` without depth limits on a large repo | Pulls full history every update | `git fetch --depth=50` is enough to see last 50 commits; or fetch shallow initially and unshallow only if needed | Repo history > 100MB |

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| Update trigger endpoint exposed on LAN without auth | Any LAN device can force-restart the app | Already single-user LAN app (per PROJECT.md constraint), but bind `/api/updater/*` to `127.0.0.1` only, or add a shared-secret header for defense in depth |
| Updater runs `git pull` from an unverified remote URL | Supply-chain compromise if remote URL is ever mutated | Pin remote URL at deploy time; updater never rewrites `.git/config`; verify `git remote get-url origin` matches expected before fetch |
| Pushover token hardcoded in git repo | Anyone with read access to GitHub repo can spam the user | Store in a config file gitignored (e.g., `/etc/charging-master/secrets.env`), loaded by systemd unit via `EnvironmentFile=` |
| Updater runs arbitrary shell from GitHub response | RCE if GitHub response is ever spoofed (MITM on compromised network) | Updater only consumes `sha` field from GitHub response; never executes content from the response; TLS validates api.github.com cert (requires correct clock, see Pitfall 17) |
| No SHA allowlist on the target commit | If the GitHub repo is compromised, any pushed commit auto-applies | Accept the risk (single-user LAN, user controls the repo), OR require manual commit review before each update (user-initiated click already provides this) |
| `journalctl` SSE stream leaks sensitive env vars | Unit logs may contain secrets (Pushover token) | systemd unit uses `LogLevelMax=notice`; scrub `Environment=` values from logs; never `echo $TOKEN` in the updater script |

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| "Update available" badge shown but clicking does nothing for 10s | User thinks it's broken, clicks again → double trigger | Immediate UI state change on click: button disabled, spinner, "Starting updater..." text; backend returns 202 Accepted, not the full result |
| Update failed with cryptic pnpm error | User doesn't know what to do | Classify errors in the updater: `lockfile_incompatible`, `build_failed`, `health_check_failed`, etc. Show friendly message + "See logs" link |
| No indication the UI is showing stale version post-update | User thinks update did nothing | Auto-reload on version mismatch (Pitfall 10); explicit "You're on the new version: `<sha>` since `<time>`" banner on first load |
| Rollback succeeds silently, user never knows the update was rejected | User thinks they got new features, bugs silent | On rollback, show persistent banner "Update to `<sha>` failed, rolled back to `<old-sha>`. [See log]" that the user must dismiss |
| Update starts during an active charge session without warning | Charge interrupts, session data may be lost | UI warns: "Active charge session on [device]. Updating will interrupt charging. Apply anyway?" with a "Stop charging first" button |
| "Check for updates" button hits GitHub immediately on every click | Rate limit exhaustion in dev/testing | Button is debounced to once per 5 minutes; shows "Next check available in 4:23" when throttled |
| Progress bar that doesn't reflect real phases | User panics at 95% stall (during slow `pnpm install`) | Named phases with timestamps: "Fetching (0:03)... Installing (1:42)... Building (0:58)... Restarting (0:08)..." — time since phase start, not percentage |
| SSE log stream shows raw journalctl with ANSI color codes | Garbled output | Strip ANSI codes in the stream handler before emitting to client |

## "Looks Done But Isn't" Checklist

- [ ] **Updater trigger:** Does it survive restart of the main service? Verify by tailing `journalctl -u charging-master-updater` while `charging-master` is restarted — updater must continue.
- [ ] **Health check:** Does `/api/version` actually probe the DB, or just return a hardcoded SHA? Break the DB file temporarily, request `/api/version`, must return 503.
- [ ] **Rollback:** Does rollback run the FULL pipeline for the old SHA (install + build + restart), not just git reset? Inject a broken `pnpm build` in a test commit, verify rollback reinstalls+rebuilds old.
- [ ] **Rollback rollback:** If rollback fails, does the snapshot tarball path execute? Inject two consecutive failures, verify stage-2 escape hatch runs.
- [ ] **ETag caching:** Does the update check return 304 on unchanged state? Check server logs — should see 304s, not 200s, on repeat calls.
- [ ] **Rate limit headers:** Does the server read and respect `X-RateLimit-Remaining`? Simulate low remaining, verify server backs off.
- [ ] **File lock:** Triggering update twice in a row — does the second attempt return 409? Test with `curl` back-to-back.
- [ ] **SSE reconnect:** After restart, does the browser UI auto-reload to the new version? Watch browser console during a test update.
- [ ] **Bindings after install:** Does `node_modules/better-sqlite3/build/Release/better_sqlite3.node` exist after `pnpm install`? Check before marking install successful.
- [ ] **SHA propagation:** Does the SHA the user clicked on match the SHA the updater applies? Log both, compare.
- [ ] **Clock sync:** Is `systemd-timesyncd` active on the LXC? `timedatectl status` must show synchronized.
- [ ] **Disk pre-flight:** Does the updater refuse to start with <3x node_modules+.next free space? Simulate with a bind mount.
- [ ] **Concurrent trigger:** Two simultaneous "Update" clicks from two browser tabs — only one update runs? Verify via `update_runs` table.
- [ ] **Migration gate:** Does the updater refuse to auto-apply commits that touch `drizzle/` migrations in v1.2? Test with a dummy migration commit.
- [ ] **PANIC marker:** Does total failure leave a PANIC file AND send a Pushover alert? Simulate both forward and rollback failing.
- [ ] **No secrets in logs:** Is the Pushover token ever printed in `journalctl -u charging-master-updater`? Grep the output.
- [ ] **After-restart SHA in response:** Does `/api/version` return the new SHA after restart completes? Verify via curl.
- [ ] **`.next` blown away:** Does the updater `rm -rf .next` before every build? Check script.

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| P1 kill-your-parent: half-installed `node_modules` | MEDIUM | SSH in; `cd /opt/charging-master; rm -rf node_modules .next; git status; git reset --hard <known-good-sha>; pnpm install --frozen-lockfile; pnpm build; systemctl start charging-master` |
| P2 pnpm install race: corrupted bindings | LOW | `pnpm rebuild better-sqlite3`; restart service |
| P3 SQLite WAL mismatch after migration | HIGH | Restore `charging.db.backup-<sha>` from Pitfall 3 step 4; restart |
| P4 git in-progress state | LOW | SSH in; `git rebase --abort` or `git merge --abort` or delete `.git/MERGE_HEAD`; manual reset |
| P5 lockfile incompatible | LOW | Upgrade pnpm on LXC (`corepack prepare pnpm@<newver> --activate`); retry update |
| P6 build failed mid-update | MEDIUM | Rollback should handle; if not, manual `rm -rf .next node_modules; pnpm install --frozen-lockfile; pnpm build; systemctl start` |
| P7 rollback catastrophe | HIGH | SSH; restore snapshot tarball from `/var/lib/charging-master/snapshots/*.tgz`; `systemctl start` |
| P8 rate limited | LOW | Wait for reset (max 1h); optionally add PAT to raise to 5000/h |
| P9 stale check | LOW | User re-checks, re-confirms the new SHA |
| P10 browser showing old version | LOW | Hard refresh (Ctrl+F5) |
| P11 `.next` stale | LOW | `rm -rf .next; pnpm build; systemctl restart` |
| P12 restart loop | MEDIUM | Rollback (should be automatic); if stuck in `failed` state, `systemctl reset-failed charging-master; systemctl start charging-master-updater` with rollback target |
| P13 permission drift | MEDIUM | `chown -R root:root /opt/charging-master` (or chosen user) and restart |
| P14 disk full | HIGH | SSH; `pnpm store prune; git gc; rm -rf /tmp/*; systemctl start`; may need to delete old snapshots |
| P15 concurrent updates | LOW | File lock prevents it; if observed, kill one updater unit, let the other continue |
| P16 partial rollback | HIGH | Extract snapshot tarball; re-run health check; restart |
| P17 clock drift | LOW | `systemctl restart systemd-timesyncd; timedatectl status` |
| P18 silent success → broken app | MEDIUM | Rollback should catch it; if not, manual rollback via snapshot tarball |

## Pitfall-to-Phase Mapping

Assuming a 4-phase roadmap for v1.2. **Phase numbers are the roadmapper's to assign; shown here as named buckets.**

| Pitfall | Phase | Verification |
|---------|-------|--------------|
| P1 kill-your-parent | **Phase 1 (Foundations & Updater Unit)** | Test: trigger update from Node, then `kill -9` the Node process — updater script continues running in its own cgroup |
| P2 pnpm install races | **Phase 2 (Pipeline)** | Test: confirm main service is stopped before `pnpm install` in pipeline script |
| P3 SQLite during update | **Phase 2 (Pipeline)** + **Phase 3 (Health/Rollback)** | Test: run update during active charge session, verify WAL checkpoint runs and no data lost |
| P4 git state corruption | **Phase 2 (Pipeline)** | Test: leave uncommitted file, trigger update, must abort with clear error |
| P5 pnpm-lock drift | **Phase 1 (Check endpoint / compat check)** | Test: bump pnpm version in `packageManager`, check endpoint flags incompatibility |
| P6 build failure mid-update | **Phase 2 + 3** | Test: inject TS error in test commit, update triggers, rollback succeeds |
| P7 rollback itself fails | **Phase 3 (Rollback + escape hatch)** | Test: disable network after forward install, rollback must use snapshot tarball |
| P8 GitHub rate limit / ETag | **Phase 1 (Check endpoint)** | Test: repeat check 20 times in 5 min, verify only N hit GitHub, rest return cached |
| P9 stale check results | **Phase 1 + Phase 4 (UI)** | Test: check, push new commit, click update, UI must prompt re-confirm |
| P10 SSE stream during restart | **Phase 4 (UI + reload choreography)** | Test: trigger update, verify browser auto-reloads to new SHA |
| P11 stale `.next` cache | **Phase 2 (Pipeline)** | Test: `rm -rf .next` must be in the script before every build |
| P12 systemd restart loop | **Phase 1 (unit definitions)** + **Phase 3 (health check)** | Test: deploy a crashing build, verify updater detects failed health check and rolls back before systemd `StartLimitBurst` exhausts |
| P13 permission drift | **Phase 1 (unit definitions)** | Test: document user strategy in unit files; verify file ownership after install |
| P14 disk full | **Phase 2 (pre-flight)** | Test: fill disk to 90%, trigger update, must refuse |
| P15 concurrent triggers | **Phase 2 (trigger endpoint + flock)** | Test: two parallel curl to trigger endpoint, second returns 409 |
| P16 partial rollback | **Phase 3 (rollback + atomicity)** | Test: kill rollback mid-pnpm-install, verify stage-2 snapshot recovery runs |
| P17 clock drift | **Phase 1 (setup docs + pre-flight)** | Test: set clock 10 min off, trigger update, should warn and fail fast |
| P18 silent success | **Phase 3 (health check)** | Test: deploy a build where `/api/version` returns 503, updater must detect and rollback |

### Suggested Phase Shape (for the roadmapper)

1. **Phase 1 — Foundations:** Version endpoint + DB schema for `update_runs` + GitHub check with ETag + systemd unit files (both `charging-master.service` and `charging-master-updater.service`) + pre-flight compat checks (pnpm/Node/clock/disk). Addresses P1, P5, P8, P12, P13, P17.
2. **Phase 2 — Updater Pipeline:** The shell script + trigger endpoint + file lock + pre-shutdown drain hook + install/build/restart sequence + snapshot tarball creation. Addresses P2, P3 (partial), P4, P6 (partial), P11, P14, P15.
3. **Phase 3 — Health Check & Rollback:** Post-restart `/api/version` polling + DB-open probe + `.applied-sha` metadata + rollback pipeline + stage-2 tarball escape hatch + PANIC + Pushover from shell. Addresses P3 (remainder), P6 (remainder), P7, P12, P16, P18.
4. **Phase 4 — UI + SSE Choreography:** Settings page update card + live log via SSE + version mismatch auto-reload + stale-check re-confirm + progress phases. Addresses P9, P10, and all UX pitfalls.

## Sources

- [Rate limits for the REST API — GitHub Docs](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api) — HIGH confidence, official, confirms 60/h unauth, ETag+304 don't count, `X-RateLimit-*` headers.
- [systemd.service manpage (Debian)](https://manpages.debian.org/experimental/systemd/systemd.service.5.en.html) — HIGH, official, `Type=notify`, `sd_notify`, restart policies.
- [systemd-run manpage (freedesktop)](https://www.freedesktop.org/software/systemd/man/latest/systemd-run.html) — HIGH, official. Confirms `--scope` runs as child of caller (bad for our use case), `systemctl start --no-block` for independent units (good).
- [systemd restart policies & StartLimitBurst — Michael Stapelberg (2024)](https://michael.stapelberg.ch/posts/2024-01-17-systemd-indefinite-service-restarts/) — MEDIUM, well-reasoned, covers restart-loop failure modes.
- [Running Node.js on Linux with systemd — CloudBees](https://www.cloudbees.com/blog/running-node-js-linux-systemd) — MEDIUM, general patterns.
- [SQLite WAL mode docs](https://sqlite.org/wal.html) — HIGH, official. Recovery semantics, checkpoint mechanics, `wal_checkpoint(TRUNCATE)`.
- [SQLite forum: Why data is lost in WAL when connection not closed cleanly](https://sqlite.org/forum/info/b080c1d935a7ba82) — HIGH, SQLite authors' own answers.
- [SQLite forum: How corruption happens during WAL checkpoint](https://sqlite.org/forum/info/47107ab818977549) — HIGH.
- [pnpm issue #9073 — better-sqlite3 native bindings](https://github.com/pnpm/pnpm/issues/9073) — MEDIUM, known pnpm@10 issue, workaround via `pnpm approve-builds` / `pnpm rebuild`.
- [better-sqlite3 issue #1378 — "Could not locate the bindings file" with pnpm 10](https://github.com/WiseLibs/better-sqlite3/issues/1378) — MEDIUM, directly applicable to our stack.
- [better-sqlite3 troubleshooting guide — Trilium docs](https://docs.triliumnotes.org/developer-guide/troubleshooting/better-sqlite3) — MEDIUM, "compiled against a different Node.js version" recovery.
- [git-reset docs](https://git-scm.com/docs/git-reset) — HIGH, official, behavior on untracked files and in-progress ops.
- [Git undoing and recovering — CodeRefinery](https://coderefinery.github.io/git-intro/recovering/) — MEDIUM, reflog safety net.
- [Next.js SSE discussion #48427](https://github.com/vercel/next.js/discussions/48427) — MEDIUM, SSE in Next.js 15 App Router, restart semantics.
- [reconnecting-eventsource npm](https://www.npmjs.com/package/reconnecting-eventsource) — MEDIUM, drop-in reconnecting wrapper.
- [Pushover API](https://pushover.net/api) — HIGH (per existing STACK.md research), confirms `curl` from shell is trivial.
- [MDN — Using server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events) — HIGH, browser auto-reconnect semantics.

---
*Pitfalls research for: Milestone v1.2 Self-Update (Node.js + Next.js 15 + systemd + better-sqlite3 + pnpm@10 + git + GitHub API + SSE)*
*Researched: 2026-04-10*
