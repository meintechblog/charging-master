# Phase 13 Patterns Analysis

**Mapped:** 2026-05-15
**Phase:** 13 — Update Pipeline Hardening (PIPE-01..04)
**Scope:** Map existing analogs in the codebase that the new files for PIPE-01..04 will mirror. Read-only analysis.

The driver: v1.3.1 deploy on 2026-05-15 failed at `[stage=preflight_git]` on an untracked diagnostic script, and the `on_error` trap left `state.json:updateStatus="installing"`, blocking all subsequent triggers. Four work items target that failure mode.

---

## File-by-file analog map

| New / modified file (PIPE-XX) | Role | Data flow | Closest analog | Match quality |
|---|---|---|---|---|
| `scripts/update/run-update.sh` — modify `preflight_git` (PIPE-01) | bash stage | git → fs move | existing `preflight_git` at L269–278 + `do_snapshot` retention at L283–307 | exact (same script, same trap chain) |
| `scripts/update/run-update.sh` — modify `on_error` (PIPE-02) | bash trap | bash → state.json | existing `state_set_rolled_back` (L174–189) + `on_error` (L566–601) | exact (same trap, same atomic-write idiom) |
| `src/modules/self-update/types.ts` — add `lastQuarantine?` field | TS type | type definition | existing `UpdateState` (L39–65), `DEFAULT_UPDATE_STATE` (L67–78) and `UpdateInfoView` (L116–155) | exact (one-line additive change, matches Phase 10 pattern of optional fields) |
| `src/modules/self-update/update-state-store.ts` — no logic change | TS module | fs read/write atomic | existing `write({...})` merge at L70–75 (already merges via spread, no edit needed for PIPE-01) | exact — current shape already covers `lastQuarantine` once added to type |
| `src/app/api/update/status/route.ts` — pass-through | API route | UpdateInfoView serializer | already returns whole view via `getUpdateInfo()` (`update-state-store.ts:84–87` → `deriveUpdateInfoView`) | exact — needs `lastQuarantine` added to view, then it tunnels automatically |
| `src/app/api/internal/reset-update-state/route.ts` — NEW (PIPE-04) | API route | host-guard + state write + DB insert | `src/app/api/internal/prepare-for-shutdown/route.ts` (full file, 125 lines) | exact (same dir, same guard idiom, same Response.json shape) |
| `src/app/api/admin/update-state/quarantine/route.ts` — NEW (PIPE-03) | API route | host-guard + fs delete | `src/app/api/internal/prepare-for-shutdown/route.ts` (host-guard shape) + `src/app/api/profiles/[id]/route.ts:289–318` (DELETE handler) | role-match composite (no existing "admin DELETE behind host-guard" exists) |
| `src/components/update/update-banner.tsx` (resolved to `src/app/settings/update-banner.tsx`) — extend with quarantine state | client component | state machine render | existing priority chain at L242–456 | exact (drop into priority slot — see "Critical patterns" §3) |
| `src/app/settings/update-state/page.tsx` — NEW (PIPE-03) | server page | fs read → JSX | `src/app/settings/page.tsx` (full file, 92 lines) — server component reading domain modules | role-match (no existing sibling-of-`/settings` page exists) |
| `src/app/settings/update-state/quarantine-list.tsx` — NEW (PIPE-03) | client component | DELETE fetch + reload | `src/components/charging/profile-photo-gallery.tsx:71` (`fetch(..., { method: 'DELETE' })`) + `src/app/settings/update-banner.tsx:218–231` (`handleAckRollback` flow) | role-match (existing DELETE-trigger pattern is well-established) |
| `scripts/update/dry-run-helpers.sh` — extend with PIPE-01 + PIPE-02 cases | bash harness | sourced script + override no-ops | existing harness (entire file, 258 lines) | exact (Test 5 / Test 6 mirror existing Test 1 / Test 2 structure) |
| `src/app/api/internal/reset-update-state/route.test.ts` — NEW | route test | vitest + mock host | NONE — no host-guard route test currently exists; closest is `src/app/api/charging/sessions/[id]/route.test.ts` (60-line `vi.mock('@/db/client')` shape) | partial (test pattern exists, host-guard-test pattern does not — see Open Questions) |

---

## Critical patterns to follow

### 1. `git status --porcelain` parsing — PIPE-01

