'use client';

/**
 * v1.7-A++ : 1-Tap iOS Shortcut installer button.
 *
 * Click handler navigates to /api/devices/<id>/shortcut-install, which
 * UA-sniffs and either:
 *   • iOS: redirects to shortcuts://import-shortcut?url=... (opens
 *     Shortcuts.app's import dialog)
 *   • Anywhere else: downloads the .shortcut XML file (for AirDrop,
 *     curl-inspection, debugging)
 *
 * The collapsible <details> below the button surfaces the iOS-side
 * prerequisites so the user doesn't have to find docs/ios-shortcut-setup.md.
 */

type Props = {
  plugId: string;
};

export function IosShortcutButton({ plugId }: Props) {
  const href = `/api/devices/${encodeURIComponent(plugId)}/shortcut-install`;
  return (
    <div className="flex flex-col gap-1 mt-2 pl-5">
      <a
        href={href}
        className="inline-flex items-center gap-1.5 self-start px-2.5 py-1 rounded-md text-[11px] bg-neutral-800 border border-neutral-700 text-neutral-200 hover:bg-neutral-700 hover:border-neutral-600 transition-colors"
      >
        <span aria-hidden="true">📱</span>
        iOS Shortcut installieren
      </a>
      <details className="text-[10px] text-neutral-500">
        <summary className="cursor-pointer hover:text-neutral-400 select-none">
          Voraussetzungen anzeigen
        </summary>
        <ol className="list-decimal list-inside mt-1 space-y-0.5 text-neutral-400">
          <li>
            Diese Seite auf dem iPhone/iPad öffnen (gleiches WiFi-Netz wie der
            charging-master Server).
          </li>
          <li>
            iOS: <span className="text-neutral-300">Einstellungen → Kurzbefehle →
            „Nicht vertrauenswürdige Kurzbefehle erlauben"</span> aktivieren.
            <span className="block text-neutral-500">
              (Diese Option erscheint erst, nachdem du mindestens einen Kurzbefehl
              ausgeführt hast — notfalls einen beliebigen Standard-Shortcut einmal
              starten und zurück.)
            </span>
          </li>
          <li>
            Auf „iOS Shortcut installieren" tippen → Shortcuts.app öffnet den
            Import-Dialog → „Nicht vertrauenswürdigen Kurzbefehl hinzufügen" bestätigen.
          </li>
          <li>
            <span className="text-neutral-300">Optional:</span> Shortcuts.app
            → Automation → „+" → „Wenn Ladegerät verbunden ist" → den eben
            installierten Charging-Master-Shortcut ausführen lassen → Häkchen
            bei „Vor dem Ausführen fragen" entfernen. Ab dann meldet das
            iPad bei jedem Einstecken seinen aktuellen Akkustand.
          </li>
        </ol>
      </details>
    </div>
  );
}
