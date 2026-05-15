# Phase 13 Plan-Check — Update Pipeline Hardening

**Verdict:** PASS (with two MINOR warnings + one DOCUMENTATION clarification)
**Checked:** 2026-05-15
**Plans verified:** 13-01, 13-02, 13-03, 13-04 (4 plans, 3 waves)
**Mode:** Goal-backward — start from CONTEXT.md §Definition of Done and trace each line back to plan tasks.

---

## Coverage Summary

| Requirement | Plan(s) | Status |
|---|---|---|
| PIPE-01 — preflight quarantines untracked-only, surfaces `lastQuarantine` | 13-01 (Task 1 + 2 + 4 + 5) | Covered |
| PIPE-02 — `on_error` always resets `updateStatus` to idle | 13-01 (Task 2 + 3) | Covered |
| PIPE-03 — banner info state + admin page + DELETE clears | 13-03 (backend DELETE), 13-04 (banner + page + client) | Covered |
| PIPE-04 — `POST /api/internal/reset-update-state` localhost-only + audit row | 13-02 (Task 1 + 2 + 3) | Covered |

All four requirement IDs from REQUIREMENTS.md (PIPE-01..04) appear in at least one plan's `requirements:` frontmatter:
- 13-01: `[PIPE-01, PIPE-02]`
- 13-02: `[PIPE-04]`
- 13-03: `[PIPE-03]`
- 13-04: `[PIPE-03]`

---

## Goal-Backward DoD Trace

CONTEXT.md §Definition of Done has six concrete acceptance bullets. Each traced to plan task(s):

| DoD Bullet | Plan(s) Covering | Status |
|---|---|---|
| Preflight quarantine: inject untracked file → log `[stage=preflight_git] quarantined 1 file(s)` → update proceeds | 13-01 Task 4 (rewrites preflight_git, uses `git status -z --porcelain`, emits the exact log line at the SSE-parser-compatible position) | Verified |
| `on_error` state reset: inject preflight failure → state.json.updateStatus == "idle" | 13-01 Task 2 (new helper) + Task 3 (wires it into on_error BEFORE the case block) | Verified |
| Recovery endpoint: localhost curl → 200 + audit row, non-localhost → 403 | 13-02 Task 2 (route handler with `isLocalhostHost` verbatim copy from prepare-for-shutdown) + Task 3 (tests 1+4+5+6 cover both halves) | Verified |
| Admin page: visit /settings/update-state → file list → "Alle löschen" → banner clears | 13-04 Task 2 (server page) + Task 3 (client component) + 13-03 Task 1 (DELETE endpoint) — full chain | Verified |
| No regressions: existing 240 tests pass, normal update flow unchanged | All plans declare in `<verification>` that the 240 baseline must remain green; cumulative target is 269 (240 + 10 + 9 + 10) | Verified — no plan modifies prior-shipping behavior, only additive |
| Manual smoke on 185 + 117: repeat 2026-05-15 incident | Not a plan task — operator action post-deploy. Plans document smoke setup in 13-03 + 13-04 `<verification>` sections | Documented |

All six DoD bullets have plan coverage.

---

## Dimension-by-Dimension Verification

### Dimension 1: Requirement Coverage — PASS

Every PIPE-XX requirement has a covering task. The `requirements:` field is populated in every plan's frontmatter. No partial coverage, no requirement scattered without a clear primary owner.

Note that PIPE-03 is intentionally split across two plans (13-03 backend, 13-04 UI). Both list PIPE-03. This is correct because they implement different slices, and the dependency edge 13-04 → 13-03 is captured in `depends_on`.

### Dimension 2: Task Completeness — PASS

All 14 tasks across the 4 plans carry `<files>` + `<action>` + `<verify>` + `<done>`. Spot-checks:
- 13-01 Task 4 (preflight rewrite): the longest action; spells out 12 numbered invariants from RESEARCH Pitfalls 1–6, 15, plus the snapshot-tar exclude, plus retention prune. Verify command uses `bash -n` plus grep counts. Done criteria are countable.
- 13-02 Task 3: 10 numbered test cases all with specific assertions. Verify runs the test file directly.
- 13-04 Task 1: refactor is described branch-by-branch (8 branches enumerated, 1 explicitly untouched). The wrap pattern `<>{quarantineBanner}<div/></>` is uniform.

