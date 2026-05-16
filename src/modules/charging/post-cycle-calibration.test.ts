import { describe, it, expect } from 'vitest';
import {
  scoreSessionVsProfiles,
  VERIFY_TOLERANCE,
  MIN_CALIBRATION_WH,
  type CandidateProfile,
} from './post-cycle-calibration';

const IPAD: CandidateProfile = { id: 4, name: 'iPad Pro 12.9', totalEnergyWh: 62 };
const BOSCH: CandidateProfile = { id: 2, name: 'Bosch GBA', totalEnergyWh: 19 };
const WINBOT: CandidateProfile = { id: 5, name: 'Winbot W3', totalEnergyWh: 257 };
const EBIKE: CandidateProfile = { id: 1, name: 'Bosch PowerTube 625', totalEnergyWh: 689 };

describe('scoreSessionVsProfiles', () => {
  const NOW = 1_000_000_000;

  it('VERIFIES when delivered Wh fits committed profile within tolerance', () => {
    // 60 Wh delivered, committed = iPad (62 Wh), Δ = 3.2 % → within VERIFY_TOLERANCE
    const v = scoreSessionVsProfiles(60, 4, [IPAD, BOSCH, WINBOT, EBIKE], NOW);
    expect(v.verifiedAt).toBe(NOW);
    expect(v.flagReason).toBeNull();
  });

  it('FLAGS when another candidate fits noticeably better', () => {
    // 20 Wh delivered, committed = iPad (62 Wh, Δ 68 %), but Bosch (19 Wh, Δ 5 %)
    // is a clear winner.
    const v = scoreSessionVsProfiles(20, 4, [IPAD, BOSCH, WINBOT, EBIKE], NOW);
    expect(v.verifiedAt).toBeNull();
    expect(v.flagReason).toContain('Bosch GBA');
    expect(v.flagReason).toContain('iPad Pro 12.9');
  });

  it('FLAGS when committed profile is wildly out of tolerance even if it remains the best fit', () => {
    // Tiny single-cell unknown — only iPad in candidate set. 5 Wh delivered, Δ = 92 %.
    const v = scoreSessionVsProfiles(5, 4, [IPAD], NOW);
    expect(v.verifiedAt).toBeNull();
    expect(v.flagReason).toContain('weicht');
  });

  it('skips calibration below the minimum-energy threshold (neutral)', () => {
    const v = scoreSessionVsProfiles(2, 4, [IPAD], NOW);
    expect(v.verifiedAt).toBeNull();
    expect(v.flagReason).toBeNull();
  });

  it('skips when no candidates supplied (neutral)', () => {
    const v = scoreSessionVsProfiles(50, 4, [], NOW);
    expect(v.verifiedAt).toBeNull();
    expect(v.flagReason).toBeNull();
  });

  it('skips when committedProfileId is null (auto-detect with no commit — neutral)', () => {
    const v = scoreSessionVsProfiles(50, null, [IPAD, BOSCH], NOW);
    expect(v.verifiedAt).toBeNull();
    expect(v.flagReason).toBeNull();
  });

  it('Session 22 retroactive check: 16.8 Wh against iPad-only whitelist → flagged out-of-tolerance', () => {
    // Real Session 22 data: 16.8 Wh delivered, committed=iPad (62 Wh). Δ = 73 %.
    // Whitelist is iPad-only (Büro pinned to iPad after the 2026-05-15 incident).
    const v = scoreSessionVsProfiles(16.8, 4, [IPAD], NOW);
    expect(v.verifiedAt).toBeNull();
    expect(v.flagReason).toBeTruthy();
    // The dashboard should surface: "16.8 Wh weicht 73 % von Referenz iPad ab"
    expect(v.flagReason).toMatch(/weicht.*73.*%/);
  });

  it('Session 21 retroactive check: 4.3 Wh against iPad-or-Bosch whitelist → neutral (below MIN_CALIBRATION_WH)', () => {
    // Real Session 21 was a false-stop after only 4.26 Wh. That's below
    // MIN_CALIBRATION_WH — the post-cycle scorer correctly stays neutral
    // (we have no useful ground truth from such a short session).
    const v = scoreSessionVsProfiles(4.26, 2, [IPAD, BOSCH], NOW);
    expect(v.verifiedAt).toBeNull();
    expect(v.flagReason).toBeNull();
  });

  it('exports calibration constants at the documented values', () => {
    expect(VERIFY_TOLERANCE).toBe(0.20);
    expect(MIN_CALIBRATION_WH).toBe(5);
  });
});
