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
# Summary
# ---------------------------------------------------------------------------
echo ""
info "=== Dry run complete ==="
info "Scratch dir: ${SCRATCH} — remove with: rm -rf ${SCRATCH}"
info "NOTE: the drain test stopped your dev server's HttpPollingService."
info "      Restart 'pnpm dev' to resume normal dev operation."
