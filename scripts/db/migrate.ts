// scripts/db/migrate.ts — apply pending Drizzle migrations against the
// SQLite DB at $DATABASE_PATH (default: data/charging-master.db).
//
// Used by scripts/update/run-update.sh in the `migrate` stage. Idempotent:
// if no migration is newer than the latest entry in __drizzle_migrations,
// it exits 0 with "no migrations applied".
//
// Run: pnpm exec tsx scripts/db/migrate.ts

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const DB_PATH = resolve(process.env.DATABASE_PATH ?? 'data/charging-master.db');
const MIGRATIONS_FOLDER = resolve('drizzle');

if (!existsSync(MIGRATIONS_FOLDER)) {
  console.error(`[migrate] migrations folder not found: ${MIGRATIONS_FOLDER}`);
  process.exit(1);
}

mkdirSync(dirname(DB_PATH), { recursive: true });

console.log(`[migrate] db=${DB_PATH}`);
console.log(`[migrate] folder=${MIGRATIONS_FOLDER}`);

const sqlite = new Database(DB_PATH);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

const before = readLatest(sqlite);
console.log(`[migrate] latest applied before: ${formatLatest(before)}`);

try {
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
} catch (err) {
  console.error('[migrate] FAILED:', err instanceof Error ? err.message : err);
  sqlite.close();
  process.exit(1);
}

const after = readLatest(sqlite);
console.log(`[migrate] latest applied after:  ${formatLatest(after)}`);
console.log(`[migrate] OK`);
sqlite.close();

function readLatest(db: Database.Database): { hash: string; created_at: number } | null {
  try {
    const row = db
      .prepare(
        'SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1',
      )
      .get() as { hash: string; created_at: number } | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

function formatLatest(row: { hash: string; created_at: number } | null): string {
  if (row === null) return '<none>';
  return `${row.hash.slice(0, 12)}... (created_at=${row.created_at})`;
}