**Existing:** `scripts/update/run-update.sh:269–278` (the stage to be modified).

```bash
preflight_git() {
    CURRENT_STAGE="preflight_git"
    # Allow well-known untracked/modified paths; fail on any src/ or config drift.
    local dirty
    dirty=$(git status --porcelain | grep -vE '^\?\? \.update-state/|^\?\? \.next/|^ M tsconfig\.tsbuildinfo' || true)
    if [ -n "${dirty}" ]; then
        die "Working tree has unexpected changes: ${dirty}"
    fi
    log "git working tree clean"
}
```

**Mechanics today:**
- `git status --porcelain` is invoked once, line-buffered.
- `grep -vE` allowlists three benign untracked/modified paths.
- ANY remaining line → fatal via `die "..."` which `echo "[stage=...]"`s + `exit 1`. That fires `trap on_error ERR`.
- Filenames with spaces would parse incorrectly today (no `-z`).

**Pattern PIPE-01 must add (new logic):**
- Use `git status --porcelain -z` for NUL-terminated entries so quoted-space filenames don't break.
- Partition lines: `??`-prefix = untracked; everything else = modified/staged/deleted = FATAL as today.
- If `dirty` after the allowlist filter contains ONLY `??`-lines: build a quarantine dir under `${STATE_DIR}/quarantine-$(date +%Y%m%d-%H%M%S)/`, `mkdir -p` it, then for each `??` path: `mkdir -p` the parent in the quarantine dir, `mv` the file.
- After move: emit `log "quarantined N file(s) to ${QUARANTINE_DIR}"` then call a new `state_set_quarantine(timestamp, count, path)` helper (see §2 for atomic-write pattern).
- The existing allowlist (`\.update-state/`, `\.next/`, ` M tsconfig\.tsbuildinfo`) MUST remain — those paths are never quarantined.

### 2. Atomic state.json write from bash — PIPE-01 + PIPE-02

**Source of truth:** `scripts/update/run-update.sh:136–189` — three existing helpers (`state_set_installing`, `state_set_success`, `state_set_rolled_back`) all use the same python3-heredoc + `os.replace` idiom.

Example (PIPE-02 reuses this verbatim):

```bash
# scripts/update/run-update.sh:174–189
state_set_rolled_back() {
    local reason="$1"
    python3 - "${STATE_FILE}" "${reason}" <<'PYEOF'
import json, os, sys
state_file, reason = sys.argv[1], sys.argv[2]
with open(state_file) as f:
    state = json.load(f)
state["updateStatus"] = "rolled_back"
state["rollbackHappened"] = True
state["rollbackReason"] = reason[:500]
tmp = state_file + ".tmp"
with open(tmp, "w") as f:
    json.dump(state, f, indent=2)
os.replace(tmp, state_file)
PYEOF
}
```

**Key invariants this idiom enforces:**
- Read → mutate → write-tmp → `os.replace` (POSIX-atomic rename). Never leaves a partial file.
- Heredoc is single-quoted (`<<'PYEOF'`) so bash does NOT interpolate inside — the python script receives `${STATE_FILE}` as `sys.argv[1]`, never as a string in the source.
- The `with open()` form means no FD leak even if json.load throws.
- All other fields in the existing state.json are preserved (load → mutate ONE field → dump).

**New helpers PIPE-01 + PIPE-02 must add (mirror this signature):**

```bash
state_set_quarantine() {
    local timestamp="$1"      # epoch ms
    local file_count="$2"
    local dir_path="$3"
    python3 - "${STATE_FILE}" "${timestamp}" "${file_count}" "${dir_path}" <<'PYEOF'
import json, os, sys
state_file, ts, count, path = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
with open(state_file) as f:
    state = json.load(f)
state["lastQuarantine"] = {"timestamp": ts, "fileCount": count, "path": path}
tmp = state_file + ".tmp"
with open(tmp, "w") as f:
    json.dump(state, f, indent=2)
os.replace(tmp, state_file)
PYEOF
}

state_reset_to_idle() {
    # PIPE-02: called from on_error before exit 1. Preserves currentSha, ETag,
    # lastCheckResult, lastQuarantine. Only resets updateStatus + clears the
    # in-progress fields.
    python3 - "${STATE_FILE}" <<'PYEOF'
import json, os, sys
state_file = sys.argv[1]
with open(state_file) as f:
    state = json.load(f)
state["updateStatus"] = "idle"
state["targetSha"] = None
state["updateStartedAt"] = None
tmp = state_file + ".tmp"
with open(tmp, "w") as f:
    json.dump(state, f, indent=2)
os.replace(tmp, state_file)
PYEOF
}
```

