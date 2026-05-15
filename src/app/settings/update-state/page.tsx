// src/app/settings/update-state/page.tsx
//
// Admin page for reviewing + clearing the most recent preflight quarantine.
//
// Server component (no 'use client'). Reads state.json via UpdateStateStore and
// enumerates the on-disk quarantine directory referenced by
// state.lastQuarantine.path. Delegates rendering + the DELETE call to the
// QuarantineList client child component.
//
// Per CONTEXT.md §Design Decision 5 + RESEARCH Open Q6, this page has NO nav
// entry — it is reachable only via (a) the yellow banner's "Details ansehen"
// deep-link or (b) typing the URL directly. LAN-only deployment is the auth
// model; the DELETE endpoint enforces isAllowedBrowserHost on its side.
//
// Per RESEARCH Open Q8 lock, files are listed with paths RELATIVE to the
// quarantine dir root (the bash updater preserves directory structure when
// it moves files; the page mirrors that structure back).

import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { UpdateStateStore } from '@/modules/self-update/update-state-store';
import type { UpdateState } from '@/modules/self-update/types';
import { QuarantineList } from './quarantine-list';

export const dynamic = 'force-dynamic';

async function loadFiles(absDir: string): Promise<string[]> {
  if (!existsSync(absDir)) return [];
  try {
    const entries = await readdir(absDir, { recursive: true, withFileTypes: true });
    return entries
      .filter((e) => e.isFile())
      .map((e) => {
        // node:fs Dirent exposes the parent directory as `path` when readdir is
        // called with recursive:true (Node 20.12+; Node 22 on the LXC supports
        // this reliably). The `?? absDir` fallback degrades to basename-only on
        // older runtimes rather than crashing the page.
        const parent = (e as unknown as { path: string }).path ?? absDir;
        return (parent === absDir ? '' : parent.slice(absDir.length + 1) + '/') + e.name;
      })
      .sort();
  } catch {
    return [];
  }
}

export default async function UpdateStatePage() {
  let state: UpdateState | null = null;
  try {
    state = new UpdateStateStore().read();
  } catch {
    state = null;
  }
  const quarantine = state?.lastQuarantine ?? null;
  const files = quarantine !== null && quarantine !== undefined ? await loadFiles(quarantine.path) : [];

  return (
    <div className="max-w-2xl mx-auto py-8 px-4 space-y-6">
      <h1 className="text-2xl font-bold text-neutral-100">Update-State / Quarantäne</h1>
      <QuarantineList quarantine={quarantine ?? null} files={files} />
    </div>
  );
}
