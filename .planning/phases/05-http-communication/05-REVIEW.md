---
phase: 05-http-communication
reviewed: 2026-04-09T12:00:00Z
depth: standard
files_reviewed: 10
files_reviewed_list:
  - server.ts
  - src/app/api/charging/learn/start/route.ts
  - src/app/api/charging/learn/stop/route.ts
  - src/app/api/devices/[id]/relay/route.ts
  - src/app/api/devices/route.ts
  - src/modules/charging/charge-monitor.ts
  - src/modules/charging/relay-controller.ts
  - src/modules/shelly/http-polling-service.ts
  - src/modules/shelly/relay-http.ts
  - src/types/global.d.ts
findings:
  critical: 1
  warning: 5
  info: 2
  total: 8
status: issues_found
---

# Phase 05: Code Review Report

**Reviewed:** 2026-04-09T12:00:00Z
**Depth:** standard
**Files Reviewed:** 10
**Status:** issues_found

## Summary

This review covers the HTTP communication layer for Shelly device control: HTTP polling, relay switching, API routes for device CRUD and charge learning, the central ChargeMonitor, and the global type declarations. The code is generally well-structured with clear separation of concerns. However, there is one critical SSRF vulnerability, several missing input validation and error handling issues, and a race condition in session creation.

## Critical Issues

### CR-01: SSRF via unvalidated IP address in HTTP relay and polling

**File:** `src/modules/shelly/relay-http.ts:12-15`, `src/modules/shelly/http-polling-service.ts:36-38`
**Issue:** The `ipAddress` parameter is interpolated directly into fetch URLs (`http://${ipAddress}/rpc/...`) without any validation. The IP address originates from user input via the `POST /api/devices` and `PATCH /api/devices` endpoints. A malicious or accidental value like `169.254.169.254` (cloud metadata), `127.0.0.1:3000`, or `attacker.com` would cause the server to make requests to arbitrary hosts (Server-Side Request Forgery). While this is a local-network single-user app, the pattern is dangerous if the network boundary assumption ever changes.
**Fix:** Validate that `ipAddress` is a valid private/local IPv4 address before storing it in the database and before making HTTP requests:
```typescript
// src/lib/validate-ip.ts
const PRIVATE_IP_REGEX = /^(192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/;

export function isValidLocalIp(ip: string): boolean {
  return PRIVATE_IP_REGEX.test(ip);
}
```
Apply validation in `POST /api/devices` and `PATCH /api/devices` before persisting `ipAddress`.

## Warnings

### WR-01: Unhandled JSON parse errors in devices route PATCH and DELETE

**File:** `src/app/api/devices/route.ts:61`, `src/app/api/devices/route.ts:105`
**Issue:** The `PATCH` and `DELETE` handlers call `await request.json()` without a try/catch block. If the request body is not valid JSON, an unhandled exception will crash the route and return a generic 500 error. The `POST` handler in the same file (line 13) also lacks this protection, though other routes like `learn/start` and `learn/stop` correctly wrap `request.json()` in try/catch.
**Fix:** Wrap all three handlers consistently:
```typescript
let body: { id: string; /* ... */ };
try {
  body = await request.json();
} catch {
  return Response.json({ error: 'invalid_body' }, { status: 400 });
}
```

### WR-02: Race condition in learning session creation

**File:** `src/app/api/charging/learn/start/route.ts:38-62`
**Issue:** The check for an existing active learning session (line 38-48) and the insert of a new session (line 52-62) are not wrapped in a database transaction. Two concurrent requests for the same plug could both pass the check and create duplicate `learning` sessions, causing undefined behavior in the ChargeMonitor.
**Fix:** Wrap the check-and-insert in a Drizzle transaction:
```typescript
const result = db.transaction((tx) => {
  const activeLearning = tx.select().from(chargeSessions)
    .where(and(eq(chargeSessions.plugId, plugId), eq(chargeSessions.state, 'learning')))
    .get();
  if (activeLearning) return { error: 'learning_already_active', sessionId: activeLearning.id };

  const row = tx.insert(chargeSessions).values({
    plugId, profileId, state: 'learning', startedAt: now, createdAt: now,
  }).returning({ id: chargeSessions.id }).get();
  return { sessionId: row.id };
});
```

