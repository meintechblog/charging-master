---
phase: 13-update-pipeline-hardening
plan: 01
subsystem: self-update
tags: [updater, preflight, quarantine, on_error, state-json, bash, pipe-01, pipe-02]
requirements: [PIPE-01, PIPE-02]
dependency_graph:
  requires: []
  provides:
    - "UpdateState.lastQuarantine + UpdateInfoView.lastQuarantine (consumed by 13-03 admin DELETE + 13-04 UI banner)"
    - "state_set_quarantine bash helper (called by preflight_git)"
    - "state_set_idle_clearing_inprogress bash helper (called by on_error)"
    - "QUARANTINE_RETAIN constant + .update-state/quarantine-* tar exclude"
  affects:
    - scripts/update/run-update.sh
    - src/modules/self-update/types.ts
    - src/modules/self-update/update-info-view.ts
    - scripts/update/dry-run-helpers.sh
tech_stack:
  added: []
  patterns:
    - "Atomic state.json write via python3 + os.replace (mirrors existing state_set_installing/success/rolled_back)"
    - "NUL-delimited `git status -z --porcelain` parsing via `while IFS= read -r -d ''`"
    - "Quarantine directory layout: .update-state/quarantine-YYYYMMDD-HHMMSS[-tryN]/ with preserved path structure"
    - "Retention pattern mirroring SNAPSHOT_RETAIN: ls -1td | tail -n +(N+1) | xargs -r rm -rf"
    - "on_error trap self-disable via `trap - ERR` + idempotent reset before case-arm"
key_files:
  created: []
  modified:
    - scripts/update/run-update.sh
    - src/modules/self-update/types.ts
    - src/modules/self-update/update-info-view.ts
    - scripts/update/dry-run-helpers.sh
decisions:
  - "Quarantine dirs share .update-state/ with snapshots (single state-dir, single ownership)"
  - "QUARANTINE_RETAIN=3 (mirrors SNAPSHOT_RETAIN=3 — cheap on disk, sufficient for forensic review)"
  - "Path persisted to state.lastQuarantine is absolute (no relative-path ambiguity for the UI's DELETE call)"
  - "preflight_git quarantines '??' entries only; ANY tracked-file modification (M/A/D/R/C/unmerged) remains fatal — never silently discard human work"
  - "on_error calls state_set_idle_clearing_inprogress BEFORE state_set_rolled_back; latter overrides when it succeeds (red banner), former survives if rolled_back write itself fails (the 2026-05-15 incident class)"
  - "Pre-existing state.json files written before this plan are backwards compatible — lastQuarantine is optional, JSON.parse yields undefined, UI treats undefined/null identically"
metrics:
  duration_seconds: 314
  duration_human: "~5m"
  tasks_completed: 5
  files_modified: 4
  commits: 5
  completed_at: "2026-05-15T03:13:08Z"
---

# Phase 13 Plan 01: Preflight Quarantine + on_error Idle Reset Summary

Hardened the bash updater pipeline against the two defects that bricked the 2026-05-15 v1.3.1 deploy: (a) PIPE-01 — preflight_git no longer dies on untracked files; it moves them to `.update-state/quarantine-<ts>/` and continues. (b) PIPE-02 — on_error unconditionally resets `state.json:updateStatus` to `idle` before exiting non-zero, so a failed preflight no longer strands the pipeline at 409 "already in progress".

## Tasks Completed

| # | Task | Commit |
|---|------|--------|
| 1 | Extend UpdateState type with lastQuarantine field (+ pass-through in UpdateInfoView) | `a7ec0bd` |
| 2 | Add `state_set_quarantine` + `state_set_idle_clearing_inprogress` bash helpers + QUARANTINE_RETAIN | `fab0add` |
| 3 | Wire `on_error` to call `state_set_idle_clearing_inprogress` (PIPE-02) | `19f1cd4` |
| 4 | Rewrite `preflight_git` with `git status -z --porcelain` + quarantine + tar exclude (PIPE-01) | `6f06655` |
| 5 | Extend `dry-run-helpers.sh` with Tests 5 (quarantine happy-path) + 6 (idle reset) | `2527f3a` |

## Diffs

### preflight_git (before → after)

Before — 8 lines, single regex allowlist:
```bash
preflight_git() {
    CURRENT_STAGE="preflight_git"
    local dirty
    dirty=$(git status --porcelain | grep -vE '^\?\? \.update-state/|^\?\? \.next/|^ M tsconfig\.tsbuildinfo' || true)
    if [ -n "${dirty}" ]; then
        die "Working tree has unexpected changes: ${dirty}"
    fi
    log "git working tree clean"
}
```

After — partitioned NUL-loop + quarantine pipeline (~85 lines, line 326+ in `scripts/update/run-update.sh`). Key invariants:
- `while IFS= read -r -d '' entry; do ... done < <(git status -z --porcelain)` — NUL-delimited parsing, no regex on filenames.
- `code="${entry:0:2}"`, `path="${entry:3}"`. `??` → quarantine candidate; everything else → fatal.
- `.update-state/*` and `.next/*` excluded from quarantine via `case` inside the loop (replaces the old grep allowlist).
- `qdir="${STATE_DIR}/quarantine-$(date +%Y%m%d-%H%M%S)"` with `-tryN` suffix (n up to 10) for same-second re-trigger collision.
- Per-file `mkdir -p "$(dirname "${dest}")"` + `mv` (preserves symlinks, atomic intra-fs).
- Retention prune via `ls -1td "${STATE_DIR}"/quarantine-* | tail -n +$((QUARANTINE_RETAIN + 1)) | xargs -r rm -rf`.
- `epoch_ms=$(date +%s%3N)` → `state_set_quarantine "${epoch_ms}" "${#untracked[@]}" "${qdir}"`.

