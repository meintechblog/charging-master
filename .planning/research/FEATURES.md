# Feature Landscape

**Domain:** IoT Smart Charging Management
**Researched:** 2026-03-25

## Table Stakes

Features the app must have to deliver core value. Missing = product is broken.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Shelly Plug discovery/config | Can't do anything without connecting to plugs | Low | Manual add by MQTT topic prefix, auto-detect via online topic |
| Live power display | User needs visual confirmation device is working | Medium | SSE + ECharts, the "wow" moment |
| Relay on/off control | Manual override is always needed | Low | MQTT publish to command topic |
| Reference curve recording | Core of device learning -- must record a full charge cycle | Medium | Record mode: store all readings, mark start/end |
| Device profile management | Users need to name and configure their chargers | Low | CRUD for profiles with target SOC |
| Automatic device detection | Core value -- identify what is plugged in | High | DTW curve matching, the hardest feature |
| SOC estimation | Users need to know "how full is my battery" | High | Derived from curve position, requires good reference data |
| Auto-stop at target SOC | The primary value proposition -- stop charging at 80% | Medium | Relay off command when estimated SOC reaches target |
| Charge session tracking | Know when a charge started, what device, how it ended | Medium | State machine with DB persistence |

## Differentiators

Features that make this app genuinely useful vs. just a power monitor.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Partial charge detection | Plug in at 40% and app knows where on the curve you are | High | Subsequence DTW, the key innovation |
| Reference curve overlay | See current charge vs. reference on same chart | Low | ECharts overlay once data exists |
| Pushover notifications | Know when charging starts/stops without checking the app | Low | Simple HTTP API, but very useful |
| Multi-plug dashboard | See all plugs and active charges at a glance | Medium | Multiple SSE streams, layout work |
| Charge history with stats | Track energy usage, charge patterns over time | Medium | Aggregation queries, chart views |
| Manual profile override | Correct wrong auto-detection without stopping the charge | Low | UI to reassign profile mid-session |

## Anti-Features

Features to explicitly NOT build.

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| Cloud sync / remote access | Out of scope, local-only app, security risk | Keep it LAN-only, access via local URL |
| Multi-user auth | Single-user app, adds complexity for zero users | No login, no sessions |
| Automatic Shelly firmware updates | Risky, could break MQTT integration | Document recommended firmware version |
| ML-based SOC prediction | Overengineered for v1, needs training data that does not exist yet | Simple curve position mapping works for known devices |
| Calendar/scheduling | "Charge between 2-6am" is not the core value | May be v2 if user wants it |
| Energy cost tracking | Nice-to-have but not core value, needs tariff data | Defer to v2, just track Wh for now |
| Support for non-Shelly plugs | Fragments the MQTT integration | v1 is Shelly-only, abstract the plug interface for future extension |

## Feature Dependencies

```
Shelly Plug Config --> Live Power Display --> Reference Curve Recording
                                                      |
                                                      v
                                          Device Profile Management
                                                      |
                                                      v
                                          Curve Matching (DTW)
                                                      |
                                                      v
                                          SOC Estimation
                                                      |
                                                      v
                                          Auto-Stop Logic
                                                      |
                                                      +---> Pushover Notifications
                                                      |
                                                      +---> Charge History
```

## MVP Recommendation

**Phase 1-2 MVP (usable without intelligence):**
1. Shelly Plug config + MQTT connection
2. Live power chart (real-time)
3. Manual relay control

**Phase 3 MVP (core value):**
1. Reference curve recording (learn mode)
2. Device profile + target SOC
3. Auto-detection + auto-stop

**Defer:**
- Charge history: useful but not blocking for core value
- Multi-plug dashboard: works with 1 plug first, generalize later
- Pushover: nice-to-have, add after core flow works

## Sources

- [PROJECT.md requirements](../PROJECT.md) -- direct requirements from stakeholder
- [Shelly Switch API](https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Switch/) -- capabilities and constraints
