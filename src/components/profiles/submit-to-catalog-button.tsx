'use client';

import { useState } from 'react';

type Props = {
  profileId: number;
  hasCurve: boolean;
};

type Issue = { field: string; message: string; severity: 'error' | 'warning' };
type Artifact = { path: string; contentType: string; contentBase64: string };

type ManualResponse = {
  ok: true;
  mode: 'manual';
  profileCatalogId: string;
  chargerCatalogId: string | null;
  issues: Issue[];
  artifacts: Artifact[];
};

type AutoResponse = {
  ok: boolean;
  mode: 'auto';
  profileCatalogId: string;
  chargerCatalogId: string | null;
  issues: Issue[];
  commitSha: string | null;
  filesCommitted: string[];
  error?: string;
};

type ValidationFailedResponse = {
  ok: false;
  profileCatalogId: string;
  chargerCatalogId: string | null;
  issues: Issue[];
};

type AnyResponse = ManualResponse | AutoResponse | ValidationFailedResponse;

function downloadArtifact(a: Artifact) {
  const bin = atob(a.contentBase64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const blob = new Blob([bytes], { type: a.contentType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = a.path.split('/').pop() ?? 'artifact';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function SubmitToCatalogButton({ profileId, hasCurve }: Props) {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<AnyResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!hasCurve) return null;

  async function handleSubmit(mode: 'auto' | 'manual') {
    setSubmitting(true);
    setResult(null);
    setError(null);
    try {
      const res = await fetch('/api/catalog/submit-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId, mode }),
      });
      const data = (await res.json()) as AnyResponse;
      setResult(data);
      if (!res.ok && res.status !== 422) {
        setError(`HTTP ${res.status}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Netzwerkfehler');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="px-3 py-1.5 text-sm rounded bg-amber-600/20 text-amber-300 hover:bg-amber-600/30 transition-colors"
      >
        Zum Katalog beitragen
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="bg-neutral-900 border border-neutral-800 rounded-lg max-w-2xl w-full max-h-[85vh] overflow-y-auto p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between mb-4">
              <div>
                <h2 className="text-lg font-semibold text-neutral-100">Zum Katalog beitragen</h2>
                <p className="text-xs text-neutral-400 mt-1">
                  Das Profil wird mit Curve, SOC-Boundaries und (falls vorhanden) verknüpftem
                  Ladegerät + Primärfoto zur geteilten Sammlung im Charging-Master Repo hinzugefügt.
                </p>
              </div>
              <button
                onClick={() => setOpen(false)}
                className="text-neutral-500 hover:text-neutral-300 text-xl leading-none"
                aria-label="Schließen"
              >
                ×
              </button>
            </div>

            {!result && !submitting && (
              <div className="space-y-3">
                <div className="rounded-md bg-neutral-950 border border-neutral-800 p-3 text-[12px] text-neutral-400 leading-relaxed">
                  <strong className="text-neutral-300">Auto-Publish</strong> commitet die Artefakte direkt
                  ins GitHub-Repo (benötigt PAT in den Einstellungen).
                  <br />
                  <strong className="text-neutral-300">Manuell</strong> lädt die Dateien als Download und
                  zeigt dir wohin sie im Repo gehören — für PR-Workflow.
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => handleSubmit('auto')}
                    className="flex-1 px-4 py-2 text-sm rounded bg-amber-600 hover:bg-amber-500 text-white"
                  >
                    Auto-Publish
                  </button>
                  <button
                    onClick={() => handleSubmit('manual')}
                    className="flex-1 px-4 py-2 text-sm rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-200"
                  >
                    Manuell (Artefakte herunterladen)
                  </button>
                </div>
              </div>
            )}

            {submitting && (
              <div className="text-sm text-neutral-400 py-6 text-center">Validiere + sende…</div>
            )}

            {error && (
              <div className="text-sm text-red-400 mb-3">Fehler: {error}</div>
            )}

            {result && (
              <div className="space-y-3">
                {result.ok === false && (
                  <div className="rounded-md bg-red-950/40 border border-red-900 p-3 text-sm text-red-300">
                    Validation fehlgeschlagen — bitte beheben:
                  </div>
                )}

                {result.issues.length > 0 && (
                  <div>
                    <h3 className="text-xs font-semibold text-neutral-300 mb-2">Issues</h3>
                    <ul className="space-y-1 text-xs">
                      {result.issues.map((iss, i) => (
                        <li
                          key={i}
                          className={
                            iss.severity === 'error'
                              ? 'text-red-300'
                              : 'text-amber-300'
                          }
                        >
                          [{iss.severity}] {iss.field}: {iss.message}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {result.ok && 'mode' in result && result.mode === 'auto' && (
                  <div className="rounded-md bg-green-950/40 border border-green-900 p-3 text-sm text-green-200">
                    ✓ Committed: <code className="text-green-300">{result.commitSha?.slice(0, 7)}</code>
                    <ul className="mt-2 list-disc list-inside text-xs space-y-0.5">
                      {result.filesCommitted.map((p) => (
                        <li key={p} className="text-green-300/80">{p}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {result.ok && 'mode' in result && result.mode === 'auto' && !result.ok && (
                  <div className="rounded-md bg-red-950/40 border border-red-900 p-3 text-sm text-red-300">
                    GitHub commit fehlgeschlagen: {result.error ?? 'Unbekannter Fehler'}
                  </div>
                )}

                {result.ok && 'mode' in result && result.mode === 'manual' && (
                  <div>
                    <h3 className="text-xs font-semibold text-neutral-300 mb-2">Artefakte zum Download</h3>
                    <div className="space-y-1">
                      {result.artifacts.map((a) => (
                        <div
                          key={a.path}
                          className="flex items-center justify-between bg-neutral-950 border border-neutral-800 rounded px-3 py-2 text-xs"
                        >
                          <span className="font-mono text-neutral-300 truncate">{a.path}</span>
                          <button
                            onClick={() => downloadArtifact(a)}
                            className="ml-3 px-2 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white text-[11px] whitespace-nowrap"
                          >
                            Download
                          </button>
                        </div>
                      ))}
                    </div>
                    <p className="text-[11px] text-neutral-500 mt-3">
                      Diese Dateien in den entsprechenden Pfaden im Repo einchecken, dann pushen.
                      INDEX.json wird beim nächsten Auto-Publish automatisch regeneriert (oder
                      manuell durch Re-Generation aus den .json-Dateien).
                    </p>
                  </div>
                )}

                <button
                  onClick={() => setOpen(false)}
                  className="w-full px-4 py-2 text-sm rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-200"
                >
                  Schließen
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
