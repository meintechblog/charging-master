# CHARGE-TEST.md — Live Charge-Test Runbook

> **Trigger:** When the user says "teste jetzt was wir besprochen haben" (or
> equivalent — "starten wir den Ladevorgang", "der Akku ist drin", etc.),
> read this file and follow the runbook below. Bootstrap state was prepared
> on 2026-05-10 in commits a6a9259 → 3ed9358 → 94d83bd → c216031.
>
> **After the test ends successfully:** delete this file in a `chore: remove
> charge-test runbook after successful test` commit. The CLAUDE.md trigger
> section can stay as a generic pointer.

## What this is

End-to-end live verification that the charging-master automation works:
plug detects the connected battery against its learned reference curve,
runs the session, and auto-stops when the configured target SOC is hit.

## Setup state (snapshot at handoff)

| | |
|---|---|
| LXC | **192.168.2.117** (Proxmox CT 100 on host `192.168.2.2`) |
| Code SHA | `c216031` (head of `main` at handoff) |
| Profile under test | id=1 "Sanorum V17MAX (VC-D2503) Akku-Stielsauger" |
| Reference curve | 3 289 points, **85.478 Wh**, 16 734 sec (~4h 39min) |
| **80% target SOC** | **= 68.39 Wh cumulative** (curve offsetSeconds 13 398) |
| Linked charger | id=1 "JinJin JJ018W1-350050VX V1" (35 V / 0.5 A DC, eff 0.85) |
| Plug | `shellyplugsg3-907069430a54` on **192.168.2.187**, 5s polling, idle |
| DB backups on box | 4 in `/opt/charging-master/data/` (082253, 084614, 085225, 090110) |

## Access (no direct SSH to LXC)

The LXC's SSH key isn't deployed for direct access. Everything goes through
the Proxmox host:

```bash
# run a command inside the container
ssh root@192.168.2.2 "pct exec 100 -- <command>"

# tail the app journal live
ssh root@192.168.2.2 "pct exec 100 -- journalctl -u charging-master.service -f"
```

HTTP endpoints reachable from anywhere with route to 192.168.2.0/24:
```bash
curl http://192.168.2.117/api/version          # sanity check
curl http://192.168.2.117/api/profiles/1       # profile + curve metadata
curl http://192.168.2.117/api/sse/power -N     # streams every reading
curl http://192.168.2.117/api/sse/charge -N    # streams state-machine events
```

If the test machine has no route to 192.168.2.x, fall back to running
all curls inside the container via `pct exec 100 -- curl http://localhost/...`.

## Runbook

### Step 1 — Pre-flight (before user plugs in)

Confirm everything is in the expected state. Run these in parallel:

```bash
# version + db
curl -fsS http://192.168.2.117/api/version
# expect: {"sha":"c216031...", "dbHealthy":true, ...}

# profile + curve
curl -fsS http://192.168.2.117/api/profiles/1 | jq '{name, targetSoc, hasCurve, curve:{durationSeconds, totalEnergyWh, pointCount}, chargerId}'
# expect: hasCurve=true, totalEnergyWh~85.48, pointCount=3289, chargerId=1, targetSoc=80

# soc boundaries
curl -fsS http://192.168.2.117/api/profiles/1 | jq '.socBoundaries[] | select(.soc==80)'
# expect: cumulativeWh ~ 68.39, offsetSeconds ~ 13398

# plug reachable + state idle
curl -fsS "http://192.168.2.187/rpc/Switch.GetStatus?id=0" | jq '{output, apower, voltage}'
# expect: output=false, apower=0

# journal clean
ssh root@192.168.2.2 "pct exec 100 -- journalctl -u charging-master.service --since '5 minutes ago' --no-pager 2>&1 | grep -E 'Error|SqliteError|unhandled' | head -5"
# expect: empty output
```

Tell the user **"Ready — Akku einstecken"**. Then start Step 2.

### Step 2 — Live monitor (use the Monitor tool, not raw SSE)

Start a Monitor task that polls SSE-derived state at a sensible cadence
and only emits transition events (one notification per state change, not
per power reading). Required filter coverage: progress markers AND
failure markers, never silent.

```bash
# Inside Monitor tool — runs until charge completes or user aborts.
# Adjust to your environment but keep the filter design.

prev_state=""
prev_kwh=0
deadline=$(($(date +%s) + 14400))   # 4h cap; charge should be ~3h45m
while [ $(date +%s) -lt $deadline ]; do
  # Single combined snapshot per loop
  snap=$(curl -fsS -m 4 -N http://192.168.2.117/api/sse/power 2>/dev/null | head -c 4000 || true)

  # State changes
  state=$(echo "$snap" | grep -oE '"state":"[a-z_]*"' | tail -1 | cut -d'"' -f4)
  if [ -n "$state" ] && [ "$state" != "$prev_state" ]; then
    echo "STATE: $prev_state → $state"
    prev_state="$state"
  fi

  # Energy progress (every ~5 Wh delivered)
  energy=$(echo "$snap" | grep -oE '"energyChargedWh":[0-9.]*' | tail -1 | cut -d: -f2)
  if [ -n "$energy" ]; then
    energy_int=${energy%.*}
    if [ "$energy_int" -ge $((prev_kwh + 5)) ]; then
      apower=$(echo "$snap" | grep -oE '"apower":[0-9.]*' | tail -1 | cut -d: -f2)
      soc=$(echo "$snap" | grep -oE '"estimatedSoc":[0-9]*' | tail -1 | cut -d: -f2)
      echo "PROGRESS: ${energy} Wh delivered, apower=${apower} W, estimatedSoc=${soc}%"
      prev_kwh=$energy_int
    fi
  fi

  # Terminal: state=complete + relay off + DB session shows stop_reason
  if [ "$state" = "complete" ]; then
    sleep 3
    db_stop=$(ssh root@192.168.2.2 "pct exec 100 -- sqlite3 /opt/charging-master/data/charging-master.db \"SELECT id, state, stop_reason, ROUND(energy_wh,2), estimated_soc FROM charge_sessions ORDER BY id DESC LIMIT 1;\"" 2>/dev/null)
    plug_off=$(curl -fsS "http://192.168.2.187/rpc/Switch.GetStatus?id=0" | grep -oE '"output":(true|false)')
    echo "COMPLETE: db=$db_stop plug=$plug_off"
    break
  fi

  # Failure signals
  if echo "$snap" | grep -qE 'detectionExhausted":true|"state":"error"|"state":"aborted"'; then
    echo "ALERT: failure signal in stream — $(echo $snap | tail -c 400)"
    break
  fi

  sleep 8
done
```

