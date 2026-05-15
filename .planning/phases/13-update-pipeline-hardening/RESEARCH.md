# Phase 13 Research — Update Pipeline Hardening

**Researched:** 2026-05-15
**Domain:** Bash self-update script + Next.js 15 API routes + React 19 server/client component admin page
**Confidence:** HIGH (all critical findings verified against project source; external claims cited)

## TL;DR

- **PIPE-01 quarantine** must use `git status -z --porcelain` (NUL-terminated) and a small bash loop, NOT a `grep -vE`-style filter — the existing `preflight_git` allowlist at `run-update.sh:273` already shows we cannot trust newline-delimited porcelain output once filenames contain spaces. Mirror the snapshot retention pattern (`ls -1t ... | tail -n +${RETAIN}`, `run-update.sh:290`).
- **PIPE-02 on_error state reset** is one extra `state_set_*` helper call plus a behavior decision: the trap at `run-update.sh:566–601` already self-disables (`trap - ERR` on line 576), so a single new `state_set_idle_clearing_inprogress` Python heredoc invocation slots in before each `exit 1` branch — no recursion risk.
- **PIPE-03/04** are mostly mechanical copy-pastes of audited project patterns: host-guard from `prepare-for-shutdown/route.ts:15–49` (server-to-server flavor, NOT the LAN browser flavor) for the internal reset endpoint; `isAllowedBrowserHost` from `host-guard.ts:41` for the admin DELETE. The admin page is the project's FIRST server component that lists a filesystem directory, but the `update_runs.status` column is plain `text NOT NULL` with no DB-side check constraint (only a Drizzle TS enum, `schema.ts:245–247`), so adding `'recovery_reset'` is **TypeScript-only** — no migration needed.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Untracked-file quarantine (move to `.update-state/quarantine-*/`) | Bash updater script | — | The script runs as root with full filesystem rights, before the app process is even drained. Doing it in Node would require an HTTP round-trip the script doesn't currently make. |
| Surface `lastQuarantine` in `state.json` | Bash updater script (write) + Node API (read) | — | Same boundary as existing `state_set_*` helpers (`run-update.sh:137–189`). The Python heredoc atomic-write pattern is the only sanctioned shape. |
| on_error reset of `updateStatus` | Bash updater script (`on_error` trap) | — | Has to happen even when the Node service is stopped/crashed. State.json is the lingua franca (per `update-state-store.ts:30–32`). |
| Recovery endpoint `/api/internal/reset-update-state` | API / Backend (Next.js route handler) | — | Server-to-server endpoint, called from inside the LXC via `curl localhost`. Mirrors `/api/internal/prepare-for-shutdown` (`prepare-for-shutdown/route.ts:70`). |
| Admin quarantine page `/settings/update-state` | Frontend Server (RSC) for the file listing | Browser/Client (`'use client'` for delete-button mutation) | Read = server component (FS access, no client JS bundle). Write = server action OR a separate `DELETE` route + small client component, mirroring the pattern in `update-banner.tsx:218` where a client component POSTs to an internal endpoint. |
| Banner quarantine info state | Browser/Client | — | Same `UpdateBanner` client component that already discriminates 5 states (`update-banner.tsx:242–495`). |

## User Constraints (from CONTEXT.md)

### Locked Decisions (already in CONTEXT.md §"Design decisions to lock during planning")

1. Quarantine retention = 3 dirs (mirror existing `SNAPSHOT_RETAIN=3` from `run-update.sh:35`).
2. Quarantined files do NOT survive Stage-2 tarball rollback (by design ephemeral; tarball excludes `.update-state/snapshots` but the script does NOT exclude `.update-state/quarantine-*/`. CONTEXT decision says quarantine is ephemeral → this is fine; the next preflight prunes anyway). **VERIFY in plan**: explicitly add `--exclude='./.update-state/quarantine-*'` to `do_snapshot()`'s tar invocation so a snapshot does not bloat with quarantined files. [VERIFIED: `run-update.sh:298–305`]
3. Mixed M+?? = FATAL (any non-`??` line aborts). Document inline.
4. Reuse python3 heredoc + `os.replace` pattern (`run-update.sh:137–189`).
5. Admin page route = `/settings/update-state`. NOT in nav. LAN-only deployment is the auth model.
6. Reset endpoint side-effects = state.json reset + `update_runs` audit row only. Single-purpose.

### Claude's Discretion

- Choice of server action vs. `DELETE` route for the admin "Alle löschen" button.
- Exact field order in `lastQuarantine` (CONTEXT specifies `{ timestamp, fileCount, path }` — keep as-is for predictability).
- How the banner's `lastQuarantine` info state slots into the existing priority order in `update-banner.tsx`.
- Test-harness shape for the new bash logic (extend `dry-run-helpers.sh` vs new file).

### Deferred Ideas (OUT OF SCOPE)

- Modifying two-stage rollback (Stage 1 git-reset + Stage 2 tarball).
- Streaming preflight diagnostics to UI live (existing SSE log endpoint already covers it).
- Per-file quarantine content viewer.
- Auto-cleanup after N days.
- Migrating older `state.json` schemas.

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| PIPE-01 | Updater preflight quarantines untracked-only files, continues; modified-tracked stays fatal; new `state.json.lastQuarantine` field. | `git status --porcelain -z` ([CITED: git-scm.com/docs/git-status]); existing retention pattern at `run-update.sh:290`; existing python3 atomic-write pattern at `run-update.sh:137–189` for the state.json field write. |
| PIPE-02 | `on_error` trap ALWAYS resets `updateStatus="idle"` and clears `inProgressUpdate` before `exit 1`. | Existing trap at `run-update.sh:566–601` already self-disables (`trap - ERR` line 576) → no recursion risk. New `state_set_idle_clearing_inprogress` helper using same python3 pattern. |
| PIPE-03 | UpdateBanner gets quarantine info state; new admin page `/settings/update-state` lists files + "Alle löschen". | `update-banner.tsx` state machine at `update-banner.tsx:242–495`. New page mirrors `settings/page.tsx:37–92`. Client mutation pattern matches `handleAckRollback` at `update-banner.tsx:218–231`. |
| PIPE-04 | New `POST /api/internal/reset-update-state` — localhost-only, flips `updateStatus → idle`, clears `inProgressUpdate`, writes audit row to `update_runs`. | `prepare-for-shutdown/route.ts:15–49` for the EXACT localhost guard (NOT the LAN browser variant). `update_runs.status` is plain text (`schema.ts:245–247` enum is TS-only) — no migration to accept `'recovery_reset'`. |

