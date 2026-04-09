# Phase 6: Device Discovery & MQTT Removal - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-10
**Phase:** 06-device-discovery-mqtt-removal
**Areas discussed:** Discovery mechanism, Discovery UX flow, MQTT removal scope, IP address handling

---

## Discovery Mechanism

### Scan Method

| Option | Description | Selected |
|--------|-------------|----------|
| HTTP subnet scan | Scan local subnet by calling /rpc/Shelly.GetDeviceInfo on each IP. Simple, no extra deps. | ✓ |
| mDNS/Bonjour discovery | Use mDNS _shelly._tcp. Faster but adds dependency. | |
| Both: mDNS first, subnet fallback | Most robust but more complex. | |

**User's choice:** HTTP subnet scan
**Notes:** No extra dependencies needed, works on LAN.

### Subnet Detection

| Option | Description | Selected |
|--------|-------------|----------|
| Auto-detect from server IP | Read server's IP via os.networkInterfaces(), derive /24 subnet. | ✓ |
| User-configurable in settings | Let user enter subnet in settings. | |
| Auto-detect with manual override | Auto-detect by default, allow custom subnet. | |

**User's choice:** Auto-detect from server IP
**Notes:** Zero configuration for the user.

---

## Discovery UX Flow

### Scan Trigger

| Option | Description | Selected |
|--------|-------------|----------|
| Manual button on devices page | "Geraete suchen" button. User clicks, sees progress, gets results. | ✓ |
| Auto-scan on page load | Scan when user visits devices page. | |
| Manual button + periodic background | Button for immediate scan + background scan every N minutes. | |

**User's choice:** Manual button on devices page

### Scan Results Display

| Option | Description | Selected |
|--------|-------------|----------|
| ID, IP, Model, Power | Matches DISC-02 requirement. One-click register button. | ✓ |
| Minimal: ID + IP only | Fastest scan, less info. | |
| Full status with firmware/uptime | More info but slower scan. | |

**User's choice:** ID, IP, Model, Power

---

## MQTT Removal Scope

### MQTT Settings Data

| Option | Description | Selected |
|--------|-------------|----------|
| Delete MQTT config rows | Remove mqtt.* entries from config table. Clean slate. | ✓ |
| Keep but ignore | Leave data, don't read it. | |
| Migrate to archive table | Move to separate table. Overkill. | |

**User's choice:** Delete MQTT config rows

### Settings Page

| Option | Description | Selected |
|--------|-------------|----------|
| Remove MQTT section, keep page | Delete mqtt-settings.tsx, page stays for other settings. | ✓ |
| Remove entire settings page | If MQTT was the only section. | |

**User's choice:** Remove MQTT section, keep page

---

## IP Address Handling

### Existing Devices Without IP

| Option | Description | Selected |
|--------|-------------|----------|
| Block until IP added | Warning banner, polling disabled until IP added. | ✓ |
| Auto-discover and backfill | Scan to find and auto-fill IPs. | |
| Delete devices without IP | Remove registrations, force re-add. | |

**User's choice:** Block until IP added
**Notes:** Clean enforcement of new requirement without data loss.

---

## Claude's Discretion

- Scan concurrency level
- Error handling UX during scan
- Bulk-register button decision
- Database migration approach for ipAddress

## Deferred Ideas

None — discussion stayed within phase scope.