Notify the user on each STATE / PROGRESS / COMPLETE / ALERT line.

### Step 3 — Success criteria

Charge is successful if **all** are true:
1. State sequence reached `complete` (via `stopping`)
2. `charge_sessions.stop_reason = 'target_soc_reached'`
3. `charge_sessions.estimated_soc ≥ 80`
4. `charge_sessions.energy_wh` is in `60..72 Wh` range (target 68.39 ± real-world variance)
5. Plug RPC reports `output=false`
6. No SqliteError in `journalctl -u charging-master.service` since session start
7. Pushover notification fired (only if `config` table has pushover.userKey + pushover.apiToken — otherwise journal will say "pushover credentials not configured", which is OK)

If any fail → diagnose, see Step 4.

### Step 4 — Debug paths

**Stuck in `detecting` >2 min after apower stays >5 W:**
- Reference curve likely doesn't match. Compare live apower trace vs
  `reference_curve_points` for curve_id=1.
- If user says battery is the same one as the learned curve — check DTW
  threshold + buffer length in `src/modules/charging/charge-state-machine.ts`.

**Stuck in `charging` long past 80% SOC:**
- Check `charge_monitor.ts` `handleCharging` — it should compare current
  cumulative energy vs `socBoundaries.cumulative_wh` for the targetSoc.
- Verify `socBoundaries` table actually has the 80% row:
  `SELECT * FROM soc_boundaries WHERE curve_id=1 AND soc=80;`

**Relay won't switch off (output stays true):**
- Try direct: `curl "http://192.168.2.187/rpc/Switch.Set?id=0&on=false"`
- If that works but the app didn't fire it → check `relay-controller.ts`
  switching code paths.

**SqliteError appears in journal:**
- Run schema sanity: `pct exec 100 -- sqlite3 /opt/charging-master/data/charging-master.db ".schema <table>"`
- 8 migrations should be applied: `SELECT COUNT(*) FROM __drizzle_migrations;` → 9 (0000 through 0008)
- If schema actually drifted: ad-hoc apply via `pnpm exec tsx scripts/db/migrate.ts` inside the container.

**App crashed mid-session:**
- `systemctl status charging-master.service` (via pct exec)
- Restart: `pct exec 100 -- systemctl restart charging-master.service`
- The state-machine recycle fix from a6a9259 should auto-recover any
  leftover `detecting`/`charging`/`stopping` state on the next reading.

### Step 5 — Code fixes during the test

If you find a real bug, follow the deploy loop:
1. Fix the code (use `/gsd:debug` or `/gsd:quick` per the project's GSD enforcement).
2. `git push origin main`.
3. Trigger update on the box:
   ```bash
   ssh root@192.168.2.2 "pct exec 100 -- bash -c 'curl -fsS http://localhost/api/update/check; sleep 1; curl -fsS -X POST -H Content-Type:application/json -d {} http://localhost/api/update/trigger'"
   ```
4. Monitor with another Monitor task watching
   `journalctl -u charging-master-updater.service` for `[stage=*]` lines
   until you see `[stage=finalize] update SUCCESS`.
5. Resume Step 2 monitoring.

The pipeline includes `backup_db` + `migrate` stages now (since 3ed9358),
so schema changes are safe. Pre-migrate DB backups land in
`/opt/charging-master/data/charging-master.db.pre-migrate-<ts>` and the
last 3 are retained.

### Risks to respect

- **Don't smoke-test destructive endpoints.** 2026-04-21 incident: a
  Schuppen plug + 52k readings got wiped while "testing" a 409 guard.
  Rule: never POST/DELETE against ad-hoc endpoints during the test.
  Read-only inspection only.
- **`/api/charging/learn/stop` was bug-fixed in 94d83bd.** Don't worry
  about the previous upper-bound issue.

### Final report shape

Once the charge completes successfully, write:
- Total time elapsed (start → stop)
- Final energy_wh delivered
- Final estimated_soc
- Peak power observed
- Detection: how many seconds from plug-in to `matched`
- Curve-vs-reality delta (`durationSeconds` actual vs 13 398 expected)
- Whether Pushover fired (or "no pushover credentials configured" if not)

Then propose deleting this file (`CHARGE-TEST.md`) and the trigger pointer
in `CLAUDE.md`.
