#!/usr/bin/env bash
# =============================================================================
# charging-master-updater — run-update.sh
# =============================================================================
# Pipeline: preflight → snapshot → drain → stop → fetch → reset → install
#           → clean_build → build → start → verify → finalize
#
# Triggered by: systemctl start --no-block charging-master-updater.service
# Runs as: root (same as charging-master.service)
# Logs to: journalctl -u charging-master-updater
#
# Failures from `fetch` onwards trigger a two-stage rollback:
#   Stage 1: git reset + pnpm install + rm -rf .next + pnpm build + restart
#   Stage 2: tarball extract + restart (only if Stage 1 itself fails)
#
# See .planning/phases/09-updater-pipeline-systemd-unit/09-CONTEXT.md for the
# decision log and .planning/research/PITFALLS.md (P1..P18) for the pitfalls
# this script mitigates.
# =============================================================================

set -euo pipefail

# -----------------------------------------------------------------------------
# Constants
# -----------------------------------------------------------------------------
readonly INSTALL_DIR="/opt/charging-master"
readonly STATE_DIR="${INSTALL_DIR}/.update-state"
readonly SNAPSHOT_DIR="${STATE_DIR}/snapshots"
readonly LOCK_FILE="${STATE_DIR}/updater.lock"
readonly STATE_FILE="${STATE_DIR}/state.json"
readonly DB="${INSTALL_DIR}/data/charging-master.db"
readonly SERVICE="charging-master"
readonly APP_URL="http://127.0.0.1:80"  # Hard-coded per 09-CONTEXT.md §Security
readonly SNAPSHOT_RETAIN=3

# -----------------------------------------------------------------------------
# Runtime state (populated as the script progresses)
# -----------------------------------------------------------------------------
CURRENT_STAGE="init"
CURRENT_SHA=""
ROLLBACK_SHA=""
NEW_SHA=""
RUN_ID=""

# -----------------------------------------------------------------------------
# Logging helpers
# -----------------------------------------------------------------------------
log() {
    # Structured log line for journalctl. Prefix with [stage=...] so Phase 10's
    # SSE log stream can parse the stage transitions.
    echo "[stage=${CURRENT_STAGE}] $*"
}

die() {
    echo "[stage=${CURRENT_STAGE}] FATAL: $*" >&2
    exit 1
}

# -----------------------------------------------------------------------------
# Flock concurrency guard (P15)
# -----------------------------------------------------------------------------
# Acquire an exclusive lock on FD 9. If another updater is running, exit 2
# immediately and write a 'skipped' row. Use non-blocking (-n) so we never hang.
mkdir -p "${STATE_DIR}"
exec 9>"${LOCK_FILE}"
if ! flock -n 9; then
    CURRENT_STAGE="lock"
    log "another updater run is holding the lock — exiting"
    # Best-effort skipped row — if the DB isn't available, don't crash
    if [ -f "${DB}" ] && command -v sqlite3 >/dev/null 2>&1; then
        sqlite3 "${DB}" "INSERT INTO update_runs (start_at, from_sha, status, stage, error_message) VALUES ($(date +%s)000, 'unknown', 'skipped', 'lock', 'another updater run already active');" 2>/dev/null || true
    fi
    exit 2
fi

# -----------------------------------------------------------------------------
# DB helpers (sqlite3 CLI — Phase 7's Drizzle schema for update_runs)
# -----------------------------------------------------------------------------
sql_escape() {
    # Escape single quotes by doubling them. Input may contain anything
    # including newlines from git commit messages — we still sanitize.
    local s="$1"
    echo "${s//\'/\'\'}"
}

db_start_run() {
    local from_sha="$1"
    sqlite3 "${DB}" "INSERT INTO update_runs (start_at, from_sha, status, stage) VALUES ($(date +%s)000, '$(sql_escape "${from_sha}")', 'running', 'preflight');"
    RUN_ID=$(sqlite3 "${DB}" "SELECT last_insert_rowid();")
    log "update_runs row id=${RUN_ID} created"
}

db_update_stage() {
    local stage="$1"
    [ -z "${RUN_ID}" ] && return 0
    sqlite3 "${DB}" "UPDATE update_runs SET stage = '$(sql_escape "${stage}")' WHERE id = ${RUN_ID};" || true
}