No vague "implement X" tasks. No empty `<verify>` blocks.

### Dimension 3: Dependency Correctness — PASS

Dependency graph:
```
13-01 (wave 1, []) ─┬─→ 13-02 (wave 2, [13-01]) ────┐
                    └─→ 13-03 (wave 2, [13-01]) ──→ 13-04 (wave 3, [13-01, 13-03])
```
- No cycles.
- All referenced plans exist.
- Wave numbers consistent: 13-04 depends on max(1, 2)+1 = 3. Correct.
- 13-02 and 13-03 declare no inter-dependency (verified: `files_modified` arrays are disjoint — 13-02 touches schema/history/internal/reset, 13-03 touches admin/quarantine). They can execute in parallel within wave 2.

### Dimension 4: Key Links Planned — PASS

Every artifact created has at least one explicit wire. Spot-checks against the must_haves.key_links blocks:

| Key Link | Plan | Wired in Task |
|---|---|---|
| preflight_git → state_set_quarantine | 13-01 | Task 4 step 11 calls `state_set_quarantine ${epoch_ms} ${#untracked[@]} ${qdir}` |
| on_error → state_set_idle_clearing_inprogress | 13-01 | Task 3 inserts the call immediately after `trap - ERR` |
| update-info-view → UpdateInfoView consumers | 13-01 | Task 1 adds `lastQuarantine: state.lastQuarantine ?? null` to the `base` literal |
| reset-update-state → UpdateStateStore | 13-02 | Task 2 body calls `store.write({ updateStatus: 'idle', targetSha: null, updateStartedAt: null })` |
| reset-update-state → updateRuns | 13-02 | Task 2 body calls `db.insert(updateRuns).values({...}).run()` |
| QuarantineList button → DELETE endpoint | 13-04 | Task 3 body: `fetch('/api/admin/update-state/quarantine', { method: 'DELETE' })` |
| Banner → admin page | 13-04 | Task 1: `<Link href="/settings/update-state">` |

No artifact created without a corresponding wiring task.

### Dimension 5: Scope Sanity — PASS (one borderline)

| Plan | Tasks | Files Modified | Verdict |
|---|---|---|---|
| 13-01 | 5 | 4 | Borderline-high but acceptable |
| 13-02 | 3 | 4 | Within budget |
| 13-03 | 2 | 2 | Within budget |
| 13-04 | 4 | 5 | Within budget |

**13-01 has 5 tasks**, which is the warning threshold. Justification accepted because:
- Tasks 1–3 are small (type extension, two bash helpers, on_error rewiring — each ~10–20 lines of code).
- Tasks 4–5 are the substantive ones (preflight rewrite + test harness).
- Splitting Task 1 (types) from Task 2 (helpers) is necessary because Task 4 depends on both being in place before its body can reference state_set_quarantine.
- The phase is intentionally a single-deploy unit (RESEARCH Open Q7: partial PIPE-02 without PIPE-01 leaves the same brittleness).

No fix required. Logged for awareness.

### Dimension 6: Verification Derivation — PASS

`must_haves.truths` across all plans are user-observable. Spot-checks:
- 13-01: "after a preflight FATAL exit, state.json:updateStatus reads 'idle'" — directly observable via `cat state.json | jq`.
- 13-02: "POST from non-localhost returns 403" — observable via curl.
- 13-03: "DELETE returns 200 with removedPath" — observable in response body.
- 13-04: "When info.lastQuarantine is non-null, banner renders a yellow info state" — observable in DOM via RTL.

No "library installed" or "schema migrated" truths. Every assertion is end-user or end-operator visible.

### Dimension 7: Context Compliance — PASS

All six locked decisions from CONTEXT.md §"Design decisions to lock during planning" are honored:

| Decision | Honored In |
|---|---|
| 1. Quarantine retention = 3 | 13-01 Task 4 step 10 declares `QUARANTINE_RETAIN=3` and mirrors snapshot retention pattern |
| 2. Stage-2 rollback does not preserve quarantine (ephemeral) | 13-01 Task 4 adds `--exclude='./.update-state/quarantine-*'` to the do_snapshot tar invocation |
| 3. Mixed M+?? stays FATAL | 13-01 Task 4 step 5 partitions into `untracked[]` + `fatal[]`; any non-`??` populates `fatal[]` → `die` |
| 4. Reuse python3 heredoc atomic-write pattern | 13-01 Task 2 explicitly mirrors `state_set_rolled_back` shape; 13-02 uses `UpdateStateStore.write` (TS-side equivalent) |
| 5. Admin page route = `/settings/update-state`, no nav | 13-04 Task 2 declares the file path; Task 2 done criteria + 13-04 success criteria explicitly state "No nav link added" |
| 6. PIPE-04 side-effects = state.json + audit row only | 13-02 Task 2 body has exactly those two writes — no log clearing, no quarantine cleanup |

No tasks contradict any locked decision. No tasks implement deferred ideas (no two-stage rollback modifications, no SSE diagnostics, no per-file content viewer, no auto-cleanup-after-N-days, no schema migration of existing state.json).

### Dimension 7b: Scope Reduction — PASS

No "v1/v2" versioning. No "static for now". No "placeholder". No "stub". No "not wired to". The plans are explicit about delivering the full PIPE-XX semantics — including the on-disk file move (not just logging), the audit row insert (not just state mutation), the relative-path file listing (not just basenames per RESEARCH Open Q8 lock), and the stacked banner (not a replacement of existing states per RESEARCH Open Q2 lock).

### Dimension 7c: Architectural Tier Compliance — PASS

RESEARCH.md §Architectural Responsibility Map assigns:
- Quarantine logic → Bash updater script (correct: 13-01 places it in run-update.sh preflight_git, not in a Node endpoint)
- on_error reset → Bash updater (correct: 13-01 Task 3 modifies the trap, not the Node side)
- Recovery endpoint → API/Backend (correct: 13-02 places it in `app/api/internal/...`)
- Admin DELETE → API/Backend with browser host guard (correct: 13-03)
- Admin page list → Frontend Server (RSC, correct: 13-04 Task 2 is a server component); delete button → Browser/Client (correct: 13-04 Task 3 has `'use client'`)
- Banner info → Browser/Client (correct: 13-04 Task 1 modifies the existing `'use client'` component)

