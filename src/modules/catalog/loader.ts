import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import type {
  CatalogIndex,
  CatalogProfile,
  CatalogCharger,
  CurvePoint,
} from './types';

/**
 * Filesystem path to the catalog directory. Relative to process.cwd(), which
 * is the project root in dev (next dev) and prod (custom server.ts) alike.
 */
const CATALOG_DIR = path.join(process.cwd(), 'catalog');

let cachedIndex: { mtimeMs: number; data: CatalogIndex } | null = null;

function indexPath(): string {
  return path.join(CATALOG_DIR, 'INDEX.json');
}

/**
 * Read INDEX.json with mtime-based caching. Self-update rewrites the file
 * atomically (git reset replaces it), so mtime change = invalidate.
 */
export function loadIndex(): CatalogIndex | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(indexPath());
  } catch {
    return null;
  }
  if (cachedIndex && cachedIndex.mtimeMs === stat.mtimeMs) {
    return cachedIndex.data;
  }
  try {
    const raw = fs.readFileSync(indexPath(), 'utf8');
    const data = JSON.parse(raw) as CatalogIndex;
    cachedIndex = { mtimeMs: stat.mtimeMs, data };
    return data;
  } catch {
    return null;
  }
}

export function loadProfile(id: string): CatalogProfile | null {
  if (!isSafeId(id)) return null;
  const p = path.join(CATALOG_DIR, 'profiles', `${id}.json`);
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw) as CatalogProfile;
  } catch {
    return null;
  }
}

export function loadCharger(id: string): CatalogCharger | null {
  if (!isSafeId(id)) return null;
  const p = path.join(CATALOG_DIR, 'chargers', `${id}.json`);
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw) as CatalogCharger;
  } catch {
    return null;
  }
}

/**
 * Read a profile's curve points (offset_seconds, apower) from its .curve.csv.
 * Returns [] on any error.
 */
export function loadCurvePoints(id: string): CurvePoint[] {
  if (!isSafeId(id)) return [];
  const p = path.join(CATALOG_DIR, 'profiles', `${id}.curve.csv`);
  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch {
    return [];
  }
  const out: CurvePoint[] = [];
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || i === 0) continue; // skip header (offset_seconds,apower)
    const idx = line.indexOf(',');
    if (idx < 0) continue;
    const offset = Number.parseInt(line.slice(0, idx), 10);
    const apower = Number.parseFloat(line.slice(idx + 1));
    if (!Number.isFinite(offset) || !Number.isFinite(apower)) continue;
    out.push({ offsetSeconds: offset, apower });
  }
  return out;
}

export function readPhoto(kind: 'profile' | 'charger', id: string): {
  buffer: Buffer;
  contentType: string;
} | null {
  if (!isSafeId(id)) return null;
  const dir = kind === 'profile' ? 'profiles' : 'chargers';
  // Photos are stored as <id>.photo.jpg in seed; future formats live on the
  // entry's `photo.file` field. Try the canonical filename first.
  const p = path.join(CATALOG_DIR, dir, `${id}.photo.jpg`);
  try {
    const buffer = fs.readFileSync(p);
    return { buffer, contentType: 'image/jpeg' };
  } catch {
    return null;
  }
}

/**
 * Catalog ids are hex-prefixes (16 chars). Reject anything else so a path
 * traversal via "../" or absolute path can't slip in via API routing.
 */
function isSafeId(id: string): boolean {
  return /^[a-f0-9]{16}$/.test(id);
}

// Test-only export to wipe the index cache between invocations.
export const __resetIndexCacheForTests = () => {
  cachedIndex = null;
};
