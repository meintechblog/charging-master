---
date: "2026-04-28 13:32"
promoted: false
---

Profil-Schema erweitern: Akku-Label liefert deutlich mehr strukturierte Daten als wir aktuell speichern können. Heutiges Schema (device_profiles): name, description, model_name, purchase_date, estimated_cycles, target_soc, product_url, document_url, manufacturer, article_number, gtin, capacity_wh, weight_grams, price_eur, price_updated_at.

Konkretes Beispiel Winbot W3 (Profil 5) — diese Infos haben wir aus dem Label extrahiert, aber großteils nur in description verstaut weil keine eigenen Felder existieren:

Fehlende strukturierte Felder:
- chemistry / cell_type (z.B. "Li-ion", "LiFePO4", "NiMH") — relevant für Ladekurven-Charakteristik
- cell_designation (z.B. "INR19/66" — IEC-Bezeichnung der Einzelzelle)
- cell_configuration (z.B. "6S2P" — Serien/Parallel-Anordnung) → daraus Pack-Spannung & -Kapazität ableitbar
- nominal_voltage_v (z.B. 21.9) — heute fehlt; nur capacity_wh ist da, aber V/Ah einzeln sind oft auf Label
- nominal_capacity_mah (z.B. 4500) — heute fehlt
- max_charge_current_a / max_charge_voltage_v — Ladespec, kritisch für Sicherheit
- charge_temp_min_c / charge_temp_max_c (z.B. 0 / 40) — Lade-Temperaturbereich vom Label
- discharge_temp_min_c / discharge_temp_max_c
- serial_number (z.B. "A0042225160000") — vs article_number (das ist eher SKU/Modell-Variante)
- production_date (z.B. "2025-12") — wichtig für Zyklenschätzung & Garantie
- country_of_origin
- certifications (Liste/JSON: ["UL 62133-2", "CSA C22.2 No.62133-2", "CE", "EAC", "ETL", "PSE"])
- charger_model — verknüpft mit der oben beantragten Charger-Entity (AC/DC-Wirkungsgrad)
- battery_form_factor (z.B. "pack", "single-cell", "removable")
- replaceable (boolean) — Akku tauschbar? relevant für Lebensdauer-Strategie
- end_of_life_capacity_pct (typisch 80%) — wann gilt Akku als verbraucht
- warranty_until / warranty_cycles
- notes (freier Text, separat von description die für Beschreibung gedacht ist)

UI-Implikation: Profil-Detail-Seite braucht gruppiertes Layout — "Identität / Elektrische Daten / Lade-Spec / Sicherheit / Lifecycle / Wirtschaftlich". Vermutlich Accordion oder Tabs sonst zu lang.

Migration: drizzle-kit generate, alle Felder optional (vorhandene Profile bleiben gültig). Ggf. JSON-Spalte "extra" als Escape-Hatch für seltene Felder, statt das Schema bei jedem neuen Akku-Typ zu erweitern.

OCR/Auto-Fill: Wenn wir später Photo-Upload haben (separate Note), könnten wir aus dem Label-Foto via OCR/Vision-Model die Felder vorausfüllen — User muss nur bestätigen. Das wäre richtig cool.

Wunsch von chrissi 2026-04-28.
