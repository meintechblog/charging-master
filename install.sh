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
  pnpm install --frozen-lockfile 2>/dev/null || pnpm install

  log "Building application..."
  pnpm build

  mkdir -p data

  log "Applying database schema..."
  pnpm db:push

  # 8. mDNS (avahi) for charging-master.local
  log "Setting up mDNS (charging-master.local)..."
  apt-get install -y -qq avahi-daemon > /dev/null 2>&1
  systemctl enable --now avahi-daemon 2>/dev/null || true

  # 9. Systemd service
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
Environment=PORT=80
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
  log "Charging-Master is running at: http://${ip}"
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

  log "Updating systemd service..."
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
Environment=PORT=80
KillMode=control-group
TimeoutStopSec=5

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload

  log "Starting service..."
  systemctl start "$SERVICE_NAME"

  local ip
  ip=$(hostname -I | awk '{print $1}')
  echo ""
  log "Update complete!"
  log "Charging-Master is running at: http://${ip}"
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
# create-lxc (Proxmox)
# ---------------------------------------------------------------------------
do_create_lxc() {
  # 1. Parse flags
  local STORAGE="local-lvm"
  local BRIDGE="vmbr0"
  local CT_HOSTNAME="charging-master"

  while [ $# -gt 0 ]; do
    case "$1" in
      --storage)  STORAGE="$2"; shift 2 ;;
      --bridge)   BRIDGE="$2"; shift 2 ;;
      --hostname) CT_HOSTNAME="$2"; shift 2 ;;
      *) error "Unknown option: $1"; exit 1 ;;
    esac
  done

  # 2. Proxmox check
  if ! command -v pct &> /dev/null; then
    error "This command must be run on a Proxmox host."
    exit 1
  fi

  # 3. Root check
  if [ "$(id -u)" -ne 0 ]; then
    error "This script must be run as root."
    exit 1
  fi

  # 4. Template handling
  local TEMPLATE
  TEMPLATE=$(pveam list local 2>/dev/null | grep 'debian-13' | awk '{print $1}' | head -1 | sed 's|^local:vztmpl/||')

  if [ -z "$TEMPLATE" ]; then
    log "Downloading Debian 13 template..."
    pveam update > /dev/null 2>&1 || true
    local AVAILABLE
    AVAILABLE=$(pveam available --section system 2>/dev/null | grep 'debian-13' | awk '{print $2}' | head -1)
    if [ -z "$AVAILABLE" ]; then
      error "No Debian 13 template available. Check: pveam available --section system"
      exit 1
    fi
    pveam download local "$AVAILABLE"
    TEMPLATE=$(pveam list local 2>/dev/null | grep 'debian-13' | awk '{print $1}' | head -1 | sed 's|^local:vztmpl/||')
    if [ -z "$TEMPLATE" ]; then
      error "Failed to download Debian 13 template."
      exit 1
    fi
  fi

  log "Using template: ${TEMPLATE}"

  # 5. Get next VMID
  local VMID
  VMID=$(pvesh get /cluster/nextid)
  log "Assigned VMID: ${VMID}"

  # 6. Create container
  log "Creating LXC container..."
  pct create "$VMID" "local:vztmpl/${TEMPLATE}" \
    --hostname "$CT_HOSTNAME" \
    --cores 1 \
    --memory 1024 \
    --swap 512 \
    --rootfs "${STORAGE}:8" \
    --net0 "name=eth0,bridge=${BRIDGE},ip=dhcp" \
    --unprivileged 1 \
    --features nesting=1 \
    --start 1

  # 7. Wait for network
  log "Waiting for network..."
  local ip=""
  local retries=0
  while [ -z "$ip" ] && [ "$retries" -lt 6 ]; do
    sleep 5
    ip=$(pct exec "$VMID" -- hostname -I 2>/dev/null | awk '{print $1}') || true
    retries=$((retries + 1))
  done

  if [ -z "$ip" ]; then
    warn "Could not detect container IP after 30 seconds."
  else
    log "Container IP: ${ip}"
  fi

  # 8. Bootstrap inside container
  log "Installing charging-master inside CT ${VMID}..."
  pct exec "$VMID" -- bash -c "apt-get update -qq && apt-get install -y -qq curl git build-essential python3 > /dev/null"
  pct exec "$VMID" -- bash -c "curl -sSL https://raw.githubusercontent.com/meintechblog/charging-master/main/install.sh | bash -s -- install"

  # 9. Print result
  echo ""
  log "LXC container created successfully!"
  log "  VMID:     ${VMID}"
  log "  Hostname: ${CT_HOSTNAME}"
  log "  IP:       ${ip:-unknown}"
  log ""
  if [ -n "$ip" ]; then
    log "Charging-Master is running at: http://${ip}"
  else
    log "Could not detect IP. Check: pct exec ${VMID} -- hostname -I"
  fi
}

# ---------------------------------------------------------------------------
# Main — parse command
# ---------------------------------------------------------------------------
CMD="${1:-install}"
shift || true

case "$CMD" in
  install)    do_install "$@" ;;
  update)     do_update "$@" ;;
  uninstall)  do_uninstall "$@" ;;
  create-lxc) do_create_lxc "$@" ;;
  *)
    error "Unknown command: $CMD"
    echo ""
    echo "Usage: install.sh {install|update|uninstall|create-lxc} [options]"
    echo ""
    echo "  install      Install charging-master (default)"
    echo "  update       Update to latest version"
    echo "  uninstall    Remove charging-master and all data"
    echo "  create-lxc   Create LXC container on Proxmox and install"
    echo ""
    echo "create-lxc options:"
    echo "  --storage NAME   Rootfs storage (default: local-lvm)"
    echo "  --bridge NAME    Network bridge (default: vmbr0)"
    echo "  --hostname NAME  Container hostname (default: charging-master)"
    exit 1
    ;;
esac
