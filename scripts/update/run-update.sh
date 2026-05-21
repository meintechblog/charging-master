#!/usr/bin/env bash
# =============================================================================
# charging-master-updater — run-update.sh
# =============================================================================
# Pipeline: preflight → snapshot → drain → stop → fetch → reset → install
#           → backup_db → migrate → clean_build → build → start → verify
#           → finalize
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
readonly QUARANTINE_RETAIN=3
readonly DB_BACKUP_RETAIN=3
readonly DB_BACKUP_DIR="${INSTALL_DIR}/data"
readonly DB_BACKUP_PREFIX="charging-master.db.pre-migrate-"

# -----------------------------------------------------------------------------
# Runtime state (populated as the script progresses)
# -----------------------------------------------------------------------------
CURRENT_STAGE="init"
CURRENT_SHA=""
ROLLBACK_SHA=""
NEW_SHA=""
RUN_ID=""
PRE_MIGRATE_BACKUP=""   # set by do_backup_db; consumed by rollback if non-empty
MIGRATE_RAN=0           # 1 once do_migrate has started — even partial runs need DB restore on rollback

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
    # Combine INSERT + SELECT in ONE sqlite3 invocation. last_insert_rowid()
    # is connection-scoped — running it in a separate sqlite3 call would
    # always return 0, leaving every subsequent UPDATE targeting id=0
    # (i.e. updating zero rows, leaving the run row stuck at 'running').
    RUN_ID=$(sqlite3 "${DB}" "INSERT INTO update_runs (start_at, from_sha, status, stage) VALUES ($(date +%s)000, '$(sql_escape "${from_sha}")', 'running', 'preflight'); SELECT last_insert_rowid();")
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

# Phase 13 (PIPE-01): persist the lastQuarantine event to state.json so the UI
# can render the yellow banner. Args: $1 = epoch ms, $2 = file count, $3 =
# absolute quarantine dir path. Read → merge → atomic write; preserves every
# other field including rollbackHappened / lastCheckResult / currentSha.
state_set_quarantine() {
    local timestamp="$1"
    local file_count="$2"
    local quarantine_path="$3"
    python3 - "${STATE_FILE}" "${timestamp}" "${file_count}" "${quarantine_path}" <<'PYEOF'
import json, os, sys
state_file, ts, count, path = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
with open(state_file) as f:
    state = json.load(f)
state["lastQuarantine"] = {
    "timestamp": int(ts),
    "fileCount": int(count),
    "path": path,
}
tmp = state_file + ".tmp"
with open(tmp, "w") as f:
    json.dump(state, f, indent=2)
os.replace(tmp, state_file)
PYEOF
}

# Phase 13 (PIPE-02): on_error trap calls this BEFORE any other state write so
# the next /api/update/trigger never sees a stranded 'installing' status. Only
# touches updateStatus / targetSha / updateStartedAt — preserves currentSha,
# rollbackSha, lastCheckResult, lastCheckEtag, lastCheckAt, rollbackHappened,
# rollbackReason, rollbackStage, lastQuarantine. If state_set_rolled_back fires
# afterwards (pre-change case-arm), its 'rolled_back' status overrides this
# helper's 'idle' write — that is intentional so the red banner still appears
# when the rollback bookkeeping succeeds. If state_set_rolled_back silently
# fails (the 2026-05-15 incident class), this helper's 'idle' write survives.
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

# -----------------------------------------------------------------------------
# Pushover (P4/NOTF support — pitfall mitigation: never let a failed pushover
# break the update, hence `|| true`)
# -----------------------------------------------------------------------------

