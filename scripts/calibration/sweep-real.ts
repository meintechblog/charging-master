/**
 * One-off diagnostic. Run after exporting a new device profile to confirm
 * DEFAULT_BAND_THRESHOLD_PCT still produces sensible bands against real data.
 *
 *   pnpm exec tsx scripts/calibration/sweep-real.ts
 *   pnpm exec tsx scripts/calibration/sweep-real.ts --profile-id 7 --sessions 42,43
 *   pnpm exec tsx scripts/calibration/sweep-real.ts --thresholds 0.05,0.20 --windows 10,30
 *   DATABASE_FILE=/opt/charging-master/data/charging-master.db pnpm exec tsx scripts/calibration/sweep-real.ts
 *
 * For each --sessions id, loads power_readings between session start and stop,
 * runs subsequenceDtw against the profile's reference curve at every
 * --windows minute slice, and prints a markdown table of bandMin..bandMax,
 * bandwidth, and socBest for each --thresholds value.
 *
 * Reads the local SQLite DB (./data/charging-master.db by default, override
 * via $DATABASE_FILE or --db). NOT covered by tests — empirical sanity check
 * only. The committed unit test (curve-matcher.test.ts) uses a single fixture
 * slice; this script is the manual full-sweep counterpart used when adjusting
 * the constant.
 */

import Database from 'better-sqlite3';

import { subsequenceDtw } from '@/modules/charging/dtw';
import { deriveBand } from '@/modules/charging/curve-matcher';

interface CurvePoint {
  offsetSeconds: number;
  apower: number;
  cumulativeWh: number;
}

interface Args {
  profileId: number;
  sessions: number[];
  thresholds: number[];
  windowsMinutes: number[];
  dbPath: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    profileId: 4,
    sessions: [16, 14, 17],
    thresholds: [0.05, 0.10, 0.15, 0.20, 0.30],
    windowsMinutes: [10, 20, 40, 60, 80, 100, 120],
    dbPath: process.env.DATABASE_FILE ?? './data/charging-master.db',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === '--profile-id' && v) { args.profileId = Number(v); i++; }
    else if (a === '--sessions' && v) { args.sessions = v.split(',').map((s) => Number(s.trim())); i++; }
    else if (a === '--thresholds' && v) { args.thresholds = v.split(',').map((s) => Number(s.trim())); i++; }
    else if (a === '--windows' && v) { args.windowsMinutes = v.split(',').map((s) => Number(s.trim())); i++; }
    else if (a === '--db' && v) { args.dbPath = v; i++; }
    else if (a === '--help' || a === '-h') {
      console.log('Usage: pnpm exec tsx scripts/calibration/sweep-real.ts [--profile-id N] [--sessions ID,ID,...] [--thresholds T,T,...] [--windows MIN,MIN,...] [--db PATH]');
      process.exit(0);
    }
  }
  return args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  const db = new Database(args.dbPath, { readonly: true });

  const refRow = db
    .prepare('SELECT id, duration_seconds, total_energy_wh, point_count FROM reference_curves WHERE profile_id=? ORDER BY id DESC LIMIT 1')
    .get(args.profileId) as
    | { id: number; duration_seconds: number; total_energy_wh: number; point_count: number }
    | undefined;

  if (!refRow) {
    console.error(`No reference_curves row for profile_id=${args.profileId}`);
    process.exit(1);
  }

  const curvePoints = db
    .prepare(
      'SELECT offset_seconds AS offsetSeconds, apower, cumulative_wh AS cumulativeWh FROM reference_curve_points WHERE curve_id=? ORDER BY offset_seconds ASC',
    )
    .all(refRow.id) as CurvePoint[];

  const referencePowers = curvePoints.map((p) => p.apower);
  const refDuration = refRow.duration_seconds;

  console.log(
    `Reference curve ${refRow.id} (profile_id=${args.profileId}): ${curvePoints.length} pts, ${refDuration}s, ${refRow.total_energy_wh.toFixed(2)} Wh\n`,
  );

  for (const sid of args.sessions) {
    const meta = db
      .prepare('SELECT plug_id, started_at, stopped_at, energy_wh FROM charge_sessions WHERE id=?')
      .get(sid) as { plug_id: string; started_at: number; stopped_at: number; energy_wh: number | null } | undefined;
    if (!meta) {
      console.log(`\n=== Session ${sid}: not found, skipped ===`);
      continue;
    }

    const readings = db
      .prepare(
        'SELECT apower, timestamp FROM power_readings WHERE plug_id=? AND timestamp BETWEEN ? AND ? ORDER BY timestamp ASC',
      )
      .all(meta.plug_id, meta.started_at, meta.stopped_at) as Array<{ apower: number; timestamp: number }>;

    if (readings.length === 0) {
      console.log(`\n=== Session ${sid}: 0 readings, skipped ===`);
      continue;
    }

    const sessionMin = (readings[readings.length - 1].timestamp - readings[0].timestamp) / 60_000;
    const coverPct = ((sessionMin * 60) / refDuration) * 100;

    console.log(
      `\n=== Session ${sid} — ${readings.length} readings, ${sessionMin.toFixed(1)} min (covers ${coverPct.toFixed(0)}% of ref curve), energy_wh=${meta.energy_wh?.toFixed(2) ?? '-'} ===`,
    );

    // Convert window minutes to sample counts (assume ~5s polling → 12/min).
    // Cap each at readings.length; dedupe.
    const sampleSizes = Array.from(
      new Set(
        args.windowsMinutes
          .map((min) => Math.min(min * 12, readings.length))
          .concat([readings.length]),
      ),
    ).sort((a, b) => a - b);

    const header =
      '| qmin | n   | best | ' +
      args.thresholds.map((t) => `thr=${t.toFixed(2)} [min..max=Δ B=socBest]`).join(' | ') +
      ' |';
    const sep = '|------|-----|------|' + args.thresholds.map(() => '-----------------------------').join('|') + '|';
    console.log(header);
    console.log(sep);

    for (const n of sampleSizes) {
      const query = readings.slice(0, n).map((r) => r.apower);
      const qmin = ((readings[n - 1].timestamp - readings[0].timestamp) / 60_000).toFixed(1);
      const { distance, distances, windowStep } = subsequenceDtw(query, referencePowers);
      const cells: string[] = [];
      for (const thr of args.thresholds) {
        const b = deriveBand(distances, windowStep, curvePoints, refDuration, thr);
        const w = b.socMax - b.socMin;
        const marker = w === 0 ? '⚠' : '';
        cells.push(`${b.socMin}..${b.socMax}=${w}${marker} B=${b.socBest}`);
      }
      console.log(`| ${qmin} | ${n} | ${distance.toFixed(2)} | ` + cells.join(' | ') + ' |');
    }
  }

  db.close();
}

main();