### 3. `on_error` trap setup and self-disabling — PIPE-02

**Existing:** `scripts/update/run-update.sh:566–601`.

```bash
on_error() {
    local exit_code="$1"
    local lineno="$2"
    local failed_stage="${CURRENT_STAGE}"
    local error_message="stage=${failed_stage} line=${lineno} exit=${exit_code}"

    log "on_error triggered: ${error_message}"

    # Disable the trap inside the trap so rollback failures don't recursively
    # fire it and loop forever.
    trap - ERR

    case "${failed_stage}" in
        init|lock|preflight_disk|preflight_node|preflight_pnpm|preflight_git|snapshot|drain|stop)
            log "failure in pre-change stage — no rollback needed"
            state_set_rolled_back "${error_message}"
            db_finish_run "failed" "" "${error_message}" ""
            pushover_send "Charging-Master: Update fehlgeschlagen" "Pre-change failure: ${error_message}" "1"
            exit 1
            ;;
    esac
    # ... rollback paths follow
}

trap 'on_error $? $LINENO' ERR
```

**Key invariants:**
- `trap - ERR` inside the trap is the FIRST mutation — kills recursion before any helper that might fail.
- The `case` matches pre-change stages and exits via 1; the rest of the function handles rollback stages.
- `state_set_rolled_back` is called BEFORE `exit 1` — but it writes `updateStatus="rolled_back"`, NOT `idle`.

**Bug PIPE-02 fixes:** Look at the case branch. For preflight failures (the v1.3.1 incident), it calls `state_set_rolled_back` which writes `"rolled_back"`. That is wrong for preflight failures — nothing was actually rolled back (no git op happened). But the active observed failure is different: when **preflight_git** calls `die ...` the script exits with code 1, the trap fires, the case matches `preflight_git`, calls `state_set_rolled_back`... so the state ends `rolled_back`, NOT `installing`.

**Caveat for the planner:** Re-read the actual incident log. CONTEXT.md says state ended `installing`. The trap path above appears to handle preflight failures. Two possibilities:

1. The incident hit `state_set_installing` (L640 of main pipeline) BEFORE preflight (it doesn't — `state_set_installing` is called at L640 AFTER preflight_git at L628). So preflight_git failing should land in the pre-change case and call `state_set_rolled_back`. Why didn't it?
2. Likely answer: `state_set_rolled_back` itself failed (the python heredoc errors silently?) OR an earlier code version did NOT call `state_set_rolled_back` for preflight stages. The current trap is correct on paper but evidently not robust.

**This is the most important open question for the planner.** See Open Questions §1.

PIPE-02's `state_reset_to_idle` should be called UNCONDITIONALLY at the top of `on_error` (after `trap - ERR`), BEFORE the case statement. That way even if `state_set_rolled_back` later fails, `updateStatus` is already `idle`.

### 4. Snapshot retention policy — PIPE-01 mirror

**Existing:** `scripts/update/run-update.sh:283–307` (`do_snapshot`).

```bash
do_snapshot() {
    CURRENT_STAGE="snapshot"
    db_update_stage "${CURRENT_STAGE}"
    mkdir -p "${SNAPSHOT_DIR}"

    # Retain last N-1 so we have room for the new one
    local existing
    existing=$(ls -1t "${SNAPSHOT_DIR}"/*.tar.gz 2>/dev/null | tail -n +${SNAPSHOT_RETAIN} || true)
    if [ -n "${existing}" ]; then
        log "pruning old snapshots"
        echo "${existing}" | xargs -r rm -f
    fi
    # ... then tar -czf the new one
}
```

`SNAPSHOT_RETAIN=3` declared at L35.

**Pattern for PIPE-01 quarantine retention:** Mirror this exactly.

```bash
readonly QUARANTINE_RETAIN=3   # add near L35–38
# Inside preflight_git BEFORE creating the new quarantine dir:
local existing_quar
existing_quar=$(ls -1td "${STATE_DIR}"/quarantine-* 2>/dev/null | tail -n +${QUARANTINE_RETAIN} || true)
if [ -n "${existing_quar}" ]; then
    log "pruning old quarantine dirs"
    echo "${existing_quar}" | xargs -r rm -rf
fi
```

Key differences from snapshot pattern:
- `ls -1td` (the `d` flag) because quarantines are directories, not files.
- `xargs -r rm -rf` not `rm -f` because we are removing dirs.
- Same `-r` (xargs `--no-run-if-empty`) safety.

### 5. Host-guard pattern — PIPE-03 + PIPE-04

**Two host-guard idioms exist in the codebase.** PIPE-04 (internal endpoint) must use the inline-localhost-only idiom, NOT `isAllowedBrowserHost`.

**Idiom A — inline localhost-only (used by `/api/internal/prepare-for-shutdown`):** `src/app/api/internal/prepare-for-shutdown/route.ts:15–49`.

```typescript
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function isLocalhostHost(request: Request): boolean {
  const raw = request.headers.get('host');
  if (!raw) return false;
  const host = raw.startsWith('[')
    ? raw.slice(0, raw.indexOf(']') + 1)
    : raw.split(':')[0];
  return ALLOWED_HOSTS.has(host);
}

export async function POST(request: Request): Promise<Response> {
  if (!isLocalhostHost(request)) {
    return Response.json({ error: 'forbidden' }, { status: 403, headers: NO_CACHE_HEADERS });
  }
  // ...
}
```

- NO `charging-master.local` in the allowlist — strictly loopback.
- `NO_CACHE_HEADERS = { 'Cache-Control': 'no-store, no-cache, must-revalidate' }` (L36).
- Bracketed IPv6 handled; port stripped.

**Idiom B — `isAllowedBrowserHost` (broader allowlist via `src/lib/host-guard.ts`):** Used by browser-facing endpoints (`/api/update/trigger`, `/api/update/ack-rollback`). Allowlist also includes `charging-master.local` + `UPDATE_ALLOWED_HOSTS` env override.

**PIPE-04 decision:** Use Idiom A. CONTEXT.md §PIPE-04 explicitly says "same allowlist as `/api/internal/prepare-for-shutdown`" + "NOT exposed in any UI. Available only via SSH-from-LXC curl." Copy `ALLOWED_HOSTS` + `isLocalhostHost` inline (do not extend `host-guard.ts`).

**PIPE-03 decision:** The admin DELETE is called from the browser (the `/settings/update-state` page). It must use Idiom B (`isAllowedBrowserHost`) so `charging-master.local` works. Mirror `src/app/api/update/ack-rollback/route.ts:11–25` for the import + guard call.

### 6. UpdateState shape + UpdateStateStore atomic write — PIPE-01 type/store

**Type extension:** `src/modules/self-update/types.ts:39–78`. Add to `UpdateState`:

```typescript
export type UpdateState = {
  // ... existing fields ...
  /**
   * Most-recent untracked-file quarantine from preflight_git. `null` until a
   * quarantine event occurs. Written by the bash updater (state_set_quarantine
   * heredoc); read by /api/update/status and surfaced via UpdateInfoView.
   */
  lastQuarantine?: {
    timestamp: number;       // epoch ms
    fileCount: number;       // number of files moved
    path: string;            // absolute path of the quarantine dir
  } | null;
};
```

And to `DEFAULT_UPDATE_STATE`: `lastQuarantine: null,`.

And to `UpdateInfoView`: same optional field (so the frontend sees it).

**Store write — no logic change needed.** `UpdateStateStore.write(patch)` at `update-state-store.ts:70–75` already merges via `{ ...current, ...patch }`. The bash updater writes the field via its python heredoc; Node just reads it back. Existing state.json files without `lastQuarantine` parse fine because TypeScript declares it optional and `JSON.parse` simply yields `undefined` for missing keys.

### 7. UpdateBanner state machine — PIPE-03 insertion point

**File:** `src/app/settings/update-banner.tsx` (NOT `src/components/update/update-banner.tsx` — that path does not exist; CONTEXT.md is imprecise about the location). The component lives next to the page in `src/app/settings/`.

**Priority-ordered render chain (existing):**

| Order | Condition | Component code |
|---|---|---|
| 1 | `info.rollbackHappened && !rollbackDismissed` | red rollback banner — L243–276 |
| 2 | `flow.kind === 'triggered' \|\| flow.kind === 'streaming'` | live install — L279–292 |
| 3 | `flow.kind === 'reconnecting'` | reconnect overlay — L295–306 |
| 4 | `flow.kind === 'error'` | inline error — L309–323 |
| 5 | `info.updateAvailable && info.remote` | green "Update verfügbar" — L326–391 |
| 6 | `info.lastCheckStatus === 'error'` | amber error — L394–421 |
| 7 | `info.lastCheckStatus === 'rate_limited'` | amber rate-limit — L424–455 |
| 8 | else | grey idle / never-checked — L458–495 |

**Where PIPE-03's quarantine info state slots in:** AFTER the rollback banner (priority 1, which trumps everything) but BEFORE the install/streaming states (priority 2+). Rationale: rollback is critical, quarantine is informational; it should not hide an active install but should be visible when idle.

Suggested insertion: between L276 (end of rollback) and L278 (start of streaming). The render returns `<>...</>` so the quarantine info can sit alongside an idle banner — but for simplicity, render it as a discrete priority slot at L277 with `return ( ... )` like every other state.

**Required field surfacing:** `info.lastQuarantine` must be exposed in `UpdateInfoView` (see §6). The state-derivation function `deriveUpdateInfoView` (in `src/modules/self-update/update-info-view.ts`, not read but referenced by store at L86) must pass it through.

### 8. Settings sibling page pattern — PIPE-03

**Existing:** `/settings` lives at `src/app/settings/page.tsx`. There is NO existing sibling-page pattern under `/settings/*` — `/settings/update-state/page.tsx` will be the first.

The closest sibling-page convention in the codebase is from elsewhere:
- `src/app/profiles/learn/page.tsx` (sibling of `src/app/profiles/page.tsx`)
- `src/app/history/[sessionId]/page.tsx` (child of `src/app/history/page.tsx`)

Both are pure App Router file-routing — drop a new dir + `page.tsx` and the route works. No router config edits needed.

**Template — server component reading domain data:** `src/app/settings/page.tsx` (full file, 92 lines).

```typescript
import { UpdateStateStore } from '@/modules/self-update/update-state-store';
// ...
export const dynamic = 'force-dynamic';

function getInitialUpdateInfo(): UpdateInfoView {
  try {
    return new UpdateStateStore().getUpdateInfo();
  } catch {
    return { /* fallback view */ };
  }
}

export default async function SettingsPage() {
  // ... server-side data load ...
  return ( /* JSX */ );
}
```

PIPE-03's `/settings/update-state/page.tsx` follows the same shape:
1. `export const dynamic = 'force-dynamic'` (always re-render).
2. Read state.json via `UpdateStateStore`, derive most-recent quarantine path.
3. `readdirSync` (node:fs) the quarantine dir to list filenames.
4. Render the list + a client child `<QuarantineList>` that owns the DELETE button.

### 9. Existing internal route schema — PIPE-04 mirror

`src/app/api/internal/prepare-for-shutdown/route.ts` is the ENTIRE prior art for internal routes. Full anatomy (125 lines):

| Section | Lines | What |
|---|---|---|
| Imports | 1 | `import { sqlite } from '@/db/client'` |
| Route config | 3–4 | `export const runtime = 'nodejs'; export const dynamic = 'force-dynamic'` |
| Allowlist | 15 | `new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])` |
| Timeout const | 21 | `DRAIN_HARD_TIMEOUT_MS = 5_000` |
| Response types | 23–34 | discriminated union `DrainOk | DrainErr` |
| Headers const | 36–38 | `NO_CACHE_HEADERS = { 'Cache-Control': 'no-store, no-cache, must-revalidate' }` |
| Host check fn | 40–49 | `isLocalhostHost(request)` |
| POST handler | 70–124 | guard → main work → typed Response |

**PIPE-04 must add (after the guard, before the response):**
- Read state.json via `UpdateStateStore`.
- `store.write({ updateStatus: 'idle', targetSha: null, updateStartedAt: null })` — preserves everything else by spread-merge.
- `db.insert(updateRuns).values({ startAt: new Date(), endAt: new Date(), fromSha: <state.currentSha>, status: 'recovery_reset', stage: 'manual', errorMessage: 'manual reset via /api/internal/reset-update-state' }).run()` — wait, see §10 below about the enum.
- Return `200 { ok: true }`.

### 10. `update_runs` schema — PIPE-04 status enum CAVEAT

**Existing:** `src/db/schema.ts:239–251`.

```typescript
export const updateRuns = sqliteTable('update_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  startAt: integer('start_at', { mode: 'timestamp_ms' }).notNull(),
  endAt: integer('end_at', { mode: 'timestamp_ms' }),
  fromSha: text('from_sha').notNull(),
  toSha: text('to_sha'),
  status: text('status', {
    enum: ['running', 'success', 'failed', 'rolled_back'] as const,
  }).notNull(),
  stage: text('stage'),
  errorMessage: text('error_message'),
  rollbackStage: text('rollback_stage'),
});
```

**THIS IS THE BIGGEST GOTCHA.** `status` is a Drizzle TypeScript enum, not a SQLite CHECK constraint. The runtime DB column is plain `text` — SQLite accepts any string. But TypeScript inserts `db.insert(updateRuns).values({ status: 'recovery_reset' })` will FAIL TYPE-CHECK because `'recovery_reset'` isn't in the enum.

**PIPE-04 requires a schema edit:** add `'recovery_reset'` to the enum tuple:

```typescript
  status: text('status', {
    enum: ['running', 'success', 'failed', 'rolled_back', 'recovery_reset'] as const,
  }).notNull(),
```

This is a **TypeScript-only** change — no SQL migration needed because the underlying column is `text` with no CHECK. Existing rows are unaffected. New rows can use the new value. **The CONTEXT.md claim "confirm no schema migration needed" is TRUE for SQL; FALSE for TypeScript.** Make this explicit in the plan.

Also note the bash updater's `db_start_run` / `db_finish_run` (L92–132 of run-update.sh) writes status as a raw string — `'recovery_reset'` would slip in there too without complaint. PIPE-04 only inserts from TypeScript (the new route) so this is straightforward.

**Drizzle insert pattern reference:** `src/app/api/profiles/[id]/route.ts:254–258` shows the `db.insert(priceHistory).values({...}).run()` shape (better-sqlite3 + `.run()` for sync inserts). Mirror exactly.

### 11. Dry-run testing harness — PIPE-01 + PIPE-02 verification

**Existing:** `scripts/update/dry-run-helpers.sh` (258 lines).

How the harness works (L58–82):
1. `sed`-filters `run-update.sh` to:
   - Strip `main "$@"` (so sourcing doesn't run the pipeline).
   - Strip `readonly` (so constants are reassignable).
   - Strip `mkdir -p "${STATE_DIR}"` + the `exec 9>...` / `flock` block (no real install dir on dev).
   - Convert `set -euo pipefail` → `set -uo pipefail` (no `-e` so a single helper failure doesn't abort the harness).
2. Sources the filtered file.
3. Removes ERR + EXIT traps.
4. Overrides constants (`INSTALL_DIR=/tmp/cm-dry-run`, etc.).
5. Stubs DB + state helpers (`db_start_run`, `state_set_installing`, `pushover_send`) with no-ops.
6. Runs individual stage helpers and asserts via `pass`/`fail`/`warn`.

**PIPE-01 test additions (sketch):**

```bash
# Test 5: preflight_git quarantine path
info "=== Test 5: preflight_git quarantine ==="
QUAR_SCRATCH="${SCRATCH}/quarantine-test"
mkdir -p "${QUAR_SCRATCH}" && cd "${QUAR_SCRATCH}"
git init -q && git commit --allow-empty -m "initial" -q
touch untracked-debug.ts
INSTALL_DIR="${QUAR_SCRATCH}" STATE_DIR="${QUAR_SCRATCH}/.update-state" \
  preflight_git 2>&1 | tee /tmp/test5.log
if [ -d "${QUAR_SCRATCH}/.update-state"/quarantine-* ]; then
  pass "preflight_git: untracked file moved to quarantine dir"
else
  fail "preflight_git: quarantine dir not created"
fi
[ ! -f "${QUAR_SCRATCH}/untracked-debug.ts" ] && pass "preflight_git: original file removed" || fail "..."
```

**PIPE-02 test additions:** Inject a `false` early in `preflight_disk`, run the trap, then `cat .update-state/state.json | jq .updateStatus` must equal `"idle"`. The harness already removes the ERR trap (L86–87), so PIPE-02's test will need to re-install it OR test `state_reset_to_idle` directly as a unit.

### 12. Server-action delete in Next.js 15 — PIPE-03 fallback pattern

**No `'use server'` action files exist in this codebase.** Codebase search confirmed: `grep -rln "use server"` returns only `src/app/api/version/route.ts` (a comment, not a server action).

**Established alternative pattern: client `fetch(..., { method: 'DELETE' })` + `useState` reload.** Five existing examples:
- `src/app/chargers/page.tsx:96` — `await fetch(`/api/chargers/${id}`, { method: 'DELETE' })`
- `src/app/history/page.tsx:118` — same shape
- `src/app/profiles/[id]/page.tsx:233` — same shape
- `src/app/devices/device-manager.tsx:169` — same shape
- `src/components/charging/profile-photo-gallery.tsx:71` — same shape

**Recommendation for PIPE-03:** Stick with this established `fetch + DELETE` pattern. Create `src/app/settings/update-state/quarantine-list.tsx` as a `'use client'` component that:
1. Receives the file list as a prop (server-rendered by the page).
2. Renders "Alle löschen" button.
3. `onClick`: `await fetch('/api/admin/update-state/quarantine', { method: 'DELETE' })` then `router.refresh()` (from `next/navigation`) or `window.location.reload()`.

Closest analog for the click → DELETE → refresh flow: `src/app/settings/update-banner.tsx:218–231` `handleAckRollback` (POST, then `refreshInfo()`). Copy that idiom; substitute DELETE.

---

## Anti-patterns to avoid

1. **Do NOT introduce a new state.json write idiom.** Five existing call sites (3 bash helpers + 2 TS write paths) use python3-heredoc-`os.replace` (bash) and `writeFileSync(tmp) + renameSync` (TS). Any new helper must reuse one of these — never plain `>` redirect or `writeFileSync(STATE_FILE)`.

2. **Do NOT delete the existing `state_set_rolled_back` call from `on_error`'s pre-change case.** PIPE-02 ADDS a `state_reset_to_idle` call at the top of `on_error` (before the case). The existing `state_set_rolled_back` for pre-change failures still runs and sets `rollbackHappened=true` + `rollbackReason`. The new helper just guarantees `updateStatus` is `idle` even if `state_set_rolled_back` fails.

3. **Do NOT use `git status --porcelain` without `-z`** in PIPE-01. The current code does (L273) and would mangle a filename with spaces. New code must use `git status --porcelain -z` + `xargs -0` (or a `while IFS= read -r -d ''` loop).

4. **Do NOT call `isAllowedBrowserHost` for PIPE-04** — it would let `charging-master.local` (LAN hostname) hit the recovery endpoint. CONTEXT.md mandates 127.0.0.1-only. Use the inline `isLocalhostHost` shape from `prepare-for-shutdown/route.ts:40–49`.

5. **Do NOT write a SQL migration for `update_runs.status`** — the column is plain `text` and accepts any string. Only the Drizzle TS enum needs widening. Adding a `.sql` migration file would be wasted work and would NOT take effect (SQLite has no enum constraint).

6. **Do NOT model the quarantine in `update_runs`.** It's a fs artifact + a one-shot field in state.json. Adding a `quarantines` table or a `update_runs.quarantine_path` column doubles the surface for no win. The CONTEXT.md spec explicitly says state.json + fs only.

7. **Do NOT trust `git status --porcelain` after `cd "${INSTALL_DIR}"` if the cwd isn't a git working tree** — the script's `main()` does `cd "${INSTALL_DIR}"` at L616 BEFORE `preflight_git` at L628, so this is safe. But the dry-run harness uses a fresh `git init`-ed scratch dir (see Test 5 sketch above) — make sure the test sets cwd correctly.

8. **Do NOT mark the new admin DELETE endpoint as `runtime = 'edge'`.** It needs node:fs to `rm -rf` the quarantine dir. Use `runtime = 'nodejs'` like every other internal route.

9. **Do NOT bundle PIPE-03's quarantine list into the existing `<UpdateBanner>`.** CONTEXT.md is explicit: banner shows "info state with link", the `/settings/update-state` page does the listing. Keep them separate so the banner stays small and the admin page is the single place files are enumerated.

10. **Do NOT skip the snapshot-retention prune in PIPE-01 quarantine handling.** Without it, every deploy with an untracked file leaks a directory under `.update-state/quarantine-*/`. 3-retention mirrors snapshots; pick the same number for consistency.

---

## Open questions for the planner

1. **Why did the v1.3.1 incident leave `updateStatus="installing"` instead of `"rolled_back"`?** The current `on_error` trap (L580–586) calls `state_set_rolled_back` for `preflight_git` failures. If that ran, state would be `rolled_back` (the red banner state), not `installing`. Either:
   - (a) the trap's case branch didn't execute (e.g., `state_set_rolled_back` python heredoc errored silently in `set -euo pipefail` mode, the `||` after it isn't present),
   - (b) the deployed `run-update.sh` on 192.168.3.185 was an older version,
   - (c) `state_set_installing` (L640) somehow ran before preflight (impossible per main() ordering, but worth a sanity check via journalctl).

   Until this is answered, PIPE-02's design ("always reset to idle at top of trap") may mask the real failure mode. Recommend: planner asks the user to grab `journalctl -u charging-master-updater --since '2026-05-15'` from 185 to see the exact stage progression at incident time.

2. **Should quarantined files be visible via the admin page's file list, or just counts + a "delete all"?** CONTEXT.md says "lists filenames; no content viewing". Confirm: filenames only, no file size / mtime / preview.

3. **Host-guard tests — should we add a new test for `/api/internal/reset-update-state` even though `/api/internal/prepare-for-shutdown` has none?** CONTEXT.md DoD §"Unit test verifies the host-guard rejects non-localhost requests" mandates it for PIPE-04. The closest test scaffold is `src/app/api/charging/sessions/[id]/route.test.ts` (vi.mock pattern). Plan to mirror that shape; expect ~80-line test file.

4. **Where does `deriveUpdateInfoView` live and does it need editing for `lastQuarantine`?** Referenced at `update-state-store.ts:86` but its source `src/modules/self-update/update-info-view.ts` wasn't read. The planner should read it to confirm the field gets passed through. (Almost certainly yes — every other UpdateInfoView field is a direct copy from UpdateState.)

5. **Does `router.refresh()` from `next/navigation` work cleanly here, or should the page do a hard reload?** `router.refresh()` re-runs the server component but reuses the same React tree — it should drop the deleted quarantine dir from the listing. `window.location.reload()` is heavier but guaranteed. Closest existing analog is `setRollbackDismissed(true) + refreshInfo()` (banner) — that uses state, not router refresh. New choice; plan-author preference.

6. **Should the quarantine info banner state also surface in the `UpdateInfoView` of `/api/update/status` even when stale?** I.e., if `lastQuarantine.timestamp` is from 30 days ago + a successful update has happened since, should we still show the info banner? CONTEXT.md says "WHEN `state.lastQuarantine.timestamp > state.lastSuccessfulUpdateAt`". There is NO `lastSuccessfulUpdateAt` field in current UpdateState. Either add it OR use `currentSha != state.lastQuarantine.afterSha` (also missing). Planner needs to pick a definition of "most-recent".

7. **PIPE-01 quarantine of files outside `git status --porcelain` scope (e.g., files under `.gitignore`d dirs)?** `.update-state/` itself is ignored. A diagnostic script in `.update-state/scripts/` would not show in `git status --porcelain` — so PIPE-01 only catches untracked files git CAN see. This is correct: gitignored = not git's problem = not preflight's problem. Worth a one-line comment in the bash code explaining why.

---

## Metadata

- **Files read (12):** CONTEXT.md, REQUIREMENTS.md, CLAUDE.md, run-update.sh, host-guard.ts, update-state-store.ts, types.ts, prepare-for-shutdown/route.ts, dry-run-helpers.sh, update-banner.tsx (src/app/settings/), settings/page.tsx, profiles/[id]/route.ts, update/status/route.ts, update/ack-rollback/route.ts, update/trigger/route.ts, update-history.tsx, db/schema.ts, update/history/route.ts
- **Files scanned (Glob/Grep, no read):** components/update/, app/settings/, app/api/internal/, db/, scripts/update/, all test files
- **Stop reason:** All 12 patterns in the task spec mapped with file:line cites; no analog ambiguity remains except where flagged in Open Questions.