db_finish_run() {
    # Args: status to_sha error_message [rollback_stage]
    local status="$1"
    local to_sha="${2:-}"
    local error_message="${3:-}"
    local rollback_stage="${4:-}"
    [ -z "${RUN_ID}" ] && return 0

    local rollback_clause="NULL"
    if [ -n "${rollback_stage}" ]; then
        rollback_clause="'$(sql_escape "${rollback_stage}")'"
    fi

    local to_sha_clause="NULL"
    if [ -n "${to_sha}" ]; then
        to_sha_clause="'$(sql_escape "${to_sha}")'"
    fi

    # Truncate error_message to 500 chars — git commit messages and pnpm
    # stack traces can blow up this column otherwise.
    local truncated_err="${error_message:0:500}"

    sqlite3 "${DB}" "UPDATE update_runs SET end_at = $(date +%s)000, status = '$(sql_escape "${status}")', to_sha = ${to_sha_clause}, error_message = '$(sql_escape "${truncated_err}")', rollback_stage = ${rollback_clause} WHERE id = ${RUN_ID};" || true
    log "update_runs row id=${RUN_ID} finalized status=${status} rollback_stage=${rollback_stage:-null}"
}

# -----------------------------------------------------------------------------
# state.json mutations via python3 (atomic tmp + os.replace)
# -----------------------------------------------------------------------------
state_set_installing() {
    local rollback_sha="$1"
    python3 - "${STATE_FILE}" "${rollback_sha}" <<'PYEOF'
import json, os, sys
state_file, rollback_sha = sys.argv[1], sys.argv[2]
with open(state_file) as f:
    state = json.load(f)
state["rollbackSha"] = rollback_sha
state["updateStatus"] = "installing"
state["rollbackHappened"] = False
state["rollbackReason"] = None
tmp = state_file + ".tmp"
with open(tmp, "w") as f:
    json.dump(state, f, indent=2)
os.replace(tmp, state_file)
PYEOF
}

state_set_success() {
    local new_sha="$1"
    python3 - "${STATE_FILE}" "${new_sha}" <<'PYEOF'
import json, os, sys
state_file, new_sha = sys.argv[1], sys.argv[2]
with open(state_file) as f:
    state = json.load(f)
state["currentSha"] = new_sha
state["rollbackSha"] = None
state["updateStatus"] = "idle"
state["rollbackHappened"] = False
state["rollbackReason"] = None
tmp = state_file + ".tmp"
with open(tmp, "w") as f:
    json.dump(state, f, indent=2)
os.replace(tmp, state_file)
PYEOF
}

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

# -----------------------------------------------------------------------------
# Pushover (P4/NOTF support — pitfall mitigation: never let a failed pushover
# break the update, hence `|| true`)
# -----------------------------------------------------------------------------
pushover_send() {
    local title="$1"
    local message="$2"
    local priority="${3:-0}"

    local user_key api_token
    user_key=$(sqlite3 "${DB}" "SELECT value FROM config WHERE key='pushover.userKey';" 2>/dev/null || echo "")
    api_token=$(sqlite3 "${DB}" "SELECT value FROM config WHERE key='pushover.apiToken';" 2>/dev/null || echo "")

    if [ -z "${user_key}" ] || [ -z "${api_token}" ]; then
        log "pushover credentials not configured — skipping notification"
        return 0
    fi

    curl -sf -X POST https://api.pushover.net/1/messages.json \
        --max-time 10 \
        --data-urlencode "token=${api_token}" \
        --data-urlencode "user=${user_key}" \
        --data-urlencode "title=${title}" \
        --data-urlencode "message=${message}" \
        --data-urlencode "priority=${priority}" \
        >/dev/null 2>&1 || log "pushover send failed (non-fatal)"
}

# -----------------------------------------------------------------------------
# Pre-flight checks (P14 disk, P5 lockfile drift via node/pnpm version, P4 git state)
# -----------------------------------------------------------------------------
preflight_disk() {
    CURRENT_STAGE="preflight_disk"
    local avail
    avail=$(df -BM "${INSTALL_DIR}" | awk 'NR==2 {print $4}' | tr -d 'M')
    log "available disk: ${avail}MB"
    (( avail > 500 )) || die "Insufficient disk: ${avail}MB free, need 500"
}

