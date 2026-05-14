// scripts/fixtures/export-reference-curve.ts — one-shot exporter that
// produces the synthetic-iPad-shaped reference curve fixture used by the
// Phase 11 confidence-band property tests. Also supports exporting the real
// iPad curve from the LXC DB when --profile-id <N> is provided without
// --synthetic.
//
// Per Phase 11 W2 / A4: the committed fixture is synthetic-iPad-shaped, NOT
// the real iPad curve. The real-DB export is OPTIONAL and deferred until LXC
// access is available.
//
// Run (synthetic, no DB needed):
//   pnpm exec tsx scripts/fixtures/export-reference-curve.ts --synthetic \
//     --out src/modules/charging/fixtures/ipad-reference-curve.json
//
// Run (real DB, exports profile_id=4 from data/charging-master.db):
//   pnpm exec tsx scripts/fixtures/export-reference-curve.ts \
//     --profile-id 4 --out src/modules/charging/fixtures/ipad-reference-curve.json

import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

type Args = {
  profileId: number;
  out: string;
  synthetic: boolean;
};

function parseArgs(argv: string[]): Args {
  let profileId = 4;
  let out = 'src/modules/charging/fixtures/ipad-reference-curve.json';
  let synthetic = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--profile-id' || a === '--profileId') {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n <= 0) {
        console.error(`[export-reference-curve] invalid --profile-id: ${argv[i]}`);
        process.exit(1);
      }
      profileId = n;
    } else if (a === '--out') {
      out = argv[++i];
    } else if (a === '--synthetic') {
      synthetic = true;
    } else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: tsx scripts/fixtures/export-reference-curve.ts [--profile-id <N>] [--out <path>] [--synthetic]',
      );
      process.exit(0);
    }
  }

  return { profileId, out, synthetic };
}

type ReferenceCurvePayload = {
  _comment: string;
  profileId: number;
  durationSeconds: number;
  totalEnergyWh: number;
  pointCount: number;
  points: Array<{ offsetSeconds: number; apower: number; cumulativeWh: number }>;
};

const SYNTHETIC_COMMENT =
  'Synthetic-iPad-shaped fixture (not the real iPad curve). To export the real iPad curve from the LXC DB, run: pnpm exec tsx scripts/fixtures/export-reference-curve.ts --profile-id 4 --out src/modules/charging/fixtures/ipad-reference-curve.json (requires LXC DB access). Per W2 / Assumption A4, the real-curve export is OPTIONAL and deferred until LXC access is available.';

// 50 min flat at 40 W (3000 points @ 1 Hz), then 90 min linear taper 40 → 5 W
// (5400 points). Total ≈ 8400 points, ≈ 61 Wh. The flat region is the
// DTW-offset-ambiguity case that motivated the confidence band.
export function buildSyntheticIpadCurve(profileId: number): ReferenceCurvePayload {
  const FLAT_SECONDS = 3000;
  const FLAT_POWER = 40;
  const TAPER_SECONDS = 5400;
  const TAPER_END_POWER = 5;

  const points: ReferenceCurvePayload['points'] = [];
  let cumulativeWh = 0;

  for (let t = 0; t < FLAT_SECONDS; t++) {
    cumulativeWh += FLAT_POWER / 3600; // Wh per 1 s sample
    points.push({
      offsetSeconds: t,
      apower: FLAT_POWER,
      cumulativeWh: round3(cumulativeWh),
    });
  }

  for (let i = 0; i < TAPER_SECONDS; i++) {
    const frac = i / (TAPER_SECONDS - 1);
    const apower = FLAT_POWER + frac * (TAPER_END_POWER - FLAT_POWER);
    cumulativeWh += apower / 3600;
    points.push({
      offsetSeconds: FLAT_SECONDS + i,
      apower: round3(apower),
      cumulativeWh: round3(cumulativeWh),
    });
  }

  const durationSeconds = points[points.length - 1].offsetSeconds;
  const totalEnergyWh = round3(cumulativeWh);

  return {
    _comment: SYNTHETIC_COMMENT,
    profileId,
    durationSeconds,
    totalEnergyWh,
    pointCount: points.length,
    points,
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

async function exportFromDb(profileId: number): Promise<ReferenceCurvePayload> {
  // Lazy-import the DB client so --synthetic mode never touches the FS DB path.
  const { db } = await import('@/db/client');
  const { referenceCurves, referenceCurvePoints } = await import('@/db/schema');
  const { eq } = await import('drizzle-orm');

  const curve = db
    .select()
    .from(referenceCurves)
    .where(eq(referenceCurves.profileId, profileId))
    .get();

  if (!curve) {
    console.error(
      `[export-reference-curve] no reference_curves row for profile_id=${profileId}`,
    );
    process.exit(2);
  }

  const rawPoints = db
    .select({
      offsetSeconds: referenceCurvePoints.offsetSeconds,
      apower: referenceCurvePoints.apower,
      cumulativeWh: referenceCurvePoints.cumulativeWh,
    })
    .from(referenceCurvePoints)
    .where(eq(referenceCurvePoints.curveId, curve.id))
    .all();

  if (rawPoints.length === 0) {
    console.error(
      `[export-reference-curve] reference_curve_points empty for curve_id=${curve.id}`,
    );
    process.exit(2);
  }

  rawPoints.sort((a, b) => a.offsetSeconds - b.offsetSeconds);

  return {
    _comment: `Real reference curve exported from LXC DB for profile_id=${profileId}. NOT synthetic.`,
    profileId,
    durationSeconds: curve.durationSeconds,
    totalEnergyWh: curve.totalEnergyWh,
    pointCount: rawPoints.length,
    points: rawPoints,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const outPath = resolve(args.out);

  const payload = args.synthetic
    ? buildSyntheticIpadCurve(args.profileId)
    : await exportFromDb(args.profileId);

  await writeFile(outPath, JSON.stringify(payload, null, 2));

  console.log(
    `[export-reference-curve] wrote ${outPath} (profileId=${payload.profileId}, points=${payload.pointCount}, duration=${payload.durationSeconds}s, energy=${payload.totalEnergyWh}Wh, synthetic=${args.synthetic})`,
  );
}

void main();
