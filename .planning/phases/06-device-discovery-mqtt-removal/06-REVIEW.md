---
phase: 06-device-discovery-mqtt-removal
reviewed: 2026-04-09T14:22:00Z
depth: standard
files_reviewed: 11
files_reviewed_list:
  - src/modules/shelly/discovery-scanner.ts
  - src/app/api/devices/discover/route.ts
  - src/app/api/devices/route.ts
  - src/components/devices/discovery-list.tsx
  - src/components/devices/add-device-form.tsx
  - src/app/devices/device-manager.tsx
  - server.ts
  - src/types/global.d.ts
  - src/app/settings/page.tsx
  - src/components/layout/sidebar.tsx
  - src/db/schema.ts
findings:
  critical: 2
  warning: 5
  info: 2
  total: 9
status: issues_found
---

# Phase 6: Code Review Report

**Reviewed:** 2026-04-09T14:22:00Z
**Depth:** standard
**Files Reviewed:** 11
**Status:** issues_found

## Summary

The phase implements HTTP-based device discovery and management, replacing MQTT with direct Shelly HTTP API communication. The architecture is sound: a custom `server.ts` bootstraps services and exposes them via `globalThis`, API routes handle CRUD, and client components provide discovery and manual-add UIs.

Key concerns: the API routes lack input validation/sanitization on user-supplied IP addresses (SSRF risk), the DELETE endpoint accepts a body which some HTTP clients strip, and error handling in `handleAddFromDiscovery` silently swallows failures.

## Critical Issues

### CR-01: Server-Side Request Forgery (SSRF) via unvalidated IP address in discovery scanner

**File:** `src/modules/shelly/discovery-scanner.ts:43`
**Issue:** `probeDevice` accepts an arbitrary IP string and makes HTTP requests to it (`http://${ip}/rpc/...`). While `scanSubnet` generates IPs internally, `probeDevice` is exported and the IP ultimately originates from user input when devices are registered (the IP is stored and later used for polling). More critically, the `add-device-form.tsx` accepts any string as `ipAddress` and it is stored and used for HTTP requests without validation. An attacker on the local network could supply a crafted IP like `127.0.0.1`, an internal hostname, or an IP with port (`192.168.1.1:8080/../../`) to probe internal services.
**Fix:**
```typescript
// In src/app/api/devices/route.ts POST handler, validate IP format before storing:
const IPV4_REGEX = /^(\d{1,3}\.){3}\d{1,3}$/;
if (!IPV4_REGEX.test(ipAddress)) {
  return Response.json({ error: 'invalid_ip_format' }, { status: 400 });
}
const parts = ipAddress.split('.').map(Number);
if (parts.some(p => p < 0 || p > 255)) {
  return Response.json({ error: 'invalid_ip_range' }, { status: 400 });
}
```

### CR-02: Unvalidated JSON body parsing in API routes can crash the server

**File:** `src/app/api/devices/route.ts:13`
**Issue:** `await request.json()` is called without try/catch in POST, PATCH, and DELETE handlers. If the request body is not valid JSON (e.g., empty body, malformed content), this will throw an unhandled exception, resulting in a 500 error with a stack trace leak. The DELETE handler (line 107) is especially vulnerable since some HTTP clients/proxies strip bodies from DELETE requests.
**Fix:**
```typescript
// Wrap each handler's body parsing:
let body: unknown;
try {
  body = await request.json();
} catch {
  return Response.json({ error: 'invalid_json' }, { status: 400 });
}
```

## Warnings

### WR-01: Silent failure in handleAddFromDiscovery

**File:** `src/app/devices/device-manager.tsx:27-41`
**Issue:** `handleAddFromDiscovery` does not handle errors. If `fetch` throws (network error) or the response is not ok, the user gets no feedback. The function has no try/catch and only calls `router.refresh()` on success.
**Fix:**
```typescript
async function handleAddFromDiscovery(deviceId: string, ip: string) {
  try {
    const res = await fetch('/api/devices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: deviceId, name: deviceId, ipAddress: ip }),
    });
    if (res.ok) {
      router.refresh();
    } else {
      // Show error to user (add error state)
      console.error('Failed to add device:', res.status);
    }
  } catch (err) {
    console.error('Network error adding device:', err);
  }
}
```

