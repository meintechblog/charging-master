#!/usr/bin/env tsx
/**
 * Replay historical session readings through the live curve-matcher.
 *
 * Reads three CSV dumps (committed alongside this script):
 *   - profiles.csv             id|name|cap_wh|eff|startW|peakW|durS|pts|totalE
 *   - reference-curves.csv     profile_id,offset_s,apower,cumulative_wh
 *   - power-readings.csv       session_id,offset_ms,apower
 *
 * For each session, walks the readings forward at every increment of
 * REPORT_EVERY (default 6 = 30s = ~1 matcher interval), calls
 * findBestCandidate against the live profile set, and prints what profile
 * the matcher picked + its confidence + the runner-up's confidence.
 *
 * The point of the runner-up column: it surfaces whether the win was clean
 * (margin > ~1.15×) or noise (~1.0×). Most "wrong-profile" picks in production
 * have winner/runner-up confidence ratios under 1.05 — the matcher essentially
 * coin-flipped between equivalent flat-power candidates.
 *
 * Run: pnpm exec tsx scripts/diagnose/replay-session.ts [--session N]
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { subsequenceDtw } from '../../src/modules/charging/dtw';
import {
  deriveBand,
  DEFAULT_BAND_THRESHOLD_PCT,
  DEFAULT_CONFIDENCE_MARGIN_RATIO,
  DEFAULT_CONFIDENCE_THRESHOLD,
  type ProfileWithCurve,
} from '../../src/modules/charging/curve-matcher';
import { estimateSocTaperAware } from '../../src/modules/charging/soc-estimator';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface ProfileRow {
  id: number;
  name: string;
  capacityWh: number;
  chargerEfficiency: number;
  startPower: number;
  peakPower: number;
  durationSeconds: number;
  pointCount: number;
  totalEnergyWh: number;
}

interface CandidateRow {
  profileId: number;
  profileName: string;
  confidence: number;
  socBest: number;
  socMin: number;
  socMax: number;
}

const REPORT_EVERY = 6;             // log every ~30 s of readings (5 s polling)
const MIN_MATCH_READINGS = 6;       // = SUSTAINED_READINGS in charge-state-machine

function loadProfiles(): ProfileWithCurve[] {
  const profilesCsv = readFileSync(join(__dirname, 'profiles.csv'), 'utf8').trim().split('\n');
  const profiles: ProfileRow[] = profilesCsv.map((line) => {
    const [id, name, cap, eff, sp, pp, dur, pts, te] = line.split('|');
    return {
      id: parseInt(id, 10),
      name,
      capacityWh: parseFloat(cap),
      chargerEfficiency: parseFloat(eff),
      startPower: parseFloat(sp),
      peakPower: parseFloat(pp),
      durationSeconds: parseInt(dur, 10),
      pointCount: parseInt(pts, 10),
      totalEnergyWh: parseFloat(te),
    };
  });

  const curvesCsv = readFileSync(join(__dirname, 'reference-curves.csv'), 'utf8').trim().split('\n');
  const curvePoints = new Map<number, Array<{ offsetSeconds: number; apower: number; cumulativeWh: number }>>();
  for (const line of curvesCsv) {
    const [pid, os, ap, cw] = line.split(',');
    const pidNum = parseInt(pid, 10);
    if (!curvePoints.has(pidNum)) curvePoints.set(pidNum, []);
    curvePoints.get(pidNum)!.push({
      offsetSeconds: parseInt(os, 10),
      apower: parseFloat(ap),
      cumulativeWh: parseFloat(cw),
    });
  }

  return profiles.map((p) => ({
    id: p.id,
    name: p.name,
    curve: {
      startPower: p.startPower,
      durationSeconds: p.durationSeconds,
      totalEnergyWh: p.totalEnergyWh,
    },
    curvePoints: curvePoints.get(p.id) ?? [],
  }));
}

function loadReadings(): Map<number, number[]> {
  const csv = readFileSync(join(__dirname, 'power-readings.csv'), 'utf8').trim().split('\n');
  const grouped = new Map<number, number[]>();
  for (const line of csv) {
    const [sid, _os, ap] = line.split(',');
    const sidNum = parseInt(sid, 10);
    if (!grouped.has(sidNum)) grouped.set(sidNum, []);
    grouped.get(sidNum)!.push(parseFloat(ap));
  }
  return grouped;
}

/**
 * Run the matcher logic against ALL profiles, return scored results sorted
 * by confidence desc. Production findBestCandidate returns ONLY the winner —
 * we need second-best too for the margin diagnosis.
 */