# Resolve the instance label used to prefix push titles. Mirrors
# NotificationService.getInstanceLabel() in the app — same precedence so push
# from app and updater carry the same identifier on a given box.
get_instance_label() {
    local label
    label=$(sqlite3 "${DB}" "SELECT value FROM config WHERE key='instance.label';" 2>/dev/null || echo "")
    if [ -n "${label}" ]; then
        echo "${label}"
        return 0
    fi
    label=$(hostname -I 2>/dev/null | awk '{print $1}')
    if [ -n "${label}" ]; then
        echo "${label}"
        return 0
    fi
    hostname
}

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

    local label
    label=$(get_instance_label)
    local prefixed_title="[${label}] ${title}"

    curl -sf -X POST https://api.pushover.net/1/messages.json \
        --max-time 10 \
        --data-urlencode "token=${api_token}" \
        --data-urlencode "user=${user_key}" \
        --data-urlencode "title=${prefixed_title}" \
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
    # Phase 13 (PIPE-01): instead of dying on ANY untracked/modified file
    # (the 2026-05-15 incident: a single 0-byte stray .ts file from a prior
    # botched update killed every subsequent preflight), partition the
    # working tree into:
    #   - untracked-only ('??') → MOVE to .update-state/quarantine-<ts>/
    #     preserving directory structure, then continue.
    #   - anything else (M/A/D/R/C/unmerged) → die fatally. We never silently
    #     reset tracked-file edits — they are intentional and must be reviewed.
    # The bash updater's own write paths (.update-state/*, .next/*) are
    # excluded from the quarantine candidate set; they belong to the script.
    CURRENT_STAGE="preflight_git"

    local untracked=()
    local fatal=()
    local entry code path

    # `git status -z --porcelain`:
    # - -z uses NUL terminators between entries (handles spaces, quotes, newlines safely)
    # - in -z mode, NO C-string quoting — bytes between NULs are the raw filename
    # - rename codes (R*/C*) emit TWO NUL tokens (new + old). We die fatally
    #   on the first one, so we never consume the second.
    while IFS= read -r -d '' entry; do
        code="${entry:0:2}"
        path="${entry:3}"
        case "${code}" in
            '??')
                # Skip the updater's own write directories.
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

    # Build a unique quarantine dir, handling same-second re-trigger by
    # appending -tryN (up to -try10) — see RESEARCH Pitfall 4.
    local stamp
    stamp=$(date +%Y%m%d-%H%M%S)
    local qdir="${STATE_DIR}/quarantine-${stamp}"
    if [ -e "${qdir}" ]; then
        local n=1
        while [ -e "${qdir}-try${n}" ] && (( n < 10 )); do
            n=$((n + 1))
        done
        qdir="${qdir}-try${n}"
    fi
    mkdir -p "${qdir}"

    local f dest
    for f in "${untracked[@]}"; do
        dest="${qdir}/${f}"
        mkdir -p "$(dirname "${dest}")"
        # `mv` is atomic within the same filesystem and relocates symlink
        # nodes themselves (does NOT follow). die() flushes on_error → reset.
        mv "${INSTALL_DIR}/${f}" "${dest}" || die "quarantine move failed for ${f}"
    done

    log "quarantined ${#untracked[@]} file(s) to ${qdir}"

    # Retention prune AFTER quarantine creation (the new dir is already
    # counted, so keep newest QUARANTINE_RETAIN total by skipping the first
    # QUARANTINE_RETAIN entries from `ls -1td`).
    local existing
    existing=$(ls -1td "${STATE_DIR}"/quarantine-* 2>/dev/null | tail -n +$((QUARANTINE_RETAIN + 1)) || true)
    if [ -n "${existing}" ]; then
        log "pruning old quarantine dirs"
        echo "${existing}" | xargs -r rm -rf
    fi

    # Persist the event to state.json so the UI can surface a yellow banner.
    # `date +%s%3N` is GNU coreutils on Debian — millisecond precision.
    local epoch_ms
    epoch_ms=$(date +%s%3N)
    state_set_quarantine "${epoch_ms}" "${#untracked[@]}" "${qdir}"

    log "git working tree clean (after quarantine)"
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
        --exclude='./.update-state/quarantine-*' \
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

    # Optimization: skip pnpm install if neither package.json nor the lockfile changed
    # between the rollback SHA and the new SHA. Saves 30-90s on UI/doc-only updates.
    # Fails-open on any git diff error → falls through to the install.
    local deps_changed=1
    if [ -n "${ROLLBACK_SHA:-}" ] && [ -n "${NEW_SHA:-}" ]; then
        if git diff --name-only "${ROLLBACK_SHA}" "${NEW_SHA}" 2>/dev/null \
            | grep -qE '^(package\.json|pnpm-lock\.yaml)$'; then
            deps_changed=1
        else
            deps_changed=0
        fi
    fi

    if [ "${deps_changed}" = "0" ]; then
        log "pnpm install SKIPPED (neither package.json nor pnpm-lock.yaml changed)"
    else
        log "pnpm install --frozen-lockfile"
        pnpm install --frozen-lockfile || die "pnpm install failed"
    fi
}

