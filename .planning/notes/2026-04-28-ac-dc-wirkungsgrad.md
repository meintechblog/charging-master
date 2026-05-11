---
date: "2026-04-28 13:30"
promoted: false
---

AC/DC-Wirkungsgrad bei Energieerfassung. Shelly Plug misst AC-seitig (Eingang Ladegerät), aber relevant ist die DC-Energie, die real im Akku ankommt. Ladegerät-Verluste (~15-25% typisch bei kleinen AC-Ladern) verfälschen cumulativeWh / Wh-pro-SOC heute. Lösungsideen evaluieren:
1. Pro-Profil hinterlegter Wirkungsgrad-Faktor (manuell, simpel, sofort umsetzbar) — z.B. profile.charger_efficiency = 0.85
2. Pro-Ladegerät-Profil (separates Entity, mehrere Profile teilen Charger) — sauberer wenn mehrere Akkus mit demselben Charger laufen
3. Auto-Kalibrierung: User trägt einmal die nominale Akku-Wh ein (z.B. 98.55 Wh für Winbot), App rechnet Wirkungsgrad rückwärts aus full-charge AC-Wh = battery_wh / efficiency
4. Effizienzkurve über Power-Range (Charger-Wirkungsgrad ist nicht konstant — schlechter bei niedriger Last)

Display: anzeigen sowohl AC-gemessene Wh als auch DC-geschätzte Wh. SOC-Berechnung sollte DC-basiert sein.

Wunsch von chrissi 2026-04-28. Am Ende des Tages will der User wissen "wieviel Wh real im Akku sind", nicht nur was an der Steckdose floss.
