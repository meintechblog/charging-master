---
phase: quick
plan: 260409-b9z
subsystem: installer
tags: [proxmox, lxc, deployment, automation]
dependency_graph:
  requires: [install.sh]
  provides: [create-lxc-mode]
  affects: [install.sh]
tech_stack:
  added: [pct, pveam, pvesh]
  patterns: [proxmox-cli-automation, lxc-provisioning]
key_files:
  modified:
    - install.sh
decisions:
  - "Flag parsing via while-shift loop for --storage, --bridge, --hostname"
  - "Template download uses pveam with debian-13-standard_13.0-1_amd64.tar.zst"
  - "Network wait polls 6 times at 5s intervals (30s total)"
metrics:
  duration: 53s
  completed: "2026-04-09"
  tasks: 1
  files: 1
---

# Quick Task 260409-b9z: Extend install.sh with create-lxc mode Summary

Added Proxmox LXC provisioning mode to install.sh -- one command creates a Debian 13 container, bootstraps dependencies, and runs the existing install mode inside it.

## What Changed

### Task 1: Add create-lxc mode to install.sh
- **Commit:** dd97532
- **Files:** install.sh

Added `do_create_lxc()` function implementing all 9 steps:
1. Flag parsing (--storage, --bridge, --hostname with defaults)
2. Proxmox host check (pct command existence)
3. Root permission check
4. Template download/detection via pveam
5. VMID allocation via pvesh
6. Container creation with nesting=1 for systemd
7. Network wait loop (30s timeout)
8. Bootstrap via curl-pipe-bash of install.sh inside container
9. Summary output with VMID, hostname, IP, and URL

Updated case statement and usage text to include create-lxc command with option documentation.

## Deviations from Plan

None -- plan executed exactly as written.

## Verification

- `bash -n install.sh` passes (no syntax errors)
- `grep -c 'do_install\|do_update\|do_uninstall'` returns 6 (unchanged from before)
- `grep 'create-lxc' install.sh` shows case entry and usage text
- `grep 'do_create_lxc' install.sh` confirms function exists

## Self-Check: PASSED