do_backup_db() {
    CURRENT_STAGE="backup_db"
    db_update_stage "${CURRENT_STAGE}"
    if [ ! -f "${DB}" ]; then
        log "no DB file at ${DB} — skipping backup (fresh install?)"
        return 0
    fi
    # Prune old pre-migrate backups (keep last DB_BACKUP_RETAIN-1 so the new
    # one fits the budget after we write it). Same pattern as snapshots.
    local existing
    existing=$(ls -1t "${DB_BACKUP_DIR}/${DB_BACKUP_PREFIX}"* 2>/dev/null | tail -n +${DB_BACKUP_RETAIN} || true)
    if [ -n "${existing}" ]; then
        log "pruning old pre-migrate DB backups"
        echo "${existing}" | xargs -r rm -f
    fi
    local stamp
    stamp=$(date +%Y%m%d-%H%M%S)
    PRE_MIGRATE_BACKUP="${DB_BACKUP_DIR}/${DB_BACKUP_PREFIX}${stamp}"
    log "backing up DB to ${PRE_MIGRATE_BACKUP}"
    # sqlite3 .backup is atomic and includes WAL — safer than `cp` even with
    # the service stopped, in case a stray writer is still draining.
    sqlite3 "${DB}" ".backup ${PRE_MIGRATE_BACKUP}" || die "DB backup failed"
    log "backup size: $(du -h "${PRE_MIGRATE_BACKUP}" | cut -f1)"
}

do_migrate() {
    CURRENT_STAGE="migrate"
    db_update_stage "${CURRENT_STAGE}"
    cd "${INSTALL_DIR}"
    MIGRATE_RAN=1
    log "applying drizzle migrations"
    pnpm exec tsx scripts/db/migrate.ts || die "drizzle migrate failed"
}