preflight_node() {
    CURRENT_STAGE="preflight_node"
    local major
    major=$(node -v | sed 's/v//' | cut -d. -f1)
    log "node version: $(node -v)"
    (( major >= 22 )) || die "Node ${major} too old, need 22+"
}

preflight_pnpm() {
    CURRENT_STAGE="preflight_pnpm"
    local major
    major=$(pnpm -v | cut -d. -f1)
    log "pnpm version: $(pnpm -v)"
    (( major >= 10 )) || die "pnpm ${major} too old, need 10+"
}

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

# -----------------------------------------------------------------------------
# Snapshot stage (P16 partial rollback → full tarball)
# -----------------------------------------------------------------------------
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

    local snapshot_path="${SNAPSHOT_DIR}/${CURRENT_SHA}.tar.gz"
    log "creating snapshot ${snapshot_path}"
    tar -czf "${snapshot_path}" \
        --exclude='./node_modules' \
        --exclude='./.git' \
        --exclude='./.update-state/snapshots' \
        --exclude='./data/*.db-wal' \
        --exclude='./data/*.db-shm' \
        -C "${INSTALL_DIR}" \
        . || die "tarball creation failed"
    log "snapshot size: $(du -h "${snapshot_path}" | cut -f1)"
}

# -----------------------------------------------------------------------------
# Drain stage (P3 WAL + P18 silent success)
# -----------------------------------------------------------------------------
do_drain() {
    CURRENT_STAGE="drain"
    db_update_stage "${CURRENT_STAGE}"
    log "draining app (WAL checkpoint + HttpPollingService stop)"
    curl -sf -X POST --max-time 10 "${APP_URL}/api/internal/prepare-for-shutdown" \
        >/dev/null || die "drain endpoint failed"
    log "drain complete"
}

# -----------------------------------------------------------------------------
# Stop stage
# -----------------------------------------------------------------------------
do_stop() {
    CURRENT_STAGE="stop"
    db_update_stage "${CURRENT_STAGE}"
    log "stopping ${SERVICE}"
    systemctl stop "${SERVICE}" || die "systemctl stop ${SERVICE} failed"
    log "${SERVICE} stopped"
}

# -----------------------------------------------------------------------------
# Fetch / reset stages (P4 git state)
# -----------------------------------------------------------------------------
do_fetch() {
    CURRENT_STAGE="fetch"
    db_update_stage "${CURRENT_STAGE}"
    log "git fetch origin main"
    cd "${INSTALL_DIR}"
    git fetch origin main || die "git fetch failed"
}

do_reset() {
    CURRENT_STAGE="reset"
    db_update_stage "${CURRENT_STAGE}"
    cd "${INSTALL_DIR}"
    git reset --hard origin/main || die "git reset failed"
    NEW_SHA=$(git rev-parse HEAD)
    log "reset to new SHA ${NEW_SHA}"
}

# -----------------------------------------------------------------------------
# Install + build stages (P2 pnpm race, P6 mid-update build, P11 stale .next)
# -----------------------------------------------------------------------------
do_install() {
    CURRENT_STAGE="install"
    db_update_stage "${CURRENT_STAGE}"
    cd "${INSTALL_DIR}"
    log "pnpm install --frozen-lockfile"
    pnpm install --frozen-lockfile || die "pnpm install failed"
}

do_clean_build() {
    CURRENT_STAGE="clean_build"
    db_update_stage "${CURRENT_STAGE}"
    cd "${INSTALL_DIR}"
    log "rm -rf .next"
    rm -rf .next
}

do_build() {
    CURRENT_STAGE="build"
    db_update_stage "${CURRENT_STAGE}"
    cd "${INSTALL_DIR}"
    log "pnpm build"
    pnpm build || die "pnpm build failed"
}

do_start() {
    CURRENT_STAGE="start"
    db_update_stage "${CURRENT_STAGE}"
    log "starting ${SERVICE}"
    systemctl start "${SERVICE}" || die "systemctl start ${SERVICE} failed"
}