### WR-03: Orphaned reference_curve_points on re-learn

**File:** `src/app/api/charging/learn/stop/route.ts:163-171`
**Issue:** When overwriting an existing reference curve (re-learn), the code deletes rows from `referenceCurves` (line 170) but does not explicitly delete the associated `referenceCurvePoints` for each deleted curve. If the database schema does not have `ON DELETE CASCADE` on the foreign key, orphaned point rows will accumulate indefinitely.
**Fix:** Delete points before deleting the curve:
```typescript
for (const curve of existingCurves) {
  db.delete(referenceCurvePoints).where(eq(referenceCurvePoints.curveId, curve.id)).run();
  db.delete(referenceCurves).where(eq(referenceCurves.id, curve.id)).run();
}
```
Alternatively, confirm that the schema defines `ON DELETE CASCADE` on `referenceCurvePoints.curveId`.

### WR-04: Missing input validation on pollingInterval

**File:** `src/app/api/devices/route.ts:19`, `src/app/api/devices/route.ts:82`
**Issue:** The `pollingInterval` field from user input is accepted as-is without bounds checking. A value of `0` would cause `0 * 1000 = 0ms` interval, resulting in an infinite tight loop of HTTP requests to the Shelly device (line 69: `(plug.pollingInterval ?? 1) * 1000`). A negative value would also be problematic.
**Fix:** Validate `pollingInterval` is a positive integer within a reasonable range:
```typescript
if (pollingInterval !== undefined) {
  if (typeof pollingInterval !== 'number' || pollingInterval < 1 || pollingInterval > 60) {
    return Response.json({ error: 'invalid_polling_interval', valid: '1-60 seconds' }, { status: 400 });
  }
}
```

### WR-05: Inconsistent relay control API -- learn/start bypasses EventBus verification

**File:** `src/app/api/charging/learn/start/route.ts:71`
**Issue:** The `switchRelayOn` function in `relay-controller.ts` (line 72-76) does not verify that the relay actually turned on (it just returns the HTTP acknowledgement). In contrast, `switchRelayOff` verifies by waiting for a power drop. If the Shelly device acknowledges the command but fails to switch, the learning session starts with 0W readings and no indication of failure. The `learn/start` route silently swallows the error (line 72-74) which is intentional, but combined with no verification, the user gets no feedback that charging did not actually begin.
**Fix:** Consider logging or returning a warning in the response when `switchRelayOn` fails:
```typescript
let relayWarning: string | undefined;
if (plug.ipAddress) {
  try {
    const ok = await switchRelayOn({ id: plug.id, ipAddress: plug.ipAddress });
    if (!ok) relayWarning = 'relay_on_failed';
  } catch {
    relayWarning = 'relay_unreachable';
  }
}
// Include in response so UI can show a warning
return Response.json({ sessionId, plugId, profileId, state: 'learning', relayWarning }, { status: 201 });
```

## Info

### IN-01: Empty onTransition callback

**File:** `src/modules/charging/charge-monitor.ts:545-547`
**Issue:** The `onTransition` callback is set to an empty arrow function with a comment saying transitions are handled elsewhere. This is dead code that adds confusion.
**Fix:** Remove the assignment or add a brief comment why it must be set (e.g., if the state machine requires it to be non-null):
```typescript
// If required by ChargeStateMachine API, keep but document:
machine.onTransition = () => {}; // handled via state comparison in handlePowerReading
```

### IN-02: Global type declarations use `var` without undefined union

**File:** `src/types/global.d.ts:8-12`
**Issue:** The global declarations (`var __mqttService`, `var __eventBus`, etc.) do not include `| undefined` in their types. In practice, route handlers access these globals without null checks (e.g., `globalThis.__chargeMonitor` is checked with `if` in learn/start, but `globalThis.__httpPollingService` is accessed with `if` guard in devices route). The types should reflect that these may be undefined before `server.ts` initialization completes.
**Fix:**
```typescript
declare global {
  var __mqttService: MqttService | undefined;
  var __httpPollingService: HttpPollingService | undefined;
  var __eventBus: EventBus | undefined;
  var __discoveredDevices: Map<string, DiscoveredDevice> | undefined;
  var __chargeMonitor: ChargeMonitor | undefined;
}
```

---

_Reviewed: 2026-04-09T12:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