### WR-02: DELETE endpoint uses request body instead of URL parameter

**File:** `src/app/api/devices/route.ts:106-127`
**Issue:** The DELETE handler reads the device ID from the request body. Per HTTP semantics, DELETE request bodies are not guaranteed to be preserved by intermediaries (proxies, CDNs). Some `fetch` implementations also ignore the body for DELETE. This can silently fail in certain environments.
**Fix:** Use a query parameter or path parameter instead:
```typescript
// Option A: query parameter
export async function DELETE(request: Request) {
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  if (!id) {
    return Response.json({ error: 'invalid_input' }, { status: 400 });
  }
  // ... rest of handler
}
```

### WR-03: PATCH handler allows arbitrary field updates without type validation

**File:** `src/app/api/devices/route.ts:62-103`
**Issue:** The PATCH handler destructures updates from the body with a type assertion (`as { ... }`) but does not validate the actual runtime types. A client could send `{ id: "x", pollingInterval: "not-a-number" }` or `{ id: "x", enabled: "yes" }`, and these would be written directly to the database. The `pollingInterval` field is used in arithmetic (`* 1000` on line 98), which would produce `NaN` if a non-number is passed.
**Fix:** Add runtime validation with zod (already a project dependency):
```typescript
import { z } from 'zod';

const patchSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  ipAddress: z.string().nullable().optional(),
  pollingInterval: z.number().int().min(1).max(60).optional(),
  enabled: z.boolean().optional(),
});
```

### WR-04: Subnet scan API route has no timeout protection

**File:** `src/app/api/devices/discover/route.ts:5-16`
**Issue:** The GET handler calls `scanSubnet()` which probes 254 IPs with 1500ms timeout each. In the worst case (all IPs timing out), the scan takes ~254 * 1500ms / 20 concurrency = ~19 seconds. Next.js API routes typically have a 60-second timeout, but this is still a long-running request with no way for the client to cancel or track progress. The `onProgress` callback is unused.
**Fix:** Consider adding a reasonable overall timeout or documenting the expected duration. At minimum, pass through an AbortSignal:
```typescript
export async function GET(request: Request) {
  try {
    const devices = await scanSubnet();
    return Response.json({ devices });
  } catch (err) {
    // ... error handling
  }
}
```

### WR-05: Dead code -- ipAddress null coalescing after non-null guard

**File:** `src/app/api/devices/route.ts:39`
**Issue:** Line 25-26 already validates that `ipAddress` exists and is a string (`if (!ipAddress ...)`), returning 400 if missing. But line 39 still uses `ipAddress ?? null`. This is dead code that obscures the actual invariant (ipAddress is guaranteed non-null at that point).
**Fix:**
```typescript
ipAddress: ipAddress, // guaranteed non-null by validation above
```

## Info

### IN-01: console.error in production API route

**File:** `src/app/api/devices/discover/route.ts:10`
**Issue:** `console.error('Subnet scan failed:', err)` will output to stdout/stderr in production. The project conventions note minimal logging and no structured logging. This is fine for debugging but should be noted.
**Fix:** Acceptable for now; consider structured logging if the project adds it later.

### IN-02: Duplicated DiscoveredDevice type definition

**File:** `src/components/devices/discovery-list.tsx:5-12`
**Issue:** The `DiscoveredDevice` type mirrors `ScanResult` from `discovery-scanner.ts` exactly. If the scanner type changes, this client type will silently drift out of sync.
**Fix:** Consider exporting a shared type or importing `ScanResult` in a shared types file that both server and client code can reference.

---

_Reviewed: 2026-04-09T14:22:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
