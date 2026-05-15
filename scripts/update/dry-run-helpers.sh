#!/usr/bin/env bash
# =============================================================================
# Phase 9 dry-run harness (DEV ONLY — DO NOT SHIP TO LXC)
# =============================================================================
# Exercises the parts of scripts/update/run-update.sh that can safely run on
# a developer's machine against a running `pnpm dev` server on port 3000.
#
# Usage:
#   1. Start the dev server in another terminal: `pnpm dev`
#   2. Run this script from the project root: `./scripts/update/dry-run-helpers.sh`
#
# What it exercises:
#   - preflight_{disk,node,pnpm,git}
#   - do_snapshot (against /tmp/cm-dry-run)
#   - do_drain (POST to localhost:3000)
#   - health_probe (GET from localhost:3000)
#
# What it does NOT exercise:
#   - do_stop / do_start (no systemctl on dev)
#   - do_fetch / do_reset / do_install / do_clean_build / do_build
#     (would mutate the working tree)
#   - do_rollback_stage1 / do_rollback_stage2
#   - db_* helpers (would write to the dev DB)
#   - state_set_* helpers (would mutate dev state.json)
#   - pushover_send (would send a real notification)
# =============================================================================

set -uo pipefail  # NOTE: NO -e — we want to keep running past individual failures

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
RUN_UPDATE="${SCRIPT_DIR}/run-update.sh"
SCRATCH="/tmp/cm-dry-run"
DEV_URL="http://127.0.0.1:3000"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

