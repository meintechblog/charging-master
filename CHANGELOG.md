# Changelog

Alle nennenswerten Änderungen an Charging-Master. Format orientiert sich an
[Keep a Changelog](https://keepachangelog.com/de/1.1.0/), Versionierung folgt
[Semantic Versioning](https://semver.org/lang/de/).

> **Hinweis zur Historie:** Die Versionen 1.0.0–1.9.2 wurden am 2026-05-31 rückwirkend
> aus der Milestone-/Commit-History rekonstruiert (das Projekt nutzte zuvor `v1.x`-Scopes
> in Commit-Messages statt Git-Tags). Ab 1.9.2 wird semver konsequent gepflegt:
> Commit-Prefix steuert den Bump (`fix:`/`perf:` → PATCH, `feat:` → MINOR, breaking → MAJOR).

## [1.9.2] - 2026-05-31
### Fixed
- Hängende `detecting`-Sessions werden bei Strom-Wegfall nach `idle` recycelt:
  `ChargeStateMachine.handleDetecting` spiegelt jetzt `handleIdle`/`handleLearning`
  (Transition zurück nach `idle` nach anhaltend sub-`IDLE_THRESHOLD` Readings,
  `idleCount`-Reset beim Eintritt). Beseitigt die letzte Re-emit-Quelle hinter dem
  Pushover-"Metronom" — ein Gerät, das kurz Strom zog und dann auf ~0 W fiel, blieb
  sonst für immer als orphaned `detecting`-Zombie stehen. `resumeActiveSessions`-Sweep
  als Restart-Backstop. (d709cb5, e46df39, 6197fc0)

## [1.9.1] - 2026-05-27
### Fixed
- Pushover-Benachrichtigungs-"Metronom" bei anhaltendem `detecting`-State gestoppt:
  Dedup-Gate von Zeitfenster (60 s) auf reinen State-Wechsel umgestellt
  (`if (lastState === event.state) return;`). Eine hängende Session erzeugte zuvor
  ~960 Pushes in 16 h. (aab9eee)

## [1.9.0] - 2026-05-22
### Added
- **Catalog Auto-Sync v2** (Phase 14): GitHub-App-Auth (RS256-JWT + Installation-Token-Cache)
  ersetzt den geparkten PAT-Ansatz; PR-basierter Publish-Flow statt Direkt-Push;
  CI-Workflow-Templates für das Katalog-Repo; `disabledReason`/`lastPr` in
  `/api/catalog/sync-status`; Migration 0014 (`catalog_sync_log.pr_url`). (96ebb16 … 6fa7559)

## [1.8.0] - 2026-05-20
### Added
- Catalog Auto-Sync (v1) mit Debounce + Opt-out-Toggle. (700e6eb)

## [1.7.0] - 2026-05-16
### Added
- iOS-Shortcut-SoC-Hook (`/api/devices/[id]/report-soc`) für echte Start-SoC-Meldung
  inkl. 1-Tap-Installer pro Plug.
- Plug-in-Transient-Capture + feature-basierter Confidence-Boost im Bayesian-Prior.
- Post-Cycle-Self-Calibration (delivered-Wh vs. Profil) mit Dashboard-Flag-Banner.
- Live-Kurve auf Referenz-Timeline ausgerichtet, smarte X-Ticks. (1df2c5b … 76a19c8)
### Fixed
- `curveOffsetSeconds` nur beim ersten User-Anchor pro Session neu berechnen;
  `refreshMatch`-Guard-Hole geschlossen; user-anchored `socBest` über FPD-02 erhalten.

## [1.6.0] - 2026-05-16
### Added
- Multi-Profil-Whitelist + Bayesian-Prior + Energy-Bound-Matching + Active-Learning-Prompt. (3388f37)

## [1.5.0] - 2026-05-16
### Added
- Plug-Pinning (`plugs.pinned_profile_id`) + DTW-Margin-Gate (×1.05) + taper-aware SoC. (2b6c05b)

## [1.4.0] - 2026-05-15
### Added
- Flat-Power-Defense + Pipeline-Hardening (Phase 13, PIPE-01..04): Stale-Power-Watchdog,
  Warm-up-Gate, Stop-Gap-Härtung. (15e8cc2)

## [1.3.0] - 2026-05-15
### Added
- SOC-Intelligence: Bandbasierte SoC-Schätzung mit Confidence-Schwellen. (d4242b3)

## [1.2.0] - 2026-05 (rekonstruiert)
### Added
- Self-Update: In-App-Update-Trigger via systemd-Sibling-Unit mit 2-Stufen-Rollback
  und 9-Stage-Pipeline (`preflight → … → verify`).

## [1.0.0] - 2026-04 (rekonstruiert)
### Added
- Erste lauffähige Version: Shelly-HTTP-Polling, Charge-State-Machine, Curve-Matcher (DTW),
  Session-Recorder, Pushover-Notifications, ECharts-Live-Dashboard, SQLite/Drizzle-Persistenz.