# -----------------------------------------------------------------------------
# Health probe (P18 silent success — require sha match + dbHealthy=true)
# -----------------------------------------------------------------------------
health_probe() {
    local target_sha="$1"
    local deadline=$(( $(date +%s) + 60 ))
    log "health probing ${APP_URL}/api/version expecting sha=${target_sha:0:7}"
    while (( $(date +%s) < deadline )); do
        local body
        body=$(curl -sf --max-time 2 "${APP_URL}/api/version" 2>/dev/null) || { sleep 2; continue; }
        local sha
        sha=$(echo "${body}" | grep -o '"sha":"[a-f0-9]*"' | cut -d'"' -f4)
        local dbok
        dbok=$(echo "${body}" | grep -o '"dbHealthy":[a-z]*' | cut -d: -f2)
        if [[ "${sha}" == "${target_sha}" && "${dbok}" == "true" ]]; then
            log "health probe OK: sha matches and dbHealthy=true"
            return 0
        fi
        sleep 2
    done
    log "health probe TIMEOUT after 60s (last body: ${body:-<empty>})"
    return 1
}

do_verify() {
    CURRENT_STAGE="verify"
    db_update_stage "${CURRENT_STAGE}"
    health_probe "${NEW_SHA}" || die "health probe failed"
}

# -----------------------------------------------------------------------------
# Rollback (P7 two-stage)
# -----------------------------------------------------------------------------
do_rollback_stage1() {
    local original_error="$1"
    log "=== Stage 1 rollback: git reset to ${ROLLBACK_SHA:0:7} ==="
    cd "${INSTALL_DIR}"

    # Best-effort: stop the (possibly broken) main service before touching git.
    systemctl stop "${SERVICE}" 2>/dev/null || true

    git reset --hard "${ROLLBACK_SHA}" || { log "Stage 1 git reset FAILED"; return 1; }
    pnpm install --frozen-lockfile || { log "Stage 1 pnpm install FAILED"; return 1; }
    rm -rf .next
    pnpm build || { log "Stage 1 pnpm build FAILED"; return 1; }
    systemctl start "${SERVICE}" || { log "Stage 1 systemctl start FAILED"; return 1; }
    health_probe "${ROLLBACK_SHA}" || { log "Stage 1 health probe FAILED"; return 1; }

    log "Stage 1 rollback SUCCESS"
    state_set_rolled_back "${original_error}"
    db_finish_run "rolled_back" "${ROLLBACK_SHA}" "${original_error}" "stage1"
    pushover_send "Charging-Master: Update fehlgeschlagen" "Stage 1 Rollback erfolgreich. Fehler: ${original_error}" "1"
    return 0
}

do_rollback_stage2() {
    local original_error="$1"
    log "=== Stage 2 rollback: tarball restore from ${ROLLBACK_SHA:0:7} ==="
    local snapshot="${SNAPSHOT_DIR}/${ROLLBACK_SHA}.tar.gz"

    if [ ! -f "${snapshot}" ]; then
        log "Stage 2 FAILED: snapshot ${snapshot} not found"
        state_set_rolled_back "Stage 2 failed: snapshot missing. Original: ${original_error}"
        db_finish_run "failed" "" "Stage 2 failed: snapshot missing. Original: ${original_error}" "stage2_failed"
        pushover_send "Charging-Master: CRITICAL" "Stage 2 rollback FAILED (snapshot missing). SSH intervention required. Original error: ${original_error}" "2"
        return 1
    fi

    systemctl stop "${SERVICE}" 2>/dev/null || true

    if ! tar -xzf "${snapshot}" -C "${INSTALL_DIR}"; then
        log "Stage 2 tar extract FAILED"
        state_set_rolled_back "Stage 2 failed: tar extract. Original: ${original_error}"
        db_finish_run "failed" "" "Stage 2 failed: tar extract. Original: ${original_error}" "stage2_failed"
        pushover_send "Charging-Master: CRITICAL" "Stage 2 rollback FAILED (tar extract). SSH intervention required. Original error: ${original_error}" "2"
        return 1
    fi

    if ! systemctl start "${SERVICE}"; then
        log "Stage 2 systemctl start FAILED"
        state_set_rolled_back "Stage 2 failed: start. Original: ${original_error}"
        db_finish_run "failed" "" "Stage 2 failed: start. Original: ${original_error}" "stage2_failed"
        pushover_send "Charging-Master: CRITICAL" "Stage 2 rollback FAILED (service start). SSH intervention required. Original error: ${original_error}" "2"
        return 1
    fi

    if ! health_probe "${ROLLBACK_SHA}"; then
        log "Stage 2 health probe FAILED"
        state_set_rolled_back "Stage 2 failed: health probe. Original: ${original_error}"
        db_finish_run "failed" "" "Stage 2 failed: health probe. Original: ${original_error}" "stage2_failed"
        pushover_send "Charging-Master: CRITICAL" "Stage 2 rollback FAILED (health probe). SSH intervention required. Original error: ${original_error}" "2"
        return 1
    fi

    log "Stage 2 rollback SUCCESS"
    state_set_rolled_back "${original_error}"
    db_finish_run "rolled_back" "${ROLLBACK_SHA}" "${original_error}" "stage2"
    pushover_send "Charging-Master: Update fehlgeschlagen" "Stage 2 (tarball) Rollback erfolgreich. Fehler: ${original_error}" "1"
    return 0
}

