// scripts/db/backfill-migrations-table.ts — one-shot helper for LXCs whose
// schema was brought up to date via `drizzle-kit push` or hand-applied SQL
// rather than `drizzle migrate`. Both production LXCs (192.168.3.185 and
// 192.168.2.117) were in this state on 2026-05-10.
//
// Without this backfill, the next `drizzle migrate` run sees an empty
// __drizzle_migrations table and tries to apply ALL journal entries from
// scratch — which crashes on `CREATE TABLE`/`ALTER TABLE` for objects that
// already exist.
//
// What it does:
//   1. Verifies expected schema artifacts exist (e.g. `device_profiles.chemistry`).
//      If a sentinel column is missing, refuses — schema is NOT actually current.
//   2. Creates __drizzle_migrations if missing.
//   3. Refuses if the table already has rows (safety — never overwrite real
//      tracking history).
//   4. Reads drizzle/meta/_journal.json and inserts one row per entry with:
//        hash       = sha256 of the raw SQL file content (matches drizzle's
//                     readMigrationFiles in node_modules/drizzle-orm/migrator.js)
//        created_at = entry.when (millis from the journal)
//
// Run: pnpm exec tsx scripts/db/backfill-migrations-table.ts

import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DB_PATH = resolve(process.env.DATABASE_PATH ?? 'data/charging-master.db');
const MIGRATIONS_FOLDER = resolve('drizzle');
const JOURNAL_PATH = resolve(MIGRATIONS_FOLDER, 'meta/_journal.json');

if (!existsSync(JOURNAL_PATH)) {
  console.error(`[backfill] journal not found: ${JOURNAL_PATH}`);
  process.exit(1);
}
if (!existsSync(DB_PATH)) {
  console.error(`[backfill] db not found: ${DB_PATH}`);
  process.exit(1);
}

interface JournalEntry {
  idx: number;
  tag: string;
  when: number;
}

const journal = JSON.parse(readFileSync(JOURNAL_PATH, 'utf8')) as { entries: JournalEntry[] };

const sqlite = new Database(DB_PATH);
sqlite.pragma('foreign_keys = ON');

// Sentinel check — refuse to backfill if the schema is NOT actually at the
// latest migration. Both columns were added by 0002 and 0007's table by 0007.
const sentinels: Array<{ q: string; reason: string }> = [
  {
    q: "SELECT 1 FROM pragma_table_info('device_profiles') WHERE name='chemistry'",
    reason: '0002 column device_profiles.chemistry missing — DB is not at latest schema',
  },
  {
    q: "SELECT 1 FROM sqlite_master WHERE type='table' AND name='soc_corrections'",
    reason: '0007 table soc_corrections missing — DB is not at latest schema',
  },
];
for (const s of sentinels) {
  const row = sqlite.prepare(s.q).get();
  if (row === undefined) {
    console.error(`[backfill] REFUSING: ${s.reason}`);
    sqlite.close();
    process.exit(1);
  }
}

sqlite
  .prepare(
    `CREATE TABLE IF NOT EXISTS __drizzle_migrations (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       hash TEXT NOT NULL,
       created_at NUMERIC
     )`,
  )
  .run();

const existing = sqlite
  .prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations')
  .get() as { n: number };
if (existing.n > 0) {
  console.log(`[backfill] __drizzle_migrations already has ${existing.n} rows — nothing to do`);
  sqlite.close();
  process.exit(0);
}

const insert = sqlite.prepare(
  'INSERT INTO __drizzle_migrations ("hash", "created_at") VALUES (?, ?)',
);

const inserted: string[] = [];
const tx = sqlite.transaction(() => {
  for (const entry of journal.entries) {
    const sqlPath = resolve(MIGRATIONS_FOLDER, `${entry.tag}.sql`);
    if (!existsSync(sqlPath)) {
      throw new Error(`migration file missing: ${sqlPath}`);
    }
    const content = readFileSync(sqlPath, 'utf8');
    const hash = createHash('sha256').update(content).digest('hex');
    insert.run(hash, entry.when);
    inserted.push(`${entry.tag} hash=${hash.slice(0, 12)}... when=${entry.when}`);
  }
});

try {
  tx();
} catch (err) {
  console.error('[backfill] transaction failed:', err instanceof Error ? err.message : err);
  sqlite.close();
  process.exit(1);
}

for (const line of inserted) {
  console.log(`[backfill] inserted ${line}`);
}
console.log(`[backfill] OK — ${inserted.length} entries marked as applied`);
sqlite.close();
