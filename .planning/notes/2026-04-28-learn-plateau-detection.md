---
date: "2026-04-28 16:05"
promoted: false
---

Lern-Auto-Complete robuster machen: aktueller Trigger ist `apower < 2W für 60s` (IDLE_THRESHOLD=2, LEARN_IDLE_READINGS=12 in charge-state-machine.ts). Das schlägt fehl bei Chargers mit dauerhaftem Standby-Bias >2W (Dock-Elektronik, Wechselrichter-Idle, Fan-Charger usw.). Heute beim Winbot W3 nur durch Glück geendet — Charger plateauite bei ~7W und ging dann tatsächlich auf 0W.

Robuste Lösung: Plateau-Erkennung statt absoluter Threshold. Vorschlag:
- Slidings Window letzte N Min (~5min) tracken
- Trigger wenn: max(window) - min(window) < 1W UND avg(window) < 10% von session-max-Power
- ODER zusätzlich: keine signifikante Wh-Akkumulation in letzten 10 min
- Fallback-Hard-Stop: wenn 6h Lernzeit überschritten, force learn_complete

Bonus: Profile-spezifischer Override-Threshold (manche Geräte haben spezielle Profile). Default = neue Plateau-Logik.

Wunsch von chrissi 2026-04-28.