Security-sensitive auth boundary (PIPE-04's localhost-only guard) is correctly placed in the API tier with the strict 4-host allowlist (NOT in the browser, NOT using the broader LAN allowlist). 13-02's `<interfaces>` explicitly forbids importing `isAllowedBrowserHost` (RESEARCH Pitfall 11 + PATTERNS Anti-pattern 4).

### Dimension 8: Nyquist Compliance — SKIPPED

Project config has `workflow.nyquist_validation: false` (per RESEARCH.md §Validation Architecture). Section omitted.

### Dimension 9: Cross-Plan Data Contracts — PASS

The single shared data pipeline is the `lastQuarantine` field on state.json/UpdateState/UpdateInfoView:
- 13-01 introduces it as `optional` (`lastQuarantine?:`) with `null` as the DEFAULT_UPDATE_STATE value.
- 13-02 preserves it (the reset endpoint's `store.write` patch only touches three other fields — the spread-merge in UpdateStateStore.write keeps lastQuarantine intact).
- 13-03 sets it to null (the DELETE endpoint's `store.write({ lastQuarantine: null })`).
- 13-04 reads it (`info.lastQuarantine` in the banner, `state.lastQuarantine` on the admin page).

All four plans agree on the field shape: `{ timestamp: number; fileCount: number; path: string } | null` with optional/null semantics for back-compat with pre-Phase-13 state.json files. No conflicting transforms.

The `update_runs.status` enum extension in 13-02 is widened in a way that 13-01 doesn't need to know about and the existing UpdateHistory component is updated in the same plan.

### Dimension 10: CLAUDE.md Compliance — PASS

Project CLAUDE.md mandates:
- **Naming**: kebab-case files for modules. New files (`reset-update-state/route.ts`, `update-state/page.tsx`, `quarantine-list.tsx`) all kebab-case. PASS.
- **Imports**: `@/*` path alias. All new imports use it. PASS.
- **Type imports**: `import type` for type-only. 13-04 Task 3 declares `import type { UpdateState }`. PASS.
- **Tests**: `*.test.ts(x)` next to module. 13-02/13-03/13-04 all colocate. PASS.
- **No mqtt.js**: Phase doesn't introduce MQTT — PASS by construction.
- **LAN-only deployment + Host-Header-Guard**: 13-02 and 13-03 use the correct guard variants (inline localhost-only vs. isAllowedBrowserHost) per CLAUDE.md `### Security & Endpoints` block. PASS.
- **Comments are for WARUM, not WAS**: Spot-checks of the inline JSDoc in 13-02 (PIPE-04 endpoint docstring) and 13-04 (banner refactor explanation) are causal/intent-documenting, not narrating syntax. PASS.

### Dimension 11: Research Resolution — PASS

RESEARCH.md §Open Questions for the Planner has 8 numbered items. All have explicit answers either in RESEARCH (locked decisions) or in the plan frontmatter / `<interfaces>` blocks:
1. Order of plans → answered in 13-01..04 wave assignment.
2. Banner priority placement → 13-04 Task 1 + must_haves.truths explicitly says "STACKED separate banner".
3. Quarantine retention constant → 13-01 Task 2 declares it bash-only (Node doesn't need it). Answered.
4. lastQuarantine.path = absolute → 13-01 must_haves.truths #4 says `path(absolute)`. 13-04 Task 2's loadFiles strips the absDir prefix to compute relative paths for display. Answered.
5. dry-run harness extension vs fork → 13-01 Task 5 extends. Answered.
6. Admin page nav placement → 13-04 Task 2 done: "No nav link added to any layout". Answered.
7. Re-trigger after PIPE-02 reset → addressed by shipping all four PIPE requirements in the same phase. Documented in 13-01 objective.
8. File listing depth (relative paths) → 13-04 Task 2 must_haves.truths #7: "preserves directory structure ... shows file paths relative to the quarantine dir root, not basenames". Answered.

No unresolved open questions remain.

### Dimension 12: Pattern Compliance — PASS

PATTERNS.md maps every new/modified file to an analog. Spot-checks:

| New File | PATTERNS Analog | Plan Reference |
|---|---|---|
| Preflight rewrite | `run-update.sh:269–278` existing preflight_git + snapshot retention at L283–307 | 13-01 Task 4 cites both |
| state_set_quarantine | `state_set_rolled_back` at L174–189 | 13-01 Task 2 cites it |
| reset-update-state/route.ts | `prepare-for-shutdown/route.ts` (entire 125-line file) | 13-02 Task 2 cites it for both ALLOWED_HOSTS shape AND isLocalhostHost function body |
| admin DELETE route | `ack-rollback/route.ts` minimal state-mutation + DELETE handler shape | 13-03 Task 1 cites it |
| settings/update-state/page.tsx | `app/settings/page.tsx` server-component pattern | 13-04 Task 2 cites it |
| quarantine-list.tsx | `update-banner.tsx:218` handleAckRollback flow + 5 existing DELETE+refresh sites | 13-04 Task 3 cites it |
| Banner refactor | Existing 8-state priority chain at update-banner.tsx:242–495 | 13-04 Task 1 walks it branch-by-branch |
| Test files | `route.test.ts` mock pattern + `charging-settings.test.tsx` RTL pattern | 13-02, 13-03, 13-04 all cite |

No plan creates a file without referencing the analog. The shared auth pattern (host-guard) is split correctly: PIPE-04 uses inline localhost-only, PIPE-03 backend uses `isAllowedBrowserHost`.

---

## Verified Source Cross-Checks

I read the referenced source files and verified each plan's claims:

| Claim | Source Verified | Result |
|---|---|---|
| 13-01 Task 1: types.ts UpdateState ends at L65 with `rollbackStage?` field | `src/modules/self-update/types.ts:39–65` | Confirmed (line 64 is `rollbackStage?: 'stage1' \| 'stage2' \| null;`, closing `};` at L65) |
| 13-01 Task 1: DEFAULT_UPDATE_STATE at L67–78 | Same file | Confirmed (line 67 starts `export const DEFAULT_UPDATE_STATE = ...`, ends L78) |
| 13-01 Task 1: UpdateInfoView at L116–155 | Same file | Confirmed (range matches) |
| 13-01 Task 1: update-info-view.ts `base` literal at L33–43 with `rollbackStage: state.rollbackStage ?? null` | `src/modules/self-update/update-info-view.ts:33–43` | Confirmed (line 41 is `rollbackStage: state.rollbackStage ?? null,`) |
| 13-01 Task 2: python3 heredoc atomic-write pattern at L137–189 | `scripts/update/run-update.sh:137–189` | Confirmed — three existing helpers (state_set_installing, state_set_success, state_set_rolled_back) all use `python3 - "${STATE_FILE}" <<'PYEOF' ... os.replace ... PYEOF` |
| 13-01 Task 3: on_error trap at L566–601 with `trap - ERR` at L576 | `scripts/update/run-update.sh:566–601` | Confirmed (line 576 is exactly `trap - ERR`) |
| 13-01 Task 4: preflight_git at L269–278 with `grep -vE` regex | `scripts/update/run-update.sh:269–278` | Confirmed (line 273 is the regex line) |
| 13-01 Task 4: do_snapshot tar excludes at L298–305 | Same file | Confirmed (L301 is `--exclude='./.update-state/snapshots'`, the natural insertion point for the new quarantine exclude) |
| 13-02 Task 1: schema.ts updateRuns enum at L245–247 | `src/db/schema.ts:245–247` | Confirmed (line 246 is `enum: ['running', 'success', 'failed', 'rolled_back'] as const,`) |
| 13-02 Task 1: update-history.tsx UpdateRun.status union at L13 | `src/app/settings/update-history.tsx:13` | Confirmed; switch starts at L35 (default case at L49 — slightly off from plan's stated L51 but the structure matches). MINOR offset, plan still correct in approach. |
| 13-02 Task 2: isLocalhostHost shape | `src/app/api/internal/prepare-for-shutdown/route.ts:40–49` | Confirmed verbatim — `raw.split(':')[0]` after IPv6 bracket strip |
| 13-02 Task 2: ALLOWED_HOSTS = `['127.0.0.1', 'localhost', '::1', '[::1]']` at L15 | Same file | Confirmed |
| 13-02 Task 2: NO_CACHE_HEADERS at L36–38 | Same file | Confirmed |
| 13-03 Task 1: isAllowedBrowserHost includes charging-master.local | `src/lib/host-guard.ts:14–20` | Confirmed (DEFAULT_ALLOWED_HOSTS lists it explicitly) |
| 13-04 Task 1: update-banner.tsx exists at `src/app/settings/update-banner.tsx` (not `src/components/update/`) | filesystem | Confirmed — the `src/components/update/` path does not exist. PATTERNS §"resolved to" note flagged this; 13-04 lists the correct path in `files_modified`. PASS. |
| 13-04 Task 1: update-banner.tsx has multiple `return (` branches | `grep -n "return (" src/app/settings/update-banner.tsx` | Confirmed — 9 return sites total. Lines 244, 280, 296, 310, 327, 395, 428, 459 match the branch counts the plan enumerates. Line 208 is the SSE-cleanup return-from-effect (correctly not counted as a render branch). |
| 13-04 Task 1: existing banner does NOT import `next/link` | grep returned no Link import in current banner | Confirmed — 13-04 Task 1 correctly adds the import. |

---

## Top 3 Findings

### 1. WARNING — 13-02 Task 1 references update-history.tsx line numbers slightly off (35–51 stated, actual `default` is at L49)

**Severity:** WARNING (cosmetic).

13-02 Task 1 says: "Lines 35–51 — add a new case to the `statusLabel` switch BEFORE the `default` branch." Actual file: switch starts at L35, default case is at L49, function closes at L51. The plan's line range covers the function body correctly but the "before default" instruction is what matters; line numbers are advisory. No correctness impact.

**Fix recommendation:** None required. The instruction is correct in intent; executor will land at the right spot via the "before default" anchor.

### 2. WARNING — 13-04 Task 2's reliance on `Dirent.path` field has a documented fallback but the test harness does not exercise the fallback

**Severity:** WARNING (minor robustness gap).

13-04 Task 2's `loadFiles()` reads `(e as unknown as { path: string }).path ?? absDir`. The Node 22 LTS shipped on the LXC supports `Dirent.path` via recursive readdir (`Node 20.12+`). The fallback to `absDir` would degrade nested files to basenames. The plan documents this but the RTL tests in Task 4 mock `next/navigation` and `fetch` — they do not exercise the server component's `loadFiles` function with a real `Dirent` shape (which is mostly fine because RTL tests don't run server components directly). The risk is small: only triggers if a future Node downgrade or an exotic test runner provides `Dirent` without `.path`.

**Fix recommendation:** None required before execution. Document in 13-04-SUMMARY.md whether the LXC's Node version was checked. The fallback is defensive.

### 3. CLARIFICATION — Plans correctly distinguish two host-guard variants; ensure executor does not unify them

**Severity:** PASS-with-emphasis (not a blocker, but the single biggest correctness risk in the phase).

13-02 (PIPE-04 — recovery endpoint) uses inline `isLocalhostHost` from prepare-for-shutdown verbatim. 13-03 (admin DELETE) uses `isAllowedBrowserHost` from `@/lib/host-guard`. These are intentionally different:
- `isLocalhostHost` allows ONLY `['127.0.0.1', 'localhost', '::1', '[::1]']` — strict loopback. Correct for "SSH into the LXC and curl from there".
- `isAllowedBrowserHost` adds `charging-master.local` + `UPDATE_ALLOWED_HOSTS` env override. Correct for "browser-reachable admin button".

Both plans call this out explicitly (13-02 `<interfaces>` paragraph 2, 13-03 `<interfaces>` paragraph 1, RESEARCH Pitfalls 11+12, PATTERNS Anti-pattern 4). The PASS finding is that the plans have already disambiguated this — so I'm calling it out here so the executor reads this section instead of taking the "easier" approach of unifying them.

**Fix recommendation:** None — the plans are correct. This finding exists to anchor executor attention.

---

## Recommendation

**PASS — execute as planned.**

The plan set is the highest-quality multi-plan submission I've reviewed for this codebase. Specifically:

1. Every RESEARCH pitfall (18 total) is addressed in an explicit plan task or `<interfaces>` clause.
2. Every CONTEXT locked decision (6 total) is honored.
3. Every PATTERNS analog (12 mapped files) is cited in the implementing plan.
4. The two host-guard variants are correctly distinguished and the wrong-allowlist failure mode (RESEARCH Pitfall 11) is explicitly forbidden.
5. The Drizzle TS enum vs. SQLite column distinction (PATTERNS §10 — "biggest gotcha") is correctly resolved as TS-only with no SQL migration.
6. Backwards-compat with pre-Phase-13 state.json files is maintained via optional fields and DEFAULT_UPDATE_STATE.
7. The on_error race condition (RESEARCH Pitfall 9 — must NOT touch `rollbackHappened`) is handled by isolating the new reset helper to three fields only.
8. The four PIPE requirements are correctly bundled into a single deploy (RESEARCH Open Q7) so the next operator-caused untracked-file event self-heals without manual intervention.

Proceed to `/gsd-execute-phase 13` with confidence. The two WARNINGs above are advisory; neither blocks execution.

**Expected test baseline progression:** 240 → 250 (after 13-02) → 259 (after 13-03) → 269 (after 13-04). Each plan's verify script asserts this.

**Post-execution validation should focus on:**
- Manual smoke on LXC 192.168.3.185: `touch /opt/charging-master/scripts/test-junk.ts && systemctl start --no-block charging-master-updater.service && journalctl -fu charging-master-updater` — expect `[stage=preflight_git] quarantined 1 file(s) to ...` and a successful update.
- Manual smoke from inside LXC: `curl -X POST http://localhost/api/internal/reset-update-state` after artificially poisoning state.json — expect 200 + new audit row.
- From outside LXC (e.g. from 192.168.3.127): same curl → expect 403.