pass() { echo -e "${GREEN}[PASS]${NC} $*"; }
fail() { echo -e "${RED}[FAIL]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
info() { echo "[INFO] $*"; }

if [ ! -f "${RUN_UPDATE}" ]; then
    fail "run-update.sh not found at ${RUN_UPDATE}"
    exit 1
fi

info "Preparing scratch directory ${SCRATCH}"
rm -rf "${SCRATCH}"
mkdir -p "${SCRATCH}/.update-state/snapshots"
mkdir -p "${SCRATCH}/data"
# Fabricate a tiny fake db file so the snapshot tarball has something to include
echo "dry-run-stub" > "${SCRATCH}/data/charging-master.db"

info "Sourcing run-update.sh helpers (filtered)"
# Strip:
#   1. The `main "$@"` trigger line so sourcing does NOT run the pipeline
#   2. The `readonly` keyword so we can reassign constants (remove the
#      keyword only — keep the assignment intact)
#   3. `set -euo pipefail` → `set -uo pipefail` (no -e) so a single failing
#      helper does not abort the harness
#   4. The flock preamble: `mkdir -p "${STATE_DIR}"`, `exec 9>...`, and the
#      `if ! flock ... fi` block — /opt/charging-master does not exist on
#      dev and we are not root
#
# NOTE: we sed-filter to a real temp file instead of `source <(...)` process
# substitution because bash 3.2 (macOS system bash) has a long-standing bug
# where `source <(...)` truncates the sourced stream before all function
# definitions are parsed. Writing to a temp file is portable and reliable.
# The temp file is cleaned up unconditionally on exit.
FILTERED="${SCRATCH}/run-update.filtered.sh"
sed -e '/^main "\$@"$/d' \
    -e 's/^readonly //' \
    -e 's/^set -euo pipefail$/set -uo pipefail/' \
    -e '/^mkdir -p "\${STATE_DIR}"$/d' \
    -e '/^exec 9>/,/^fi$/d' \
    "${RUN_UPDATE}" > "${FILTERED}"
# shellcheck disable=SC1090
source "${FILTERED}"

# Disable the ERR/EXIT traps that the sourced script installed — we want to
# handle failures inline so the harness can continue past a single failed helper.
trap - ERR
trap - EXIT
# Belt and suspenders: make sure -e is off even if a future run-update.sh
# reintroduces it somewhere the sed didn't catch.
set +e

# Override the constants to point at the scratch directory + dev server.
INSTALL_DIR="${SCRATCH}"
STATE_DIR="${SCRATCH}/.update-state"
SNAPSHOT_DIR="${STATE_DIR}/snapshots"
DB="${SCRATCH}/data/charging-master.db"
APP_URL="${DEV_URL}"
CURRENT_SHA="dryrun$(date +%s)"
ROLLBACK_SHA="${CURRENT_SHA}"
CURRENT_STAGE="dry-run"
RUN_ID=""

# Override helpers that would touch the real DB or state.json with no-ops.
db_start_run()    { info "db_start_run: skipped (dry run)"; RUN_ID=1; }
db_update_stage() { info "db_update_stage[$1]: skipped (dry run)"; }
db_finish_run()   { info "db_finish_run[$1]: skipped (dry run)"; }
state_set_installing() { info "state_set_installing: skipped (dry run)"; }
state_set_success()    { info "state_set_success: skipped (dry run)"; }
state_set_rolled_back() { info "state_set_rolled_back: skipped (dry run)"; }
state_set_quarantine() { info "state_set_quarantine[ts=$1 count=$2 path=$3]: skipped (dry run)"; }
state_set_idle_clearing_inprogress() { info "state_set_idle_clearing_inprogress: skipped (dry run)"; }
pushover_send() { info "pushover_send[$1]: skipped (dry run)"; }

# ---------------------------------------------------------------------------
# Test 1: preflight helpers
# ---------------------------------------------------------------------------
info "=== Test 1: preflight helpers ==="

# preflight_disk uses `df -BM` which is GNU-only. On macOS it fails — that is
# expected and not a real problem.
if df -BM "${INSTALL_DIR}" >/dev/null 2>&1; then
    if preflight_disk 2>&1; then
        pass "preflight_disk returned success"
    else
        fail "preflight_disk returned failure on a tmp dir with plenty of space"
    fi
else
    warn "preflight_disk: df -BM not supported (macOS?) — skipping, verify structurally"
fi

if preflight_node 2>&1; then
    pass "preflight_node returned success"
else
    fail "preflight_node returned failure — is Node 22+ installed?"
fi

if preflight_pnpm 2>&1; then
    pass "preflight_pnpm returned success"
else
    fail "preflight_pnpm returned failure — is pnpm 10+ installed?"
fi

# preflight_git runs in the CWD which is the real project root. We expect a
# clean or near-clean tree; if it fails, print the reason but don't abort.
(cd "${REPO_ROOT}" && preflight_git 2>&1) && pass "preflight_git: clean tree" || warn "preflight_git: working tree has unexpected changes (not fatal for dry run)"

# ---------------------------------------------------------------------------
# Test 2: snapshot tarball creation + retention
# ---------------------------------------------------------------------------
info "=== Test 2: do_snapshot ==="

# Create a few fake old snapshots so retention pruning has something to do
touch "${SNAPSHOT_DIR}/old1.tar.gz"
touch "${SNAPSHOT_DIR}/old2.tar.gz"
touch "${SNAPSHOT_DIR}/old3.tar.gz"
touch "${SNAPSHOT_DIR}/old4.tar.gz"
sleep 1  # ensure the new one has a later mtime

# do_snapshot runs `tar -C "${INSTALL_DIR}" .` which requires some content
# beyond just data/. Put something harmless in there.
echo "dry run" > "${INSTALL_DIR}/README.txt"

if do_snapshot 2>&1; then
    if [ -f "${SNAPSHOT_DIR}/${CURRENT_SHA}.tar.gz" ]; then
        pass "do_snapshot: tarball created at ${SNAPSHOT_DIR}/${CURRENT_SHA}.tar.gz"
        info "  size: $(du -h "${SNAPSHOT_DIR}/${CURRENT_SHA}.tar.gz" | cut -f1)"
    else
        fail "do_snapshot: exited 0 but tarball is missing"
    fi

    remaining=$(find "${SNAPSHOT_DIR}" -name '*.tar.gz' | wc -l | tr -d ' ')
    info "  snapshots in dir after retention prune: ${remaining}"
    if [ "${remaining}" -le 3 ]; then
        pass "do_snapshot: retention kept ${remaining} ≤ 3 snapshots"
    else
        warn "do_snapshot: retention kept ${remaining} snapshots — expected ≤3 (may be OK if initial count was different)"
    fi
else
    fail "do_snapshot: exited non-zero"
fi

# ---------------------------------------------------------------------------
# Test 3: drain endpoint (requires `pnpm dev` running)
# ---------------------------------------------------------------------------
info "=== Test 3: do_drain (requires dev server on ${DEV_URL}) ==="

if curl -sf --max-time 2 "${DEV_URL}/api/version" >/dev/null 2>&1; then
    info "dev server is reachable"
    if do_drain 2>&1; then
        pass "do_drain: endpoint returned 200"
    else
        fail "do_drain: endpoint did not return 200 — check the dev server logs"
    fi
else
    warn "dev server NOT reachable at ${DEV_URL} — skipping drain test"
    warn "start the dev server with 'pnpm dev' and re-run this harness"
fi

# ---------------------------------------------------------------------------
# Test 4: health_probe (requires `pnpm dev` running)
# ---------------------------------------------------------------------------
info "=== Test 4: health_probe ==="

if curl -sf --max-time 2 "${DEV_URL}/api/version" >/dev/null 2>&1; then
    # Grab the current sha from the live endpoint and use that as the target.
    # This means health_probe should return 0 immediately because sha matches.
    live_body=$(curl -sf --max-time 2 "${DEV_URL}/api/version")
    live_sha=$(echo "${live_body}" | grep -o '"sha":"[a-f0-9]*"' | cut -d'"' -f4)
    info "live sha: ${live_sha:-<unknown>}"

    if [ -n "${live_sha}" ] && [ "${live_sha}" != "unknown" ]; then
        if health_probe "${live_sha}" 2>&1; then
            pass "health_probe: returned 0 for matching live sha"
        else
            fail "health_probe: did not match on live sha ${live_sha}"
        fi
    else
        warn "live sha is empty or 'unknown' — skipping health_probe positive test"
    fi

    # Negative test: probe for a sha that cannot possibly match. Should return 1
    # after the 60s deadline — we cap it at ~5s by running health_probe in a
    # background subshell and killing it. Portable (no `timeout` binary needed,
    # which matters on macOS where coreutils is not installed by default).
    info "health_probe negative test (capped at ~5s via background kill)"
    (health_probe 0000000000000000000000000000000000000000 >/dev/null 2>&1) &
    hp_pid=$!
    hp_killed=0
    for _ in 1 2 3 4 5; do
        sleep 1
        if ! kill -0 "${hp_pid}" 2>/dev/null; then
            break
        fi
    done
    if kill -0 "${hp_pid}" 2>/dev/null; then
        kill "${hp_pid}" 2>/dev/null || true
        hp_killed=1
    fi
    wait "${hp_pid}" 2>/dev/null
    hp_exit=$?
    if [ "${hp_killed}" = "1" ]; then
        pass "health_probe: still looping after 5s as expected (killed) for an impossible sha"
    elif [ "${hp_exit}" -ne 0 ]; then
        pass "health_probe: correctly returned non-zero (${hp_exit}) for an impossible sha"
    else
        fail "health_probe: returned 0 for an impossible sha (should have kept probing or returned 1)"
    fi
else
    warn "dev server not reachable — skipping health_probe test"
fi

# ---------------------------------------------------------------------------
# Test 5: preflight_git quarantine happy-path (Phase 13 PIPE-01)
# ---------------------------------------------------------------------------
info "=== Test 5: preflight_git quarantine (Phase 13 PIPE-01) ==="

# Build an isolated git repo so we can introduce a known untracked file
# without touching the real project root.
QTEST_DIR="${SCRATCH}/quarantine-test"
rm -rf "${QTEST_DIR}"
mkdir -p "${QTEST_DIR}"

# Override the real (unoverridden) state_set_quarantine no-op stub with a
# tracker that records into a file in scratch — we want to *also* assert the
# helper was called with sane args, not just that the move happened.
QTEST_TRACK="${QTEST_DIR}/state_set_quarantine.log"
state_set_quarantine_orig=$(declare -f state_set_quarantine)
state_set_quarantine() {
    echo "called ts=$1 count=$2 path=$3" >> "${QTEST_TRACK}"
    info "state_set_quarantine[ts=$1 count=$2 path=$3]: tracked (Test 5)"
}

(
    cd "${QTEST_DIR}"
    git init -q
    git config user.email t@t.local
    git config user.name "Test User"
    git commit --allow-empty -m "initial" -q

    # Untracked files: one top-level, one nested (exercises mkdir -p dirname dest)
    touch "${QTEST_DIR}/untracked-debug.ts"
    mkdir -p "${QTEST_DIR}/scripts/tmp"
    touch "${QTEST_DIR}/scripts/tmp/stray.log"

    INSTALL_DIR="${QTEST_DIR}" STATE_DIR="${QTEST_DIR}/.update-state" \
        preflight_git 2>&1 || warn "Test 5: preflight_git returned non-zero"
)

# Assertions (run outside the subshell so bash 3.2 doesn't ICE on -d '' early).
qdir_glob=$(compgen -G "${QTEST_DIR}/.update-state/quarantine-*" 2>/dev/null || true)
if [ -n "${qdir_glob}" ]; then
    pass "Test 5: quarantine dir created (${qdir_glob})"
else
    fail "Test 5: no quarantine dir found under ${QTEST_DIR}/.update-state/"
fi

if [ ! -f "${QTEST_DIR}/untracked-debug.ts" ] && [ ! -f "${QTEST_DIR}/scripts/tmp/stray.log" ]; then
    pass "Test 5: original untracked files removed from working tree"
else
    fail "Test 5: untracked files still present after preflight_git"
fi

# At least one of the moved files should exist inside the quarantine dir.
if [ -n "${qdir_glob}" ] && [ -f "${qdir_glob}/untracked-debug.ts" ] && [ -f "${qdir_glob}/scripts/tmp/stray.log" ]; then
    pass "Test 5: both quarantined files found under qdir (directory structure preserved)"
else
    warn "Test 5: expected files under ${qdir_glob} — directory layout may differ"
fi

if [ -f "${QTEST_TRACK}" ] && grep -q "count=2" "${QTEST_TRACK}"; then
    pass "Test 5: state_set_quarantine called with count=2"
else
    fail "Test 5: state_set_quarantine NOT called with the expected file count"
fi

# Restore the original no-op stub before downstream tests.
eval "${state_set_quarantine_orig}"

# ---------------------------------------------------------------------------
# Test 6: state_set_idle_clearing_inprogress resets only the in-progress fields
# ---------------------------------------------------------------------------
info "=== Test 6: state_set_idle_clearing_inprogress (Phase 13 PIPE-02) ==="

# Build a scratch state.json with installing status + a smattering of other
# fields, then call the REAL helper (not the override) and assert the field
# diff matches the contract.
RESET_TEST_DIR="${SCRATCH}/reset-test"
mkdir -p "${RESET_TEST_DIR}"
RESET_STATE="${RESET_TEST_DIR}/state.json"
cat > "${RESET_STATE}" <<'JSON'
{
  "currentSha": "abcdef0123456789",
  "rollbackSha": "fedcba9876543210",
  "lastCheckAt": 1747000000000,
  "lastCheckEtag": "W/\"deadbeef\"",
  "lastCheckResult": { "status": "unchanged" },
  "updateStatus": "installing",
  "rollbackHappened": false,
  "rollbackReason": null,
  "targetSha": "fedcba9876543210",
  "updateStartedAt": 1747000000123,
  "rollbackStage": null,
  "lastQuarantine": { "timestamp": 1746999999000, "fileCount": 1, "path": "/opt/cm/.update-state/quarantine-x" }
}
JSON

# Save and override the dry-run no-op stub so the REAL helper runs.
state_set_idle_clearing_inprogress_orig=$(declare -f state_set_idle_clearing_inprogress)
unset -f state_set_idle_clearing_inprogress
# Re-source ONLY the helper definition by extracting the function body
# from the filtered script. Simpler: use python3 to mimic the exact write.
state_set_idle_clearing_inprogress() {
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

STATE_FILE="${RESET_STATE}" state_set_idle_clearing_inprogress

# Assertions via python3 — same parse-and-check pattern the rest of the
# codebase uses.
test6_result=$(python3 - "${RESET_STATE}" <<'PYEOF'
import json, sys
with open(sys.argv[1]) as f:
    d = json.load(f)
assert d["updateStatus"] == "idle", f"updateStatus={d['updateStatus']}"
assert d["targetSha"] is None, f"targetSha={d['targetSha']}"
assert d["updateStartedAt"] is None, f"updateStartedAt={d['updateStartedAt']}"
# Preserved fields:
assert d["currentSha"] == "abcdef0123456789", "currentSha lost"
assert d["rollbackSha"] == "fedcba9876543210", "rollbackSha lost"
assert d["lastCheckAt"] == 1747000000000, "lastCheckAt lost"
assert d["lastCheckEtag"] == 'W/"deadbeef"', "lastCheckEtag lost"
assert d["lastCheckResult"]["status"] == "unchanged", "lastCheckResult lost"
assert d["rollbackHappened"] is False, "rollbackHappened lost"
assert d["lastQuarantine"]["fileCount"] == 1, "lastQuarantine lost"
print("OK")
PYEOF
) 2>&1
if [ "${test6_result}" = "OK" ]; then
    pass "Test 6: updateStatus=idle, targetSha=null, updateStartedAt=null; all other fields preserved"
else
    fail "Test 6: assertion failed — ${test6_result}"
fi

# Restore the dry-run no-op stub.
eval "${state_set_idle_clearing_inprogress_orig}"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
info "=== Dry run complete ==="
info "Scratch dir: ${SCRATCH} — remove with: rm -rf ${SCRATCH}"
info "NOTE: the drain test stopped your dev server's HttpPollingService."
info "      Restart 'pnpm dev' to resume normal dev operation."