# -----------------------------------------------------------------------------
# Error trap (triggered by set -e on any non-zero exit)
# -----------------------------------------------------------------------------
on_error() {
    local exit_code="$1"
    local lineno="$2"
    local failed_stage="${CURRENT_STAGE}"
    local error_message="stage=${failed_stage} line=${lineno} exit=${exit_code}"

    log "on_error triggered: ${error_message}"

    # Disable the trap inside the trap so rollback failures don't recursively
    # fire it and loop forever.
    trap - ERR

    # Stages where no rollback is needed — the old code is still running.
    case "${failed_stage}" in
        init|lock|preflight_disk|preflight_node|preflight_pnpm|preflight_git|snapshot|drain|stop)
            log "failure in pre-change stage — no rollback needed"
            state_set_rolled_back "${error_message}"
            db_finish_run "failed" "" "${error_message}" ""
            pushover_send "Charging-Master: Update fehlgeschlagen" "Pre-change failure: ${error_message}" "1"
            exit 1
            ;;
    esac

    # Stages where rollback is required (fetch onwards). Try Stage 1 first.
    if do_rollback_stage1 "${error_message}"; then
        exit 1
    fi

    log "Stage 1 failed — escalating to Stage 2"
    if do_rollback_stage2 "${error_message}"; then
        exit 1
    fi

    log "Stage 2 failed — exiting 3 (CRITICAL)"
    exit 3
}

on_exit() {
    local exit_code=$?
    log "on_exit: exit_code=${exit_code}"
}

trap 'on_error $? $LINENO' ERR
trap on_exit EXIT

# -----------------------------------------------------------------------------
# Main pipeline
# -----------------------------------------------------------------------------
main() {
    CURRENT_STAGE="init"
    cd "${INSTALL_DIR}"

    CURRENT_SHA=$(git rev-parse HEAD)
    ROLLBACK_SHA="${CURRENT_SHA}"
    log "starting update run from ${CURRENT_SHA}"

    db_start_run "${CURRENT_SHA}"

    # --- Pre-flight ---
    preflight_disk
    preflight_node
    preflight_pnpm
    preflight_git

    # --- Snapshot (before touching anything) ---
    do_snapshot

    # --- Drain + stop ---
    do_drain
    do_stop

    # --- Persist rollbackSha to state.json BEFORE any destructive git op ---
    CURRENT_STAGE="persist_rollback_sha"
    db_update_stage "${CURRENT_STAGE}"
    state_set_installing "${ROLLBACK_SHA}"

    # --- Fetch + reset ---
    do_fetch
    do_reset

    # --- Install + clean + build ---
    do_install
    do_clean_build
    do_build

    # --- Start + verify ---
    do_start
    do_verify

    # --- Finalize ---
    CURRENT_STAGE="finalize"
    db_update_stage "${CURRENT_STAGE}"
    state_set_success "${NEW_SHA}"
    db_finish_run "success" "${NEW_SHA}" "" ""
    log "update SUCCESS: ${CURRENT_SHA:0:7} → ${NEW_SHA:0:7}"
    pushover_send "Charging-Master: Update erfolgreich" "Von ${CURRENT_SHA:0:7} auf ${NEW_SHA:0:7}" "0"
}

main "$@"