function rankAllProfiles(
  queryReadings: number[],
  profiles: ProfileWithCurve[],
): CandidateRow[] {
  if (queryReadings.length === 0) return [];
  const avgQuery = queryReadings.reduce((a, b) => a + b, 0) / queryReadings.length;

  const results: CandidateRow[] = [];
  for (const profile of profiles) {
    const refPowers = profile.curvePoints.map((p) => p.apower);
    if (refPowers.length < queryReadings.length) continue;
    const { distance, distances, windowStep } = subsequenceDtw(queryReadings, refPowers);
    const confidence = Math.max(0, 1 - distance / (avgQuery || 1));
    const band = deriveBand(
      distances,
      windowStep,
      profile.curvePoints,
      profile.curve.durationSeconds,
      DEFAULT_BAND_THRESHOLD_PCT,
    );
    results.push({
      profileId: profile.id,
      profileName: profile.name,
      confidence,
      socBest: band.socBest,
      socMin: band.socMin,
      socMax: band.socMax,
    });
  }
  results.sort((a, b) => b.confidence - a.confidence);
  return results;
}

function fmtProfile(c: CandidateRow): string {
  const shortName = c.profileName.replace(/Bosch Professional GBA 10,8V 2.0Ah/, 'BoschGBA').replace(/iPad Pro 12.9" \(2022, M2\)/, 'iPad').replace(/Winbot W3/, 'Winbot').replace(/Bosch PowerTube 625/, 'PowerTube');
  return `${shortName}(c=${c.confidence.toFixed(3)},soc=${c.socBest}±[${c.socMin}-${c.socMax}])`;
}

function replaySession(sessionId: number, readings: number[], profiles: ProfileWithCurve[]): void {
  console.log(`\n${'='.repeat(110)}`);
  console.log(`SESSION ${sessionId} — ${readings.length} readings (${(readings.length * 5 / 60).toFixed(1)} min @ 5s polling)`);
  console.log(`${'='.repeat(110)}`);
  console.log('  win#  read  min   winner                                     | runner-up                            | margin');
  console.log(`  ${'-'.repeat(108)}`);

  let lastWinner = -1;
  let stableFor = 0;
  for (let n = MIN_MATCH_READINGS; n <= readings.length; n += REPORT_EVERY) {
    const window = readings.slice(0, n);
    const ranked = rankAllProfiles(window, profiles);
    if (ranked.length < 2) continue;

    const winner = ranked[0];
    const runner = ranked[1];
    const margin = runner.confidence > 0 ? winner.confidence / runner.confidence : 999;
    const switched = winner.profileId !== lastWinner;
    if (switched) {
      stableFor = 0;
      lastWinner = winner.profileId;
    } else {
      stableFor++;
    }
    const switchMark = switched ? '*' : ' ';
    const minStr = (n * 5 / 60).toFixed(1).padStart(5);
    const readStr = String(n).padStart(4);
    console.log(`  ${switchMark}     ${readStr}  ${minStr}  ${fmtProfile(winner).padEnd(43)}| ${fmtProfile(runner).padEnd(37)}| ×${margin.toFixed(3)}`);
  }
}

/**
 * v1.5 verification mode. For each historical session, simulate what the
 * NEW logic (margin gate + pin per plug + taper-aware SoC) would do.
 *
 * Two scenarios per session:
 *   1. UNPINNED — same matcher pipeline, but the margin gate refuses commits
 *      below DEFAULT_CONFIDENCE_MARGIN_RATIO (×1.05). Reports whether the
 *      session would ever commit a match and to which profile.
 *   2. PINNED — assume plug.pinnedProfileId = correct iPad (id=4). No DTW,
 *      direct synthetic match. Stop logic gets the right capacity / taper
 *      curve from the start.
 *
 * For each scenario, simulate energy-fallback SoC over time and report when
 * estSoc would cross target=80. With taper-aware SoC, also report what the
 * curve-position estimate says at the moment the energy estimate hits 80.
 */
function verifySession(sessionId: number, readings: number[], profiles: ProfileWithCurve[]): void {
  const iPadProfile = profiles.find((p) => p.id === 4)!;

  // --- Scenario 1: UNPINNED with margin gate ---
  let firstCommitReading = -1;
  let firstCommitProfile: { id: number; name: string } | null = null;
  for (let n = MIN_MATCH_READINGS; n <= readings.length; n += 6) {
    const window = readings.slice(0, n);
    const avgQuery = window.reduce((a, b) => a + b, 0) / window.length;
    const ranked: Array<{ id: number; name: string; confidence: number }> = [];
    for (const profile of profiles) {
      const refPowers = profile.curvePoints.map((p) => p.apower);
      if (refPowers.length < window.length) continue;
      const { distance } = subsequenceDtw(window, refPowers);
      const confidence = Math.max(0, 1 - distance / (avgQuery || 1));
      ranked.push({ id: profile.id, name: profile.name, confidence });
    }
    ranked.sort((a, b) => b.confidence - a.confidence);
    if (ranked.length === 0) continue;
    const best = ranked[0];
    if (best.confidence < DEFAULT_CONFIDENCE_THRESHOLD) continue;
    const runnerUp = ranked[1];
    if (runnerUp && runnerUp.confidence > 0 && best.confidence < runnerUp.confidence * DEFAULT_CONFIDENCE_MARGIN_RATIO) continue;
    firstCommitReading = n;
    firstCommitProfile = { id: best.id, name: best.name };
    break;
  }

  // --- Scenario 1b: WHITELIST = {iPad, BoschGBA} simulating "Büro plug only
  // ever charges iPad or Bosch power-tools" — replays with energy-bound
  // elimination + Bayesian prior (uniform → equal weight). Shows whether
  // pinning the candidate set + energy elim resolves earlier.
  let whitelistCommitReading = -1;
  let whitelistCommitProfile: { id: number; name: string } | null = null;
  const whitelistIds = new Set([4, 2]);
  const profileMaxWh = new Map<number, number>(profiles.map((p) => [p.id, p.curve.totalEnergyWh]));
  for (let n = MIN_MATCH_READINGS; n <= readings.length; n += 6) {
    const window = readings.slice(0, n);
    const accumulatedWh = readings.slice(0, n).reduce((acc, p) => acc + p * 5 / 3600, 0);
    const aliveIds = [...whitelistIds].filter((id) => {
      const max = profileMaxWh.get(id);
      return max === undefined || accumulatedWh <= max * 1.1;
    });
    if (aliveIds.length === 0) break; // contradicts whitelist; user must intervene
    if (aliveIds.length === 1) {
      whitelistCommitReading = n;
      const p = profiles.find((p) => p.id === aliveIds[0])!;
      whitelistCommitProfile = { id: p.id, name: p.name };
      break;
    }
    const avgQuery = window.reduce((a, b) => a + b, 0) / window.length;
    const ranked: Array<{ id: number; name: string; confidence: number }> = [];
    for (const profile of profiles) {
      if (!aliveIds.includes(profile.id)) continue;
      const refPowers = profile.curvePoints.map((p) => p.apower);
      if (refPowers.length < window.length) continue;
      const { distance } = subsequenceDtw(window, refPowers);
      const confidence = Math.max(0, 1 - distance / (avgQuery || 1));
      ranked.push({ id: profile.id, name: profile.name, confidence });
    }
    ranked.sort((a, b) => b.confidence - a.confidence);
    if (ranked.length === 0) continue;
    const best = ranked[0];
    if (best.confidence < DEFAULT_CONFIDENCE_THRESHOLD) continue;
    const runnerUp = ranked[1];
    if (runnerUp && runnerUp.confidence > 0 && best.confidence < runnerUp.confidence * DEFAULT_CONFIDENCE_MARGIN_RATIO) continue;
    whitelistCommitReading = n;
    whitelistCommitProfile = { id: best.id, name: best.name };
    break;
  }

  // --- Scenario 2: PINNED to iPad (the correct profile for all 4 sessions) ---
  // No DTW. Synthetic match with startSoc=0, wide band. Energy_fallback
  // tracks estSoc via estimateSocTaperAware against iPad curve.
  const taperCurvePoints = iPadProfile.curvePoints.map((p) => ({
    offsetSeconds: p.offsetSeconds,
    apower: p.apower,
  }));
  const peakPower = Math.max(...iPadProfile.curvePoints.map((p) => p.apower));
  let cumulativeWh = 0;
  let crossReading = -1;
  let crossDetails: { method: string; energySoc: number; finalSoc: number } | null = null;
  for (let i = 0; i < readings.length; i++) {
    cumulativeWh += readings[i] * 5 / 3600; // 5s polling
    const taperResult = estimateSocTaperAware({
      apower: readings[i],
      peakPower,
      currentWh: cumulativeWh,
      totalWh: iPadProfile.curve.totalEnergyWh,
      startSoc: 0,
      curvePoints: taperCurvePoints,
      totalDurationSeconds: iPadProfile.curve.durationSeconds,
    });
    if (taperResult.soc >= 80 && crossReading < 0) {
      const energyOnly = Math.round((cumulativeWh / iPadProfile.curve.totalEnergyWh) * 100);
      crossReading = i + 1;
      crossDetails = { method: taperResult.method, energySoc: energyOnly, finalSoc: taperResult.soc };
      break;
    }
  }

  console.log(`\n=== Session ${sessionId} verification ===`);
  console.log(`  v1.5 unpinned (DTW + ×1.05 margin gate, ALL 4 profiles):`);
  if (firstCommitReading < 0) {
    console.log(`    NEVER COMMITS — stays in 'detecting', no auto-stop. Margin never clean enough.`);
  } else {
    const min = (firstCommitReading * 5 / 60).toFixed(1);
    console.log(`    Commits at reading #${firstCommitReading} (${min} min) → ${firstCommitProfile!.name}`);
  }
  console.log(`  v1.6 whitelist={iPad, BoschGBA} + energy-bound:`);
  if (whitelistCommitReading < 0) {
    console.log(`    NEVER COMMITS in ${(readings.length * 5 / 60).toFixed(1)} min — would prompt user (active-learning fallback).`);
  } else {
    const min = (whitelistCommitReading * 5 / 60).toFixed(1);
    console.log(`    Commits at reading #${whitelistCommitReading} (${min} min) → ${whitelistCommitProfile!.name}`);
  }
  console.log(`  Pinned (iPad profile=4, taper-aware SoC):`);
  if (crossReading < 0) {
    const totalMin = (readings.length * 5 / 60).toFixed(1);
    console.log(`    estSoc never crosses 80 in ${totalMin} min — session ran short. (Final cumWh=${cumulativeWh.toFixed(2)})`);
  } else {
    const min = (crossReading * 5 / 60).toFixed(1);
    console.log(`    estSoc=80 reached at reading #${crossReading} (${min} min) via ${crossDetails!.method} method`);
    console.log(`    (energy-only SoC at that point would be ${crossDetails!.energySoc}%, final taper-aware ${crossDetails!.finalSoc}%)`);
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const sessionFilter = args.find((a) => a.startsWith('--session=')) ? parseInt(args.find((a) => a.startsWith('--session='))!.split('=')[1], 10) : null;
  const verifyMode = args.includes('--verify');

  const profiles = loadProfiles();
  console.log(`Loaded ${profiles.length} profiles:`);
  for (const p of profiles) {
    console.log(`  #${p.id} ${p.name}: ${p.curvePoints.length} points, duration ${p.curve.durationSeconds}s`);
  }

  const sessions = loadReadings();
  const ids = [...sessions.keys()].sort((a, b) => a - b);
  console.log(`\nSessions in dataset: ${ids.join(', ')}`);

  for (const id of ids) {
    if (sessionFilter !== null && id !== sessionFilter) continue;
    if (verifyMode) verifySession(id, sessions.get(id)!, profiles);
    else replaySession(id, sessions.get(id)!, profiles);
  }
}

main();