restore_db_backup_if_needed() {
    # Called from rollback. Restores PRE_MIGRATE_BACKUP over DB so the rolled-
    # back code sees the schema it expects. No-op if migrate stage was never
    # reached or backup is missing.
    if [ "${MIGRATE_RAN}" -ne 1 ]; then
        return 0
    fi
    if [ -z "${PRE_MIGRATE_BACKUP}" ] || [ ! -f "${PRE_MIGRATE_BACKUP}" ]; then
        log "rollback: no pre-migrate DB backup to restore (PRE_MIGRATE_BACKUP=${PRE_MIGRATE_BACKUP})"
        return 0
    fi
    log "rollback: restoring DB from ${PRE_MIGRATE_BACKUP}"
    # Service is already stopped by Stage 1. Use sqlite3 .restore via a fresh
    # connection on the backup file: simplest is just `cp` since the live DB
    # is closed. Sweep the WAL/SHM that might be left over from the live run.
    rm -f "${DB}-wal" "${DB}-shm"
    cp "${PRE_MIGRATE_BACKUP}" "${DB}" || { log "DB restore cp FAILED"; return 1; }
    log "DB restored"
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

do_refresh_units() {
    CURRENT_STAGE="refresh_units"
    db_update_stage "${CURRENT_STAGE}"

    local repo_unit="${INSTALL_DIR}/scripts/update/charging-master.service"
    local live_unit="/etc/systemd/system/charging-master.service"
    local repo_updater_unit="${INSTALL_DIR}/scripts/update/charging-master-updater.service"
    local live_updater_unit="/etc/systemd/system/charging-master-updater.service"
    local changed=0

    if [ -f "${repo_unit}" ]; then
        if ! cmp -s "${repo_unit}" "${live_unit}" 2>/dev/null; then
            log "refreshing ${live_unit} (differs from repo canonical)"
            cp "${repo_unit}" "${live_unit}"
            changed=1
        fi
    fi
    if [ -f "${repo_updater_unit}" ]; then
        if ! cmp -s "${repo_updater_unit}" "${live_updater_unit}" 2>/dev/null; then
            log "refreshing ${live_updater_unit} (differs from repo canonical)"
            cp "${repo_updater_unit}" "${live_updater_unit}"
            changed=1
        fi
    fi
    if [ "${changed}" = "1" ]; then
        systemctl daemon-reload || log "systemctl daemon-reload failed (non-fatal)"
        log "systemd unit files refreshed — new config applies on next start"
    fi

    # Idempotent cleanup of stale DB artefacts left by older install/update
    # generations. Keeps /opt/charging-master/data slim and reduces the noise
    # in any "ls data/" call.
    cd "${INSTALL_DIR}/data" 2>/dev/null || return 0
    rm -f charging-master.db.corrupt 2>/dev/null || true
    # Empty placeholder created by an early misconfiguration on 2026-04-28.
    if [ -f charging.db ] && [ ! -s charging.db ]; then
        rm -f charging.db 2>/dev/null || true
    fi
    # Old .bak.* generation (pre-Phase-9 naming). Newer pre-migrate-* backups
    # are pruned by do_backup_db's DB_BACKUP_RETAIN loop and stay untouched.
    local stale_baks
    stale_baks=$(ls -1 charging-master.db.bak.* 2>/dev/null | head -100 || true)
    if [ -n "${stale_baks}" ]; then
        log "removing $(echo "${stale_baks}" | wc -l | tr -d ' ') stale .bak.* backup(s)"
        # shellcheck disable=SC2086
        rm -f ${stale_baks} 2>/dev/null || true
    fi
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

    # Restore pre-migrate DB if the migrate stage ran — otherwise the rolled-
    # back code may face a schema it doesn't know about. No-op if no backup.
    restore_db_backup_if_needed || { log "Stage 1 DB restore FAILED"; return 1; }

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
    # Phase 13 (PIPE-02): reset updateStatus to idle BEFORE any other state
    # writes. If a subsequent state_set_rolled_back succeeds it will override
    # updateStatus to 'rolled_back' (correct — surfaces the red banner). If
    # state_set_rolled_back silently fails (the 2026-05-15 incident class
    # where preflight_git died while state.json was 'installing'),
    # updateStatus stays 'idle' so the next /api/update/trigger does NOT
    # 409 'already in progress'.
    local exit_code="$1"
    local lineno="$2"
    local failed_stage="${CURRENT_STAGE}"
    local error_message="stage=${failed_stage} line=${lineno} exit=${exit_code}"

    log "on_error triggered: ${error_message}"

    # Disable the trap inside the trap so rollback failures don't recursively
    # fire it and loop forever.
    trap - ERR

    # PIPE-02: unconditional idle reset before any case-arm bookkeeping. The
    # `|| true` keeps a helper failure from itself crashing the trap (defense
    # in depth — the trap is already disabled above).
    state_set_idle_clearing_inprogress || true

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

    # --- Install + DB backup + migrate + clean + build ---
    do_install
    do_backup_db
    do_migrate
    do_clean_build
    do_build

    # --- Refresh systemd units (idempotent — no-op when unchanged) ---
    # Done after build (no failed builds → stale unit files) and before start
    # so the new unit applies to THIS start. Cleans stale DB artefacts too.
    do_refresh_units

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
