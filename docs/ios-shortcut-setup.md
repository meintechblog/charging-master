# iOS Shortcut — Report SoC at Plug-In

This guide walks through wiring an iOS Shortcut so your iPad / iPhone /
Mac automatically tells Charging-Master its real battery level the
moment it starts charging.

## Easy path: 1-Tap installation from `/devices`

Each plug on the dashboard's **`Geräte`** page now has an **iOS Shortcut
installieren** button. The flow:

1. Open `http://charging-master.local/devices` ON the iPhone/iPad you want
   to wire up (must be on the same WiFi as the LXC).
2. iOS → Settings → Shortcuts → enable **Allow Untrusted Shortcuts**.
   (The toggle only appears after you've run at least one Shortcut. If
   it isn't there, run any built-in Shortcut once and come back.)
3. Tap the **iOS Shortcut installieren** button next to your plug. iOS
   redirects to Shortcuts.app's import dialog.
4. Confirm **"Untrusted Shortcut hinzufügen"**. The Shortcut is now
   installed with the plug's ID and your LAN URL baked in — no manual
   editing.
5. *(Optional, recommended)* Shortcuts.app → **Automation** tab → "+" →
   **Wenn Ladegerät verbunden ist** → run the just-installed Shortcut →
   uncheck **Vor dem Ausführen fragen**. Now every plug-in event auto-
   reports the iPad's real SoC.

The remainder of this document covers the **manual** path (for non-iOS
clients, Home Assistant, curl, debugging) and explains the why behind
the architecture.

## Why?

The matcher knows the *device* (via plug pinning or DTW) and the
*battery capacity* (from the device profile). It does NOT know the
*current state-of-charge* — without ground truth it starts every
session at 0 % and walks forward via energy delivered. That works fine
for a fully-empty battery but mis-stops when the device was plugged in
at, say, 70 %: the system thinks it's at 0 %, charges to its internal
"80 %" target by delivering ~50 Wh, but the real battery hits 100 %
physical long before that and either taper-cuts or trickles.

The fix: tell Charging-Master the real SoC the moment charging starts.

## Architecture

```
[iPad starts charging]
        │
        ▼
[iOS Automation: "Charger Connected"]
        │
        ▼
[Shortcut: Get Device Battery Level]
        │
        ▼
[POST http://charging-master.local/api/devices/<plug-id>/report-soc
   body: {"soc": <integer 0-100>}]
        │
        ▼
[ChargeMonitor.overrideSession({estimatedSoc: <soc>})]
        │
        ▼
[matcher tracks forward from real start]
```

## Endpoint

```http
POST /api/devices/{plugId}/report-soc
Content-Type: application/json

{ "soc": 47 }
```

| Field   | Type    | Notes                                |
|---------|---------|--------------------------------------|
| `soc`   | integer | Real battery level, 0–100 (required) |

### Responses

- `200 OK` — `{ ok: true, sessionId, plugId, profileName, before, after }`
- `404 Not Found` — `{ error: "plug_not_found" }`
- `409 Conflict` — `{ error: "no_active_session", plugId }`
- `400 Bad Request` — `{ error: "invalid_soc" \| "invalid_body" }`
- `403 Forbidden` — request not from an allowed host

The endpoint is LAN-only (same `host-guard` as the dashboard). When your
phone is on cellular, the URL won't resolve — that's intentional. The
session keeps running with the pre-override estimate; you can resolve
manually from the dashboard if needed.

## Step-by-step: iOS Shortcut

1. **Identify your plug's ID**

   Visit the dashboard's `Geräte` page. Each registered plug shows its
   ID in monospace, e.g.
   `shellyplugsg3-d885ac15b828` (the office iPad plug).

2. **Create the Shortcut**

   On your iPad/iPhone: Shortcuts app → "+" → Add Action → search for
   `Get Battery Level` → add.

   Add the next action: `Get Contents of URL`.
   - URL: `http://charging-master.local/api/devices/shellyplugsg3-d885ac15b828/report-soc`
   - Method: `POST`
   - Headers: `Content-Type: application/json`
   - Request Body: `JSON`
     - Add field `soc` → tap, type → Number → tap, value → "Magic
       Variable" → Battery Level → tap "÷ 100" if your Shortcut returns
       0.0–1.0 floating-point. **Multiply by 100 and round.**

   (`Get Battery Level` returns 0.0–1.0 on iOS 17+. Wrap it with
   `Calculate` → `Battery Level × 100` then `Round` → use that as
   `soc`.)

3. **Create the Automation**

   Shortcuts app → Automation tab → "+" → Personal Automation → Charger.
   - Set "Is Connected"
   - Next → Add Action → "Run Shortcut" → pick the Shortcut you built
   - **Disable "Ask Before Running"** (otherwise the iPad pops a banner
     each time you plug in)

4. **Test it**

   Plug the iPad into the office plug. Within a few seconds, the
   dashboard's banner should jump from `estSoc=0 %` to your real
   battery level. From there the matcher tracks forward correctly to
   the target SoC.

## Trouble-shooting

| Symptom | Cause | Fix |
|---|---|---|
| Shortcut runs but dashboard stays at 0 % | Off-LAN / wrong plug ID | Verify URL hostname + plug ID; ensure phone is on home WiFi |
| 409 `no_active_session` | Shortcut fired before plug-detection (~30 s) | Add a `Wait 45 seconds` step before the POST |
| 400 `invalid_soc` | Battery level wasn't rounded to integer | Add `Round` after the ×100 calc |
| 403 `forbidden_host` | Phone hit the URL via IP not hostname | Use `charging-master.local` or add your phone's IP to `UPDATE_ALLOWED_HOSTS` |

## Other automations

The same endpoint works from any LAN-reachable client:

- **macOS Shortcuts** — identical to iOS (Shortcuts.app on Sonoma+).
- **Home Assistant** — `rest_command:` action with the same URL/body.
- **curl smoke-test** —
  `curl -X POST -H 'Content-Type: application/json' -d '{"soc":42}' http://charging-master.local/api/devices/shellyplugsg3-d885ac15b828/report-soc`
- **Android** — Tasker → HTTP Request action, same shape.
