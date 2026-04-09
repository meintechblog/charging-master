---
phase: quick
plan: 260409-awk
subsystem: deployment
tags: [installer, bash, systemd, deployment]
dependency_graph:
  requires: []
  provides: [one-line-installer]
  affects: [deployment, onboarding]
tech_stack:
  added: []
  patterns: [curl-pipe-bash-installer, systemd-service-management]
key_files:
  created:
    - install.sh
  modified: []
decisions:
  - "ExecStart uses npx tsx server.ts matching existing start script pattern"
  - "Node.js and pnpm left in place on uninstall (shared system resources)"
  - "Non-interactive uninstall requires --yes flag for safety"
metrics:
  duration: 57s
  completed: "2026-04-09"
  tasks_completed: 1
  tasks_total: 1
  files_changed: 1
---

# Quick Plan 260409-awk: Create One-Line Installer Script Summary

Self-contained bash installer with install/update/uninstall modes for Debian LXC deployment of charging-master.

## What Was Done

### Task 1: Create install.sh with install/update/uninstall modes
**Commit:** `df1042c`

Created `install.sh` at repo root with three modes:

- **install**: Root check, Debian detection, installs system deps (build-essential, python3 for better-sqlite3), Node.js 22 via NodeSource, pnpm via corepack, clones repo to /opt/charging-master, builds, runs db:push, creates systemd service with NODE_ENV=production, enables and starts service.
- **update**: Stops service, git fetch + reset --hard origin/main, reinstalls deps, rebuilds, migrates DB (preserving SQLite data), restarts service.
- **uninstall**: Interactive confirmation (or --yes flag for piped execution), stops/disables service, removes systemd unit and install directory. Does not remove Node.js/pnpm.

Script features: colored output with TTY detection, `[charging-master]` log prefix, `set -euo pipefail`, safe for `curl | bash` piping.

## Deviations from Plan

None -- plan executed exactly as written.

## Verification

- `bash -n install.sh` passes (no syntax errors)
- Script contains all three functions: do_install, do_update, do_uninstall
- Script sets NODE_ENV=production in systemd unit
- Script uses /opt/charging-master as install directory
- Script handles better-sqlite3 build deps (build-essential, python3)

## Self-Check: PASSED