## Summary

The phase splits cleanly along the existing tier boundaries already used by Phases 9 and 10. The bash script gets two surgical changes (PIPE-01 quarantine, PIPE-02 on_error reset), both extending patterns that are already present in `run-update.sh` (snapshot retention, python3 atomic state writes, trap-self-disable). The Next.js side adds one new internal endpoint (PIPE-04), one new browser-facing DELETE endpoint, one new server-component admin page, and one new info state in the existing `UpdateBanner` client component (PIPE-03). The most subtle decision is on the bash side: parsing `git status --porcelain` is a known minefield with filenames-with-spaces (and quoted output), so the plan MUST use `-z` NUL-terminated output and a `while read -d ''` bash loop.

**Primary recommendation:** Plan PIPE-02 first (smallest blast radius, unblocks recovery without any new endpoints), then PIPE-01 (depends on `state_set_*` helpers existing), then PIPE-04 (independent), then PIPE-03 (depends on `lastQuarantine` field shipped via PIPE-01 + the server-only admin DELETE endpoint).

## Pitfalls (numbered list — gotchas the planner MUST avoid)

1. **NEVER use `grep -vE` on newline-delimited `git status --porcelain` output.** The current `preflight_git` at `run-update.sh:273` does this and is the literal source of the 2026-05-15 incident's brittleness. A filename containing a newline (rare but legal on POSIX), or a quoted-filename, breaks line-by-line parsing. Use `git status -z --porcelain` (NUL-terminated) + `while IFS= read -r -d '' entry; do ... done < <(git status -z --porcelain)`. The `-z` form ALSO disables the C-string quoting that default porcelain applies to filenames with spaces/tabs, so the entry bytes are the raw filename. [CITED: git-scm.com/docs/git-status `-z` semantics]

2. **`git status -z` rename entries have a different shape.** Default porcelain: `R  orig -> new`. `-z` porcelain: `R  new\0orig\0`. Rename codes (`R*`, `C*`) consume TWO NUL-terminated tokens. Since quarantine only acts on `??` (untracked), and ANY rename code is fatal under our policy, the simplest robust parse is: peek the first two bytes of each NUL-terminated token; if they are NOT exactly `?? `, abort fatally with the existing `die`. We never need to consume a rename's second token because we abort on the first. [CITED: git-scm.com/docs/git-status `-z` rename order]

3. **Status codes that look "safe" but are NOT untracked-only**:
   - `!!` = ignored. Should never appear because `--ignored` is off by default — but if a future flag flip introduces them, they should be NO-OP (already not tracked, no quarantine needed). Safest plan: only act on EXACTLY `?? `; treat `!!` as fatal-or-skip (recommend: skip + log) to be defensive.
   - `AM` / `MM` / `RM` etc. — second char `M` looks like "modified working tree" which sounds like just-edited-an-untracked-file, but the FIRST char being a letter means the index has changes. Fatal under our policy.
   - ` M` (space + M) — unstaged modification of a tracked file. FATAL.
   - `M ` (M + space) — staged modification, no working-tree drift. FATAL (this is exactly the "real risk" CONTEXT calls out).
   - Unmerged codes (`DD`, `AU`, `UD`, `UA`, `DU`, `AA`, `UU`) — all FATAL; the working tree has conflicts and `git reset --hard` could lose work.

4. **`mkdir -p` race-condition is non-existent here.** The script holds `flock -n 9` on the global lock file from `run-update.sh:71–80` for its entire duration. Parallel updater runs cannot interleave. `mkdir -p` is also itself atomic on Linux (POSIX `mkdir()` either succeeds or `EEXIST`, and `-p` swallows `EEXIST`). No retry loop needed. **However**: the timestamp seconds-resolution could in theory produce two quarantine dirs with the same `YYYYMMDD-HHMMSS` if the script is re-triggered within the same second. Mitigate by using `date +%Y%m%d-%H%M%S-%N` (nanoseconds) OR by appending `$$` (PID). Recommend `%Y%m%d-%H%M%S` plus a `-tryN` suffix if the dir already exists — cleaner than nanoseconds across distros.

5. **`mv` of an untracked file across filesystems is silently slow.** On a standard LXC `/opt/charging-master` and `.update-state/quarantine-*/` are on the same filesystem, so `mv` is `rename(2)` (atomic, zero-copy). If a quirky deployment mounts `/opt/charging-master/.update-state` to a different FS, `mv` falls back to copy+unlink — much slower but still correct. Document this; do not handle exotic mounts.

6. **Symlinks in untracked output.** `git status --porcelain` reports the symlink path itself (e.g. `?? scripts/debug-link`), not its target. `mv` of a symlink relocates the link node (not the target). This is the correct behavior for quarantine: we're isolating the WORKING-TREE artifact, not its target. Standard `mv` (no `-h`/`--no-dereference` needed on Linux: `mv` on a symlink always moves the link).

