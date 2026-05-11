# Profile-Katalog

Geteiltes Wissen über Akku-Ladekurven und Ladegeräte zwischen allen
Charging-Master-Instanzen. Wer den Schalter `catalog.enabled` in seinen
Einstellungen aktiviert, sieht hier alle eingepflegten Profile, kann sie in
seine lokale Sammlung übernehmen und kriegt während des Anlernens
Vorschläge wenn die eigene Kurve einem Katalog-Eintrag stark ähnelt.

## Layout

- `INDEX.json` — Schneller Lookup. Wird beim Self-Update geladen.
- `profiles/<id>.json` — Akku-Profil-Metadaten + SOC-Boundaries.
- `profiles/<id>.curve.csv` — Referenz-Ladekurve (`offset_seconds, apower`).
- `chargers/<id>.json` — Ladegeräte-Metadaten.

## IDs

- **Profile-ID** = erste 16 hex chars von `sha256` über die normalisierte
  Curve (Points nach offset sortiert, apower auf 2 Stellen gerundet, als
  JSON-Array). Zwei identische Curves bekommen identische IDs → automatische
  Deduplizierung.
- **Charger-ID** = `sha256` über `manufacturer|model|maxVoltage|maxCurrent|outputType|efficiency`.

## Quality-Gates beim Einreichen

- max 20.000 Curve-Points, max 24h Dauer, max 1 MB CSV pro Curve
- Felder mit Längenlimit: name 100, manufacturer/model 60, notes 500
- **Ein primäres Foto pro Eintrag** (Profil + Ladegerät getrennt), max 800px
  längste Kante, JPEG quality 80, max 300 KB. Mehrere Fotos pro Profil
  bleiben lokal — nur das primary photo wird geteilt.
- **URLs:** `product_url` und `document_url` werden mitgeteilt wenn
  `http(s)://...` und max 500 chars. Alles andere stripped.
- **NICHT** im Katalog: `description`, Kaufdatum, Preis-Historie,
  Seriennummer, Garantie-Daten, lokale DB-IDs, `created_at/updated_at`.
- Curve darf nicht konstant oder all-zero sein.

## Beitragen (Phase 1: manuell)

In der App auf `/profiles/<id>` → "Zum Katalog beitragen" → JSON+CSV
herunterladen → in dieses Repo einchecken (PR oder direkt auf main). Beim
nächsten Self-Update sehen alle anderen Instanzen den neuen Eintrag.
