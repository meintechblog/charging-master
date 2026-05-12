# Profile-Katalog

Geteiltes Wissen über Akku-Ladekurven und Ladegeräte zwischen allen
Charging-Master-Instanzen. Wer den Schalter `catalog.enabled` in seinen
Einstellungen aktiviert, sieht unter `/catalog` alle eingepflegten Profile,
kann sie in seine lokale Sammlung übernehmen und kriegt während des
Anlernens Vorschläge wenn die eigene Kurve einem Katalog-Eintrag stark
ähnelt.

## Layout

- `INDEX.json` — Schneller Lookup. Wird beim Self-Update geladen + bei
  jedem Submit serverseitig regeneriert.
- `profiles/<id>.json` — Akku-Profil-Metadaten + SOC-Boundaries + Curve-
  Summary (Punktzahl, Energie, Peak, sha256 der Curve).
- `profiles/<id>.curve.csv` — Referenz-Ladekurve (`offset_seconds, apower`).
- `profiles/<id>.photo.jpg` — Primary-Photo, sharp-downscaled auf 800px
  längste Kante / JPEG q=80 / typisch 60-200 KB.
- `chargers/<id>.json` — Ladegeräte-Metadaten.
- `chargers/<id>.photo.jpg` — analog.

## IDs (deterministisch)

- **Profile-ID** = erste 16 hex chars von `sha256` über die normalisierte
  Curve (Points nach offset sortiert, apower auf 2 Stellen gerundet, als
  JSON-Array). Zwei identische Curves bekommen identische IDs → automatische
  Deduplizierung über Instanzen hinweg.
- **Charger-ID** = analog über `manufacturer|model|maxVoltage|maxCurrent|outputType|efficiency`.

## Quality-Gates beim Einreichen

Validiert serverseitig vor dem Commit, nichts läuft durch ohne Check:

- max 20.000 Curve-Points, max 24h Dauer, max 1 MB CSV pro Curve
- Felder mit Längenlimit: name 100, manufacturer/model 60, notes 500
- **Ein primäres Foto pro Eintrag.** Wird automatisch via `sharp` auf
  800px längste Kante / JPEG q=80 / EXIF-rotated heruntergerechnet.
  Output typisch 60-200 KB.
- **URLs:** `product_url` und `document_url` nur wenn `http(s)://...` und
  max 500 chars. Alles andere stripped.
- **NICHT** im Katalog: `description`, Kaufdatum, Preis-Historie,
  Seriennummer, Garantie-Daten, lokale DB-IDs, `created_at/updated_at`.
- Curve darf nicht konstant oder all-zero sein.

Failures mit severity `error` → 422, Submit blockiert. severity `warning`
→ wird angezeigt, Submit läuft trotzdem durch.

## Beitragen — zwei Wege

### Auto-Publish (ein Klick)

1. Einmalig in den Einstellungen ein GitHub Personal Access Token mit
   `contents:write`-Scope auf dieses Repo unter „Profil-Katalog" eintragen.
2. Auf `/profiles/<id>` → „Zum Katalog beitragen" → „Auto-Publish".
3. App validiert, downscaled das Foto, regeneriert `INDEX.json` und
   commitet alle Artefakte in EINEM atomischen Commit via die GitHub
   Git Data API (blobs → tree → commit → ref update).
4. Beim nächsten Self-Update sehen alle anderen Instanzen den Eintrag.

### Manuell (PR-Workflow)

1. Auf `/profiles/<id>` → „Zum Katalog beitragen" → „Manuell".
2. Heruntergeladene Dateien ins Repo legen (Pfade stehen im Modal).
3. Lokal `node scripts/catalog/rebuild-index.mjs` (oder ein PR-Bot)
   regeneriert `INDEX.json`. Alternativ: nächster Auto-Publish baut den
   Index frisch.
4. Pushen.