7. **`on_error` recursion is already prevented.** Line 576: `trap - ERR`. This was added in Phase 9 (commit `ef01e41` per git log). Adding a `state_set_*` call before `exit 1` inside `on_error` does NOT need any further protection — the trap is already disabled. [VERIFIED: `run-update.sh:574–576`]

8. **PIPE-02 must preserve fields not explicitly cleared.** The existing `state_set_installing` (`run-update.sh:137–153`) and `state_set_success` (lines 155–172) READ the file first, MERGE, and write — they do NOT zero out fields. The new reset helper must do the same: read → set `updateStatus="idle"` → clear `targetSha=null`, `updateStartedAt=null` → preserve everything else (notably `currentSha`, `rollbackSha`, `lastCheckResult`, `lastCheckEtag`, `rollbackHappened`/`rollbackReason` written by prior `state_set_rolled_back`, and the new `lastQuarantine`). The existing `state_set_rolled_back` is the closest template — also reads-then-merges.

9. **PIPE-02 must NOT touch `rollbackHappened`.** The on_error trap at `run-update.sh:579–586` for pre-change failures (preflight/snapshot/drain/stop) calls `state_set_rolled_back "${error_message}"` which sets `rollbackHappened=true`. If we also call our new reset helper there, we'd overwrite it back to false — UI would lose the red banner. Solution: the new reset helper sets ONLY `updateStatus="idle"`, `targetSha=null`, `updateStartedAt=null`. It does NOT touch `rollbackHappened`/`rollbackReason`. Order the calls so reset runs BEFORE `state_set_rolled_back` (which is "later" semantically — last write wins on `updateStatus`). Actually simpler: extend `state_set_rolled_back` itself to also clear `updateStatus` + in-progress, and emit a parallel `state_set_idle_no_rollback` for the rare case where rollback didn't happen. Recommend the latter — explicit names, no implicit ordering.

10. **`update_runs` schema is permissive — but not infinitely.** The column is `status text NOT NULL` (`drizzle/0001_nappy_stepford_cuckoos.sql:7`). The Drizzle TS enum at `schema.ts:245–247` lists only `['running', 'success', 'failed', 'rolled_back']`. Adding `'recovery_reset'` requires extending the TS enum — pure TS change, NO `.sql` migration. **But**: the `db_*` helpers in `run-update.sh:92–132` use raw sqlite3 CLI strings, bypassing Drizzle entirely. The TS enum is only checked at Drizzle query sites (e.g. `UpdateHistory` component, `/api/update/history`). If the new `recovery_reset` is read by the existing history view, that view's row type narrowing will reject it without the enum extension. **Action:** extend the enum AND verify no other code path narrows on the union. `grep -r "status: text" src/db/schema.ts` and `grep -r "status === '" src/modules/self-update/` before writing the plan.

11. **PIPE-04 endpoint MUST use the `prepare-for-shutdown` local guard, NOT `host-guard.ts`.** They are different: `host-guard.ts` allows `charging-master.local` (the LAN browser hostname) plus `UPDATE_ALLOWED_HOSTS` overrides. `prepare-for-shutdown/route.ts:15` allows ONLY `127.0.0.1 / localhost / ::1 / [::1]`. PIPE-04 is a server-to-server emergency endpoint called via `curl http://localhost/...` from an SSH session ON the LXC — it must reject `charging-master.local` to maintain the "last resort, you're on the box" semantics. **Copy `isLocalhostHost` from `prepare-for-shutdown/route.ts:40–49` verbatim into the new route.** CONTEXT line 95 says "Same allowlist as `/api/internal/prepare-for-shutdown` — `127.0.0.1`, `localhost`, `::1`" — explicit confirmation.

