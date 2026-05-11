---
date: "2026-04-28 13:55"
promoted: false
---

Deployment-Lücke entdeckt: /opt/charging-master/scripts/ existierte heute NICHT auf der LXC, obwohl im Repo vorhanden. Erster `pnpm build`-Versuch crashte mit "Cannot find module '/opt/charging-master/scripts/build/generate-version.mjs'". Workaround heute: scp -r scripts root@charging-master.local:/opt/charging-master/

Vermutung: Self-Update-Workflow (charging-master-updater.service) syncs nur src/, package.json, server.ts, etc. — aber nicht scripts/. Das war ungefährlich solange Dev-Mode lief (kein Build), aber bricht jeden Production-Build der `gen:version` aufruft.

To-do: Update-Script (scripts/update/run-update.sh) anschauen und scripts/ in den Sync-Pfad aufnehmen. Sonst überlebt der nächste Self-Update den Production-Build nicht.

Wunsch von chrissi 2026-04-28 (Diagnose im Rahmen Memory-Leak-Fix).