### on_error reset wiring

Inserted at line 575 inside `on_error()`, two lines after `trap - ERR`:
```bash
# PIPE-02: unconditional idle reset before any case-arm bookkeeping.
state_set_idle_clearing_inprogress || true
```
The existing `state_set_rolled_back` call inside the pre-change case-arm (`init|lock|preflight_*|snapshot|drain|stop`) is unchanged — when it succeeds it overrides `updateStatus="idle"` to `"rolled_back"` (red banner shows). When it fails (the 2026-05-15 incident class), the earlier `idle` write survives so the next `/api/update/trigger` does NOT 409.

### types.ts (the three additions)

```diff
@@ UpdateState (line 65 region) @@
   rollbackStage?: 'stage1' | 'stage2' | null;
+  /** Phase 13 (PIPE-01) ... */
+  lastQuarantine?: { timestamp: number; fileCount: number; path: string } | null;
 };

@@ DEFAULT_UPDATE_STATE @@
   rollbackStage: null,
+  lastQuarantine: null,
 };

@@ UpdateInfoView @@
   inProgressUpdate?: { ... };
+  /** Surfaced from UpdateState ... Cleared by DELETE /api/admin/update-state/quarantine (Plan 13-03). */
+  lastQuarantine?: { timestamp: number; fileCount: number; path: string } | null;
 };
```

### update-info-view.ts

```diff
@@ base literal @@
     rollbackStage: state.rollbackStage ?? null,
+    lastQuarantine: state.lastQuarantine ?? null,
     ...(inProgressUpdate !== undefined ? { inProgressUpdate } : {}),
```

### Tarball exclude

```diff
@@ do_snapshot tar (line 432 region) @@
         --exclude='./.update-state/snapshots' \
+        --exclude='./.update-state/quarantine-*' \
         --exclude='./data/*.db-wal' \
```

## Test Results

### Vitest baseline — 240/240 passing (no regression)

```
 Test Files  17 passed (17)
      Tests  240 passed (240)
   Duration  4.63s
```

### Dry-run Tests 5 + 6 (executed locally on macOS bash 3.2)

```
=== Test 5: preflight_git quarantine (Phase 13 PIPE-01) ===
[stage=preflight_git] quarantined 2 file(s) to /tmp/cm-dry-run/quarantine-test/.update-state/quarantine-20260515-051218
[stage=preflight_git] git working tree clean (after quarantine)
[PASS] Test 5: quarantine dir created
[PASS] Test 5: original untracked files removed from working tree
[PASS] Test 5: both quarantined files found under qdir (directory structure preserved)
[PASS] Test 5: state_set_quarantine called with count=2

=== Test 6: state_set_idle_clearing_inprogress (Phase 13 PIPE-02) ===
[PASS] Test 6: updateStatus=idle, targetSha=null, updateStartedAt=null; all other fields preserved
```

Test 5 exercises the nested-path case (`scripts/tmp/stray.log`) which verifies the `mkdir -p "$(dirname "${dest}")"` step. Test 6 mutates a scratch state.json (not the real one) and asserts via python3 that only the three in-progress fields move while `currentSha`, `rollbackSha`, `lastCheckResult`, `rollbackHappened`, `lastQuarantine` all survive untouched.

### TypeScript

`pnpm exec tsc --noEmit` → exit 0, no errors.

### Bash syntax

`bash -n scripts/update/run-update.sh` → OK.
`bash -n scripts/update/dry-run-helpers.sh` → OK.

## Deviations from Plan

None. The research was pre-committed in `RESEARCH.md` and `PATTERNS.md`; the executor mirrored Pitfall 1–18 exactly. No Rule 1/2/3 auto-fixes were needed.

One cosmetic observation: on macOS BSD `date`, `%s%3N` produces a literal `N` suffix (`17788147383N` in the harness log). The plan documents this in RESEARCH Assumption A3 — on the actual Debian 13 LXC target, GNU coreutils returns proper millisecond precision. Test 5 asserted `count=2` (not the timestamp), so the macOS quirk did not affect the test outcome.

## Auth Gates

None.

## Known Stubs

None — all wiring is real. Helpers do not yet have UI consumers in this plan (the lastQuarantine banner ships in Plan 13-04, the admin DELETE in Plan 13-03). The `UpdateInfoView.lastQuarantine` field is currently surfaced through `/api/update/status` but no UI component reads it yet — this is intentional per the wave-1 / wave-3 split in the phase plan.

## Threat Flags

None — no new network endpoints, auth paths, or trust-boundary surfaces introduced. The new bash helpers run as root inside the existing updater service; the new TS field is a passive data carrier with no behavior change in any API route.

## Self-Check: PASSED

- `scripts/update/run-update.sh` — exists, syntax OK, contains `state_set_quarantine`, `state_set_idle_clearing_inprogress`, `QUARANTINE_RETAIN`, `git status -z --porcelain`, `quarantine-*` tar exclude.
- `src/modules/self-update/types.ts` — exists, contains `lastQuarantine` on UpdateState, DEFAULT_UPDATE_STATE, and UpdateInfoView.
- `src/modules/self-update/update-info-view.ts` — exists, contains `lastQuarantine: state.lastQuarantine ?? null,` in the base view literal.
- `scripts/update/dry-run-helpers.sh` — exists, syntax OK, Tests 5 + 6 PASS locally.
- Commits `a7ec0bd`, `fab0add`, `19f1cd4`, `6f06655`, `2527f3a` — all present in `git log --oneline -7`.