12. **PIPE-03 admin DELETE endpoint uses the OTHER guard.** `/api/admin/update-state/quarantine` is browser-reachable (the admin page's "Alle löschen" button hits it from a browser at `http://charging-master.local/settings/update-state`). It MUST use `isAllowedBrowserHost` from `host-guard.ts:41`. CONTEXT line 84: "Host-guard the admin DELETE same as other internal endpoints" — slightly ambiguous; clarification: same as `/api/update/trigger`, NOT `/api/internal/prepare-for-shutdown`. The two have different allowlists.

13. **Server component reading the filesystem must use `node:fs` sync APIs.** `update-state-store.ts:1–13` is the template — no `'use server'` directive, no `import 'server-only'` because that throws outside RSC modules. RSC pages CAN safely `import 'server-only'`. The new server component at `app/settings/update-state/page.tsx` should `import 'server-only'` (or just live as a default-async-function in an `app/` page) — Next.js 15 RSC guarantees no client bundle leak. [CITED: Next.js App Router RSC guarantees]

14. **Client component DELETE button must include the Host header implicitly.** A browser-originated `fetch('/api/admin/update-state/quarantine', { method: 'DELETE' })` automatically sends the current page's host — no manual header needed. The host guard sees `charging-master.local` (or `localhost` in dev) and allows.

15. **The 2026-05-15 incident left untracked file `scripts/calibration-sweep-real.ts` AND `tsconfig.tsbuildinfo` (already in the allowlist).** The existing regex at `run-update.sh:273` allows `^?? \.update-state/`, `^?? \.next/`, `^ M tsconfig\.tsbuildinfo`. After PIPE-01, the allowlist regex goes away entirely — every `^?? ` line is auto-quarantined instead. **Side effect**: `??  .update-state/` lines would self-quarantine (the script's own write directory). Path-prefix exclusion list: skip any `??` entry whose path starts with `.update-state/` or `.next/`. Document inline in the script.

16. **The status SSE endpoint already streams `[stage=...]` markers from journalctl.** PIPE-01's new `[stage=preflight_git] quarantined N file(s)` line is automatically picked up by the existing `STAGE_REGEX` parser at `update-banner.tsx:38` — no new client code for live surfacing during the run. The Admin page is the "history" view of past quarantines; the banner's quarantine info state is the "summary" view. Both come from the same `state.json.lastQuarantine` field, NOT from log scraping.

17. **PIPE-04's audit `update_runs` insert must NOT use the existing `db_*` helpers.** Those helpers are bash-only (`run-update.sh:92–132`) and use `RUN_ID` continuity. The TS endpoint inserts a one-off row with `start_at = end_at = Date.now()`, `status = 'recovery_reset'`, `from_sha = state.currentSha`, `to_sha = null`, `error_message = 'manual recovery via /api/internal/reset-update-state'`. Use Drizzle's `db.insert(updateRuns).values({...}).run()`. [VERIFIED: schema.ts:239–254]

18. **Idempotency of PIPE-04**: CONTEXT does not explicitly mandate idempotency. Recommend: ALWAYS write the row (every call = audit event, even if state was already idle). Same-state writes are cheap and the audit trail is more valuable than de-duplication. Return 200 `{ok: true}` either way. Lock decision: **non-idempotent → always insert audit row**.

## Patterns to Follow (file:line refs)

| Pattern | Reference | What to mirror |
|---------|-----------|----------------|
| Snapshot retention with `ls -1t \| tail -n +N` | `scripts/update/run-update.sh:289–294` | Quarantine dir retention (`ls -1td "${STATE_DIR}"/quarantine-* \| tail -n +${QUARANTINE_RETAIN}`) |
| Python3 atomic state.json write | `scripts/update/run-update.sh:137–189` | New `state_set_idle_clearing_inprogress` + `state_set_quarantine` helpers |
| `on_error` trap self-disable | `scripts/update/run-update.sh:574–576` (`trap - ERR` line 576) | No new mechanism needed — extend existing on_error with one new state write call |
| Localhost-only host guard (server-to-server) | `src/app/api/internal/prepare-for-shutdown/route.ts:15–49` (`isLocalhostHost`, ALLOWED_HOSTS) | New `src/app/api/internal/reset-update-state/route.ts` |
| LAN browser host guard | `src/lib/host-guard.ts:41` (`isAllowedBrowserHost`) | New `src/app/api/admin/update-state/quarantine/route.ts` (DELETE) |
| 403 + no-cache headers response shape | `src/app/api/internal/prepare-for-shutdown/route.ts:36–38, 71–74` | Both new endpoints |
| UpdateStateStore atomic merge write | `src/modules/self-update/update-state-store.ts:70–96` | Reset endpoint uses `store.write({ updateStatus: 'idle', targetSha: null, updateStartedAt: null })` — spread merge already preserves everything else |
| UpdateInfoView extension via pure derivation | `src/modules/self-update/update-info-view.ts:33–43` | Add `lastQuarantine` to base view; no UpdateState→view shape change beyond field copy |
| Server-component page + client-component mutator pattern | `src/app/settings/page.tsx:37–92` (server) + `src/app/settings/update-banner.tsx:218–231` (client mutates via fetch) | New `app/settings/update-state/page.tsx` (server: reads dir) + `app/settings/update-state/quarantine-list.tsx` (client: DELETE button) |
| `force-dynamic` + `runtime = 'nodejs'` on FS-accessing routes | `src/app/api/internal/prepare-for-shutdown/route.ts:3–4` | All new API routes |
| Drizzle `updateRuns` enum extension (TS-only, no SQL) | `src/db/schema.ts:245–247` | Add `'recovery_reset'` to the enum tuple |
| RTL component test setup (jsdom + RTL + jest-dom) | `src/components/settings/charging-settings.test.tsx:1–8`, `vitest.config.ts:1–22` | Banner test + admin page test |
| Bash test harness for run-update.sh helpers | `scripts/update/dry-run-helpers.sh` (filtered sed-source pattern, macOS-portable) | Extend or fork for quarantine + on_error tests |

## Per-Requirement Analysis

### PIPE-01 — Preflight Quarantine

**Approach:**

1. Replace `preflight_git` body (`run-update.sh:269–278`) with:
   ```bash
   preflight_git() {
       CURRENT_STAGE="preflight_git"
       # Parse -z NUL-terminated porcelain. Each entry = "XY path\0".
       # We tolerate ?? (untracked) — quarantine them. Everything else = FATAL.
       local untracked=()
       local fatal=()
       local entry
       while IFS= read -r -d '' entry; do
           local code="${entry:0:2}"
           local path="${entry:3}"
           case "${code}" in
               '??')
                   # Skip the script's own write dirs — they're operational, not user debris.
                   case "${path}" in
                       .update-state/*|.next/*) continue ;;
                   esac
                   untracked+=("${path}")
                   ;;
               *)
                   fatal+=("${code} ${path}")
                   ;;
           esac
       done < <(git status -z --porcelain)

       if (( ${#fatal[@]} > 0 )); then
           die "Working tree has unexpected changes: ${fatal[*]}"
       fi

       if (( ${#untracked[@]} == 0 )); then
           log "git working tree clean"
           return 0
       fi

       # Quarantine
       local stamp
       stamp=$(date +%Y%m%d-%H%M%S)
       local qdir="${STATE_DIR}/quarantine-${stamp}"
       # Disambiguate same-second re-trigger
       local tries=0
       while [ -e "${qdir}" ] && (( tries < 10 )); do
           tries=$((tries + 1))
           qdir="${STATE_DIR}/quarantine-${stamp}-try${tries}"
       done
       mkdir -p "${qdir}"

       local f
       for f in "${untracked[@]}"; do
           local dest="${qdir}/${f}"
           mkdir -p "$(dirname "${dest}")"
           mv "${INSTALL_DIR}/${f}" "${dest}" \
               || die "quarantine move failed for ${f}"
       done

       log "quarantined ${#untracked[@]} file(s) to ${qdir}"

       # Retention prune (keep newest QUARANTINE_RETAIN-1 plus the one we just made)
       local existing
       existing=$(ls -1td "${STATE_DIR}"/quarantine-* 2>/dev/null | tail -n +${QUARANTINE_RETAIN} || true)
       if [ -n "${existing}" ]; then
           log "pruning old quarantine dirs"
           echo "${existing}" | xargs -r rm -rf
       fi

       # Surface in state.json
       state_set_quarantine "${stamp}" "${#untracked[@]}" "${qdir}"
       log "git working tree clean (after quarantine)"
   }
   ```

2. New constant near `run-update.sh:35`: `readonly QUARANTINE_RETAIN=3`.

3. New helper near `run-update.sh:137`:
   ```bash
   state_set_quarantine() {
       local timestamp="$1"  # epoch seconds OR YYYYMMDD-HHMMSS string — pick epoch
       local file_count="$2"
       local path="$3"
       # Use epoch ms to match `lastCheckAt` semantics
       local epoch_ms
       epoch_ms=$(date +%s%3N)  # GNU date — Debian has it
       python3 - "${STATE_FILE}" "${epoch_ms}" "${file_count}" "${path}" <<'PYEOF'
import json, os, sys
state_file = sys.argv[1]
timestamp = int(sys.argv[2])
file_count = int(sys.argv[3])
path = sys.argv[4]
with open(state_file) as f:
    state = json.load(f)
state["lastQuarantine"] = {
    "timestamp": timestamp,
    "fileCount": file_count,
    "path": path,
}
tmp = state_file + ".tmp"
with open(tmp, "w") as f:
    json.dump(state, f, indent=2)
os.replace(tmp, state_file)
PYEOF
   }
   ```

4. Add `lastQuarantine?: { timestamp: number; fileCount: number; path: string }` to `UpdateState` in `src/modules/self-update/types.ts:39–65`. Optional → backwards-compatible with existing on-disk state.

5. Extend `UpdateInfoView` and `deriveUpdateInfoView` to pass `lastQuarantine` through unchanged.

**Edge cases handled:**
- Filenames with spaces / newlines / quotes → `-z` strips quoting, NUL-separates.
- Same-second re-trigger → `-tryN` suffix.
- Empty untracked list → no quarantine dir created, normal "clean tree" log.
- `.update-state/` self-mention → skipped via case statement.
- Mixed `?? foo.ts` + `M  bar.ts` → fatal via the `fatal[]` accumulator.

**`-z` NUL-terminated read pattern verified portable on bash 4+ (Debian 13 LXC ships bash 5). The macOS dry-run harness uses bash 3.2, but the dry-run harness already documents itself as "what it does NOT exercise" so quarantine is naturally tested on Linux via integration smoke; bash-3.2 compatibility for the harness can be `while IFS= read -r -d $'\0'` if needed (still works on 3.2 with the `$'\0'` syntax).**

### PIPE-02 — on_error State Reset

**Approach:**

1. New helper near `run-update.sh:189`:
   ```bash
   state_set_idle_clearing_inprogress() {
       python3 - "${STATE_FILE}" <<'PYEOF'
import json, os, sys
state_file = sys.argv[1]
with open(state_file) as f:
    state = json.load(f)
state["updateStatus"] = "idle"
state["targetSha"] = None
state["updateStartedAt"] = None
# Preserve everything else: currentSha, rollbackSha, lastCheckResult,
# lastCheckEtag, lastCheckAt, rollbackHappened, rollbackReason, rollbackStage,
# lastQuarantine.
tmp = state_file + ".tmp"
with open(tmp, "w") as f:
    json.dump(state, f, indent=2)
os.replace(tmp, state_file)
PYEOF
   }
   ```

2. Inside `on_error()` at `run-update.sh:566–601`:
   - For the pre-change case-arm at line 579–586: call `state_set_idle_clearing_inprogress` BEFORE `state_set_rolled_back` (or just skip `state_set_rolled_back` for pre-change since no rollback HAPPENED — see pitfall 9). **Recommendation: do not call `state_set_rolled_back` for pre-change failures; do call `state_set_idle_clearing_inprogress`.** This means existing UI's red banner does NOT show for a preflight-only failure — which is correct, no rollback occurred.
   - For the rollback path (Stage 1 / Stage 2): existing `do_rollback_stage1` / `do_rollback_stage2` already call `state_set_rolled_back` which writes `updateStatus="rolled_back"`. Add `state.targetSha = null; state.updateStartedAt = null` to `state_set_rolled_back` itself — one-line additions in the existing Python heredocs (`run-update.sh:177–186`).

3. **Verification:** Inject `false` early in `preflight_disk`, run the script, assert `cat .update-state/state.json | jq '.updateStatus'` returns `"idle"`. Done via the extended dry-run harness (Test 5).

### PIPE-03 — Admin Page + Banner Surface

**Approach:**

1. **Banner state.** New info state in `update-banner.tsx` after the rollback banner (line 243) and before STATE 1 "Update available" (line 326). Priority order:

   1. Rollback (red) — UNCHANGED top priority.
   2. Streaming/triggered/reconnecting/error — UNCHANGED (active flow).
   3. **Quarantine info state (NEW)** — non-blocking, sits ABOVE "Update available" so the user sees quarantine context before clicking Installieren.
      - Condition: `info.lastQuarantine !== undefined && info.lastQuarantine !== null`.
      - Render: yellow-tinted (not red) banner with text "Letztes Preflight: {fileCount} Datei(en) in Quarantäne — [Details ansehen]" linking to `/settings/update-state`.
      - Auto-clears when `lastQuarantine` is removed from state.json (by the admin DELETE).
   4. STATE 1 "Update verfügbar" — UNCHANGED.
   5. STATE 2 / 3 — UNCHANGED.

   Lower priority than rollback (rollback is urgent), higher priority than "Update verfügbar" (because quarantine context informs the install decision). The CONTEXT text "non-blocking info" suggests lowest priority — but visually it's an INSERT above the update banner, not a REPLACE. Decide: **render quarantine as a SEPARATE small banner ABOVE the existing primary banner when both are present**. Two stacked banners. Lock in plan.

2. **Server page** at `src/app/settings/update-state/page.tsx`:
   ```tsx
   import 'server-only';
   import { readdirSync, existsSync } from 'node:fs';
   import { join } from 'node:path';
   import { UpdateStateStore } from '@/modules/self-update/update-state-store';
   import { QuarantineList } from './quarantine-list';

   export const dynamic = 'force-dynamic';

   export default async function UpdateStatePage() {
     const store = new UpdateStateStore();
     const state = store.read();
     const quarantine = state.lastQuarantine ?? null;
     let files: string[] = [];
     if (quarantine !== null && existsSync(quarantine.path)) {
       // Recursive walk — flat path list rel to qdir
       files = walkRecursive(quarantine.path);
     }
     return (
       <div className="max-w-2xl mx-auto py-8 px-4 space-y-6">
         <h1 className="text-2xl font-bold text-neutral-100">Update-State / Quarantine</h1>
         {quarantine === null ? (
           <p className="text-neutral-400">Keine Quarantäne-Dateien.</p>
         ) : (
           <QuarantineList path={quarantine.path} files={files} fileCount={quarantine.fileCount} timestamp={quarantine.timestamp} />
         )}
       </div>
     );
   }
   ```

3. **Client component** `quarantine-list.tsx`:
   - Renders the file list (read-only `<ul>`).
   - "Alle löschen" button → `fetch('/api/admin/update-state/quarantine', { method: 'DELETE' })` → `router.refresh()` on success.
   - Mirrors `handleAckRollback` in `update-banner.tsx:218`.

4. **DELETE endpoint** `src/app/api/admin/update-state/quarantine/route.ts`:
   - `import { isAllowedBrowserHost } from '@/lib/host-guard'` → 403 on non-allowlisted Host.
   - Reads `state.lastQuarantine.path`, `rm -rf` it via `node:fs/promises rm({recursive: true, force: true})`.
   - Patches state: `store.write({ lastQuarantine: null })`.
   - Returns 200 `{ ok: true }`.

5. **Tests:**
   - `update-banner.test.tsx` — render with `lastQuarantine != null` → banner present; with `null` → banner absent.
   - `page.test.tsx` — RTL render of server component (use Next's RSC test pattern OR test as plain async function returning JSX).
   - `route.test.ts` — DELETE with allowed Host → 200 + dir gone; with `evil.example.com` Host → 403.

### PIPE-04 — Recovery Endpoint

**Approach:**

1. New route `src/app/api/internal/reset-update-state/route.ts`:
   ```tsx
   import { UpdateStateStore } from '@/modules/self-update/update-state-store';
   import { db } from '@/db/client';
   import { updateRuns } from '@/db/schema';

   export const runtime = 'nodejs';
   export const dynamic = 'force-dynamic';

   const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
   const NO_CACHE = { 'Cache-Control': 'no-store, no-cache, must-revalidate' } as const;

   function isLocalhostHost(request: Request): boolean {
     const raw = request.headers.get('host');
     if (!raw) return false;
     const host = raw.startsWith('[')
       ? raw.slice(0, raw.indexOf(']') + 1)
       : raw.split(':')[0];
     return ALLOWED_HOSTS.has(host.toLowerCase());
   }

   export async function POST(request: Request): Promise<Response> {
     if (!isLocalhostHost(request)) {
       return Response.json({ error: 'forbidden' }, { status: 403, headers: NO_CACHE });
     }
     const store = new UpdateStateStore();
     const before = store.read();
     try {
       store.write({
         updateStatus: 'idle',
         targetSha: null,
         updateStartedAt: null,
       });
     } catch (err) {
       return Response.json(
         { error: `state write failed: ${err instanceof Error ? err.message : String(err)}` },
         { status: 500, headers: NO_CACHE },
       );
     }
     // Audit row — always insert (non-idempotent by design, see pitfall 18)
     try {
       const now = new Date();
       db.insert(updateRuns).values({
         startAt: now,
         endAt: now,
         fromSha: before.currentSha,
         toSha: null,
         status: 'recovery_reset' as const,
         stage: 'recovery',
         errorMessage: 'manual recovery via /api/internal/reset-update-state',
         rollbackStage: null,
       }).run();
     } catch {
       // Audit failure is non-fatal — state reset is the load-bearing part.
     }
     return Response.json({ ok: true }, { status: 200, headers: NO_CACHE });
   }
   ```

2. Extend Drizzle enum: `schema.ts:245–247`:
   ```ts
   status: text('status', {
     enum: ['running', 'success', 'failed', 'rolled_back', 'recovery_reset'] as const,
   }).notNull(),
   ```

3. **No SQL migration needed** — column is `text NOT NULL` with no DB-side `CHECK`. [VERIFIED: drizzle/0001_nappy_stepford_cuckoos.sql:7]

4. **Verify the existing `UpdateHistory` component handles the new enum value.** If it filters/groups on status it may need a label addition. Quick grep before planning:
   ```bash
   grep -rn "updateRuns\|update_runs" src/ --include="*.tsx" --include="*.ts"
   ```

5. **Test** (`route.test.ts`):
   - POST with `Host: localhost` → 200 + state.json patched + `update_runs` row exists.
   - POST with `Host: charging-master.local` → 403 (LAN browser hostname NOT allowed for this endpoint).
   - POST with no Host header → 403.

## Runtime State Inventory

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | `state.json` (single file at `/opt/charging-master/.update-state/state.json`). Existing files lack `lastQuarantine` — optional field is backward-compatible (`update-state-store.ts:62–68` JSON.parse with no schema validation). `update_runs` SQLite table — adding `'recovery_reset'` status string is enum-only (TS-side); column is plain text. | Code edit only. No data migration. |
| Live service config | None — the updater runs as a systemd oneshot, no live process state. | None. |
| OS-registered state | `charging-master-updater.service` systemd unit — UNCHANGED. New script logic stays inside `scripts/update/run-update.sh` (the unit ExecStart). No re-registration. | None. |
| Secrets/env vars | `UPDATE_ALLOWED_HOSTS` (existing env, used by `host-guard.ts`). PIPE-03 admin DELETE relies on it. No new env vars. | None. |
| Build artifacts | None — TS changes are pure; bash script changes ship via git. After deploy, the new `run-update.sh` is what `systemctl start charging-master-updater.service` runs. Existing `.next/` build cache is unaffected. | None. |

## Common Pitfalls (Project-Specific)

### Pitfall A: Writing to `state.json` from two writers (Node + bash) without locks
**What goes wrong:** PIPE-04 writes from Node; bash updater writes from `state_set_*` helpers. Concurrent writes could race.
**Why it happens:** No cross-process mutex on the file.
**How to avoid:** The bash script holds `flock -n 9` on `${LOCK_FILE}` for its entire runtime (`run-update.sh:71–80`). PIPE-04 must ONLY be callable when the bash script is NOT running — but it's called precisely BECAUSE the bash script crashed and left stale state. The exit of the bash process releases the flock automatically. **Safe path:** PIPE-04 endpoint should additionally check `flock -n` on the LOCK_FILE before writing (and 409 if held). Recommend: `tryAcquireFlock` helper via `fs.openSync(LOCK_FILE, 'r+')` + `flock` syscall — OR more pragmatically, just do the atomic state write (tmp + rename) which is already race-safe at the FS level, and accept that a recovery-during-active-updater is an operator error.
**Warning signs:** state.json has stale `installing` when no updater process is running (per `ps -ef | grep run-update.sh`).
**Recommendation for plan:** Skip the flock check on Node side; rely on the atomic tmp+rename guarantee + the operator manually verifying the updater is dead before calling the endpoint. Document in route comment.

### Pitfall B: Bash 3.2 vs Bash 5 syntax incompatibility in dry-run harness
**What goes wrong:** Quarantine logic uses bash arrays and `while read -d ''` — both work on bash 4+ (LXC) and bash 3.2 (macOS dev).
**Why it happens:** Phase 9-03 already documented this (see STATE.md `[Phase 09-03]`).
**How to avoid:** Test the quarantine logic on a bash 5 LXC or via Docker. The macOS dry-run harness can skip the quarantine test the same way it skips `do_stop` / `systemctl` tests.
**Warning signs:** `dry-run-helpers.sh` failing with `unexpected token`.

### Pitfall C: Forgetting to exclude `.update-state/quarantine-*/` from the snapshot tarball
**What goes wrong:** `do_snapshot` at `run-update.sh:298–305` excludes `./.update-state/snapshots` but NOT `./.update-state/quarantine-*`. A quarantine dir created in preflight goes INTO the snapshot, bloating it.
**Why it happens:** Tarball was authored before quarantine existed.
**How to avoid:** Add `--exclude='./.update-state/quarantine-*'` to the tar invocation.
**Warning signs:** Snapshot tarball size jumps unexpectedly after an update that quarantined files.

### Pitfall D: PIPE-04 audit row leaks `before.currentSha` even on a "no-op" reset
**What goes wrong:** If `state.currentSha` is the genuine running SHA, that's fine. But during a half-failed update where the bash script wrote `installing` + `targetSha`, `currentSha` may STILL be the old SHA (it's only updated by `state_set_success`). So the audit row's `fromSha` correctly records the version that was running when recovery happened.
**Why it happens:** Working as designed — `currentSha` semantics.
**How to avoid:** No action; the data is correct. Document in route comment so future readers don't confuse `fromSha` with "rolled back from."

## Open Questions for the Planner

1. **Order of plans:** PIPE-02 (smallest) → PIPE-01 (depends on state helpers) → PIPE-04 (independent) → PIPE-03 (depends on PIPE-01's `lastQuarantine` field shipping). Confirm.

2. **Banner priority placement:** Stack quarantine info ABOVE the primary banner when both render, or REPLACE the primary banner with a combined view? Plan-time decision. Recommendation: stack (two separate `<div>`s).

3. **Where to store quarantine retention constant on Node side?** It's a bash-only constant (`QUARANTINE_RETAIN`); Node doesn't need to know. Skip.

4. **Should `lastQuarantine.path` be relative (`.update-state/quarantine-YYYYMMDD-HHMMSS`) or absolute (`/opt/charging-master/.update-state/...`)?** The bash script writes the variable holding `${qdir}` which is absolute. Decide: store ABSOLUTE in state.json — the admin page server-component lives on the same FS, no portability concern. Plan locks this.

5. **Test harness for PIPE-01 bash logic:** New `scripts/update/quarantine-helpers.test.sh` mirroring `dry-run-helpers.sh`, OR extend `dry-run-helpers.sh` with Test 5/6? Recommendation: extend, single source of truth.

6. **Should the new admin page link from somewhere persistent (e.g. settings nav footer)?** CONTEXT line 130 says "Behind nothing — LAN-only deployment per project security model" but the deep link from the banner is the only entry. Document inline: no nav, accessed only via banner deep-link OR direct URL.

7. **Re-trigger after PIPE-02 reset:** After on_error fires and state goes to idle, the user can `POST /api/update/trigger` again. But the underlying preflight failure cause may still exist (e.g. stale untracked file before PIPE-01 was deployed). Pre-PIPE-01 systems would loop forever. POST-PIPE-01 they self-heal. Document: the four PIPE requirements must ship as a single phase deploy; partial deploys (only PIPE-02 without PIPE-01) leave the same underlying brittleness.

8. **PIPE-03 file listing depth:** A quarantine could in principle contain nested dirs (the bash script preserves directory structure via `mkdir -p "$(dirname "${dest}")"`). The admin page should show paths relative to the quarantine dir root, NOT just basenames. Lock decision.

## References

### Primary (HIGH confidence — project source)

- `scripts/update/run-update.sh:22–666` — full updater pipeline, all stages, traps, helpers
- `scripts/update/run-update.sh:137–189` — Python3 atomic state.json write pattern
- `scripts/update/run-update.sh:269–278` — current `preflight_git` (target for PIPE-01 rewrite)
- `scripts/update/run-update.sh:289–294` — snapshot retention pattern (mirror for quarantine retention)
- `scripts/update/run-update.sh:566–601` — `on_error` trap (target for PIPE-02 extension)
- `scripts/update/run-update.sh:574–576` — `trap - ERR` self-disable
- `scripts/update/dry-run-helpers.sh` — dry-run harness pattern (sed-filtered source, macOS-portable)
- `src/modules/self-update/types.ts:39–78` — `UpdateState` + `DEFAULT_UPDATE_STATE` (extend with `lastQuarantine?`)
- `src/modules/self-update/types.ts:116–155` — `UpdateInfoView` (extend with `lastQuarantine?`)
- `src/modules/self-update/update-state-store.ts:35–96` — atomic-write store
- `src/modules/self-update/update-info-view.ts:9–81` — pure view derivation
- `src/app/api/update/status/route.ts:1–41` — status endpoint (auto-passes new field through `getUpdateInfo()`)
- `src/app/api/internal/prepare-for-shutdown/route.ts:15–124` — server-to-server localhost guard pattern + 403 response shape (template for PIPE-04)
- `src/app/api/update/trigger/route.ts:14, 43–46` — LAN browser host-guard usage
- `src/app/api/update/ack-rollback/route.ts:1–46` — minimal state-mutation endpoint pattern
- `src/lib/host-guard.ts:14–49` — `isAllowedBrowserHost` (for PIPE-03 DELETE)
- `src/app/settings/update-banner.tsx:65–496` — 5-state banner with priority order + flow state machine
- `src/app/settings/page.tsx:37–92` — server component → client component composition pattern
- `src/db/schema.ts:239–254` — `updateRuns` table + enum (target for `'recovery_reset'` extension)
- `drizzle/0001_nappy_stepford_cuckoos.sql:1–11` — `update_runs` SQL: confirms `status text NOT NULL` with NO check constraint → no migration needed
- `src/components/settings/charging-settings.test.tsx:1–40` — RTL/jsdom test pattern for client components
- `src/app/api/charging/sessions/[id]/route.test.ts:1–50` — API route test pattern with vi.mock for db
- `vitest.config.ts:1–22` — jsdom + RTL config

### Secondary (MEDIUM-HIGH confidence — external authoritative docs)

- [git-scm.com/docs/git-status](https://git-scm.com/docs/git-status) — `--porcelain` v1 status codes, `-z` NUL-terminated format, rename token order, no quoting in `-z`
- Bash manual — `read -d ''` for NUL delimiter (POSIX-extension, GNU bash 4+, also works on bash 3.2 macOS via `$'\0'`)

### Tertiary (LOW confidence — not load-bearing for plan)

- None — all critical claims are verified from project source.

## Validation Architecture

> Project config has `workflow.nyquist_validation: false` → section omitted per phase guidelines.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `git status -z --porcelain` on Debian's git (2.39+) emits the same status codes as 2.50 documented | Pitfalls 1–3 | LOW — git porcelain format is stable since v1.7; any 2.x will work |
| A2 | Bash 5 on Debian 13 LXC supports `while IFS= read -r -d ''` reliably | PIPE-01 sample code | LOW — bash 4.0+ supports this; LXC ships 5.x |
| A3 | `date +%s%3N` (GNU date millisecond format) is available on the Debian LXC | PIPE-01 `state_set_quarantine` | LOW — GNU coreutils on Debian has this since forever; if missing, fall back to `$(($(date +%s) * 1000))` |
| A4 | The existing `UpdateHistory` component does not narrow on `updateRuns.status` enum membership at a call-site that would reject `'recovery_reset'` | PIPE-04, pitfall 10 | MEDIUM — must grep before plan to confirm; if it does, the component needs a label addition |
| A5 | Browser `fetch('/api/admin/update-state/quarantine', {method: 'DELETE'})` from the admin page sends `Host: charging-master.local` (matching the allowlist) | PIPE-03 | LOW — standard browser behavior |

## Metadata

**Confidence breakdown:**
- Bash quarantine + on_error logic: HIGH — script source fully read, patterns mirrored.
- Schema / migration question: HIGH — direct inspection of `drizzle/0001` SQL.
- Host-guard variants: HIGH — both files read in full.
- Admin page RSC + client composition: MEDIUM-HIGH — pattern exists for banner/settings but not for FS-listing pages specifically.
- Test harness extension: MEDIUM — `dry-run-helpers.sh` pattern documented; specific quarantine tests are new shape.

**Research date:** 2026-05-15
**Valid until:** 2026-06-14 (30 days — project moves fast, but the targeted files are stable Phase 7/9/10 surfaces)
