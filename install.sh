#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# charging-master installer
# One-line install: curl -sSL https://raw.githubusercontent.com/meintechblog/charging-master/main/install.sh | bash -s -- install
# =============================================================================

INSTALL_DIR="/opt/charging-master"
SERVICE_NAME="charging-master"
REPO_URL="https://github.com/meintechblog/charging-master.git"
NODE_MAJOR=22
REQUIRED_PNPM=10

# ---------------------------------------------------------------------------
# Colors (disabled when not on a TTY)
# ---------------------------------------------------------------------------
if [ -t 1 ]; then
  GREEN='\033[0;32m'
  YELLOW='\033[1;33m'
  RED='\033[0;31m'
  NC='\033[0m'
else
  GREEN=''
  YELLOW=''
  RED=''
  NC=''
fi

log()   { echo -e "${GREEN}[charging-master]${NC} $*"; }
warn()  { echo -e "${YELLOW}[charging-master] WARNING:${NC} $*"; }
error() { echo -e "${RED}[charging-master] ERROR:${NC} $*" >&2; }

# ---------------------------------------------------------------------------
# install
# ---------------------------------------------------------------------------
do_install() {
  # 1. Must be root
  if [ "$(id -u)" -ne 0 ]; then
    error "This script must be run as root."
    exit 1
  fi

  # 2. Check OS
  if [ -f /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    case "$ID" in
      debian|ubuntu) log "Detected $PRETTY_NAME" ;;
      *) warn "Unsupported OS ($ID). Proceeding anyway — things may break." ;;
    esac
  else
    warn "Cannot detect OS. Proceeding anyway."
  fi

  # 3. System dependencies
  log "Installing system dependencies..."
  apt-get update -qq
  apt-get install -y -qq curl git build-essential python3 > /dev/null

  # 4. Node.js 22
  local need_node=false
  if ! command -v node &> /dev/null; then
    need_node=true
  else
    local current_major
    current_major=$(node -v | sed 's/v\([0-9]*\).*/\1/')
    if [ "$current_major" -ne "$NODE_MAJOR" ]; then
      need_node=true
    fi
  fi
  if [ "$need_node" = true ]; then
    log "Installing Node.js ${NODE_MAJOR}..."
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - > /dev/null 2>&1
    apt-get install -y -qq nodejs > /dev/null
  else
    log "Node.js $(node -v) already installed."
  fi

  # 5. pnpm
  if ! command -v pnpm &> /dev/null; then
    log "Installing pnpm..."
    if command -v corepack &> /dev/null; then
      corepack enable
      corepack prepare "pnpm@latest" --activate
    else
      npm install -g "pnpm@${REQUIRED_PNPM}"
    fi
  else
    log "pnpm $(pnpm -v) already installed."
  fi

  # 6. Clone repo
  if [ -d "$INSTALL_DIR" ]; then
    error "$INSTALL_DIR already exists. Use 'update' mode instead."
    exit 1
  fi
  log "Cloning repository..."
  git clone "$REPO_URL" "$INSTALL_DIR"

  # 7. Build
  cd "$INSTALL_DIR"

  log "Installing dependencies..."
  pnpm install --frozen-lockfile || pnpm install

  log "Building application..."
  pnpm build

  mkdir -p data

  log "Applying database schema..."
  pnpm db:push

  # 8. Systemd service
  log "Creating systemd service..."
  cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<'UNIT'
[Unit]
Description=Charging-Master Web App
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/charging-master
ExecStart=/usr/bin/npx tsx server.ts
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
KillMode=control-group
TimeoutStopSec=5

[Install]
WantedBy=multi-user.target
UNIT

  # 9. Enable and start
  systemctl daemon-reload
  systemctl enable --now "$SERVICE_NAME"

  # 10. Success
  local ip
  ip=$(hostname -I | awk '{print $1}')
  echo ""
  log "Installation complete!"
  log "Charging-Master is running at: http://${ip}:3000"
  log ""
  log "Manage the service:"
  log "  systemctl status ${SERVICE_NAME}"
  log "  systemctl restart ${SERVICE_NAME}"
  log "  journalctl -u ${SERVICE_NAME} -f"
}

# ---------------------------------------------------------------------------
# update
# ---------------------------------------------------------------------------
do_update() {
  if [ "$(id -u)" -ne 0 ]; then
    error "This script must be run as root."
    exit 1
  fi

  if [ ! -d "$INSTALL_DIR" ]; then
    error "$INSTALL_DIR does not exist. Run 'install' first."
    exit 1
  fi

  cd "$INSTALL_DIR"

  log "Stopping service..."
  systemctl stop "$SERVICE_NAME" 2>/dev/null || true

  log "Pulling latest code..."
  git fetch origin
  git reset --hard origin/main

  log "Installing dependencies..."
  pnpm install --frozen-lockfile || pnpm install

  log "Building application..."
  pnpm build

  log "Applying database schema..."
  pnpm db:push

  log "Starting service..."
  systemctl start "$SERVICE_NAME"

  local ip
  ip=$(hostname -I | awk '{print $1}')
  echo ""
  log "Update complete!"
  log "Charging-Master is running at: http://${ip}:3000"
}

# ---------------------------------------------------------------------------
# uninstall
# ---------------------------------------------------------------------------
do_uninstall() {
  if [ "$(id -u)" -ne 0 ]; then
    error "This script must be run as root."
    exit 1
  fi

  # Confirmation — require --yes when piped (non-interactive)
  local confirmed=false
  for arg in "$@"; do
    if [ "$arg" = "--yes" ]; then
      confirmed=true
    fi
  done

  if [ "$confirmed" = false ]; then
    if [ -t 0 ]; then
      read -rp "[charging-master] Are you sure? This will remove charging-master and all data. [y/N] " answer
      case "$answer" in
        [yY]|[yY][eE][sS]) confirmed=true ;;
      esac
    else
      error "Non-interactive mode. Pass '--yes' to confirm: curl ... | bash -s -- uninstall --yes"
      exit 1
    fi
  fi

  if [ "$confirmed" = false ]; then
    log "Aborted."
    exit 0
  fi

  log "Stopping service..."
  systemctl stop "$SERVICE_NAME" 2>/dev/null || true

  log "Disabling service..."
  systemctl disable "$SERVICE_NAME" 2>/dev/null || true

  log "Removing service file..."
  rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
  systemctl daemon-reload

  log "Removing installation directory..."
  rm -rf "$INSTALL_DIR"

  echo ""
  log "Uninstall complete. Node.js and pnpm were left in place."
}

# ---------------------------------------------------------------------------
# Main — parse command
# ---------------------------------------------------------------------------
CMD="${1:-install}"
shift || true

case "$CMD" in
  install)   do_install "$@" ;;
  update)    do_update "$@" ;;
  uninstall) do_uninstall "$@" ;;
  *)
    error "Unknown command: $CMD"
    echo ""
    echo "Usage: install.sh {install|update|uninstall} [--yes]"
    echo ""
    echo "  install    Install charging-master (default)"
    echo "  update     Update to latest version"
    echo "  uninstall  Remove charging-master and all data"
    exit 1
    ;;
esac
