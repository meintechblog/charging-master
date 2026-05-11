---
date: "2026-04-29 08:30"
promoted: false
---

Updater-Telemetrie-Bug entdeckt beim Friend-LXC update (192.168.2.117, ad91779 → 46d6d9c). Self-Updater hat die Software erfolgreich aktualisiert (alle Routes 200, neuer SHA), ABER die update_runs DB-Row hängt mit status='running', stage='preflight', endAt=null. Heißt: db_update_stage() / db_finish_run() in scripts/update/run-update.sh schreiben in die DB, aber die Writes landen nicht.

Vermutung: Race-Condition zwischen sqlite3-CLI (vom bash-Script) und better-sqlite3-Connection (von der App). Der Service ist während stop+build+start unten, dann kommt er hoch und re-acquired die DB. Möglicherweise:
- a) die sqlite3-Writes des Updaters passieren während die DB im checkpointing-Mode ist
- b) die WAL-Datei wird beim do_drain checkpointed, dann schreibt sqlite3 in die WAL, dann startet der Service neu und sieht die WAL nicht
- c) das STATE_FILE und DB_FILE sind nicht in Sync — vielleicht schreibt der Updater in eine andere DB-Datei?

Reproduzierbar: nochmal updaten und beobachten ob db_update_stage/db_finish_run-Logs in journalctl auftauchen aber Daten verloren gehen.

Workaround: tatsächlicher Update funktioniert (api/version returnt korrekt nach Update), nur das Audit-Log fehlt → man sieht im UI keine Update-Historie.

Wunsch: Bug-fix für Tracking, sonst kann man nicht zurückverfolgen ob/wann Updates gelaufen sind.
