---
status: partial
phase: 06-device-discovery-mqtt-removal
source: [06-VERIFICATION.md]
started: 2026-04-10T01:16:00Z
updated: 2026-04-10T01:16:00Z
---

## Current Test

[awaiting human testing]

## Tests

### 1. App starts without MQTT
expected: `pnpm dev` starts cleanly with no MQTT errors in console
result: [pending]

### 2. Network discovery scan
expected: Navigate to /devices, click "Geraete suchen", scan finds Shelly devices showing ID, IP, model, and power
result: [pending]

### 3. One-click registration
expected: Click "Hinzufuegen" on discovered device, registers with IP auto-filled and starts polling
result: [pending]

### 4. Settings and sidebar visual check
expected: /settings shows only Pushover section (no MQTT), sidebar has no MQTT connection indicator
result: [pending]

## Summary

total: 4
passed: 0
issues: 0
pending: 4
skipped: 0
blocked: 0

## Gaps
