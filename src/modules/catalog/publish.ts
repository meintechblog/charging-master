import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  deviceProfiles,
  chargers,
  referenceCurves,
  referenceCurvePoints,
  socBoundaries,
  profilePhotos,
  config,
} from '@/db/schema';
import { loadIndex } from './loader';
import type {
  CatalogProfile,
  CatalogCharger,
  CatalogSocBoundary,
} from './types';

// Quality gates — same as documented in catalog/README.md.
const LIMITS = {
  MAX_POINTS: 20_000,
  MAX_DURATION_SECONDS: 24 * 3600,
  MAX_CSV_BYTES: 1024 * 1024, // 1 MB
  MAX_NAME: 100,
  MAX_MFR: 60,
  MAX_MODEL: 60,
  MAX_NOTES: 500,
  MAX_URL: 500,
};

const CATALOG_DIR = path.join(process.cwd(), 'catalog');

export type ValidationIssue = {
  field: string;
  message: string;
  severity: 'error' | 'warning';
};

export type PublishArtifact = {
  // Path relative to repo root, e.g. "catalog/profiles/<id>.json"
  path: string;
  contentType: string;
  // base64-encoded for binary, raw string for text. We always carry base64
  // so the API surface is uniform.
  contentBase64: string;
};

export type PublishBundle = {
  profileId: string; // catalog id
  chargerId: string | null; // catalog id of linked charger, if included
  issues: ValidationIssue[];
  artifacts: PublishArtifact[];
};

// ---------------------------------------------------------------------------
// canonical-id helpers (mirror /tmp/catalog-seed/build-catalog.mjs)
// ---------------------------------------------------------------------------

function sha256Hex(buf: string | Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function roundCoarse(n: number, digits = 2): number {
  const k = 10 ** digits;
  return Math.round(n * k) / k;
}

function canonicalCurve(points: { offsetSeconds: number; apower: number }[]): string {
  return JSON.stringify(
    points
      .slice()
      .sort((a, b) => a.offsetSeconds - b.offsetSeconds)
      .map((p) => [p.offsetSeconds, roundCoarse(p.apower, 2)])
  );
}

function canonicalChargerKey(c: {
  manufacturer: string | null;
  model: string | null;
  maxVoltageV: number | null;
  maxCurrentA: number | null;
  outputType: string;
  efficiency: number;
}): string {
  return [
    (c.manufacturer ?? '').trim().toLowerCase(),
    (c.model ?? '').trim().toLowerCase(),
    roundCoarse(c.maxVoltageV ?? 0, 1),
    roundCoarse(c.maxCurrentA ?? 0, 2),
    (c.outputType ?? 'DC').toUpperCase(),
    roundCoarse(c.efficiency ?? 0, 2),
  ].join('|');
}

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

function check(issues: ValidationIssue[], cond: boolean, field: string, msg: string, severity: 'error' | 'warning' = 'error') {
  if (!cond) issues.push({ field, message: msg, severity });
}

function safeStr(v: string | null | undefined, max: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (s.length === 0) return null;
  if (s.length > max) return s.slice(0, max);
  return s;
}

function safeUrl(v: string | null | undefined): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (s.length === 0 || s.length > LIMITS.MAX_URL) return null;
  if (!/^https?:\/\//i.test(s)) return null;
  return s;
}

export function getInstanceLabel(): string {
  const row = db.select().from(config).where(eq(config.key, 'instance.label')).get();
  return row?.value ?? 'unknown';
}

// ---------------------------------------------------------------------------
// bundle generation
// ---------------------------------------------------------------------------

export function buildPublishBundle(localProfileId: number): PublishBundle | null {
  const profile = db.select().from(deviceProfiles).where(eq(deviceProfiles.id, localProfileId)).get();
  if (!profile) return null;
  const curve = db.select().from(referenceCurves).where(eq(referenceCurves.profileId, localProfileId)).get();
  if (!curve) return null;

  const issues: ValidationIssue[] = [];

  // Curve checks
  check(issues, curve.pointCount > 1, 'curve', 'Referenzkurve hat zu wenige Punkte.');
  check(issues, curve.pointCount <= LIMITS.MAX_POINTS, 'curve', `Referenzkurve hat ${curve.pointCount} Punkte (Limit ${LIMITS.MAX_POINTS}).`);
  check(issues, curve.durationSeconds <= LIMITS.MAX_DURATION_SECONDS, 'curve', `Ladedauer ${curve.durationSeconds}s übersteigt 24h.`);
  check(issues, curve.peakPower > 0, 'curve', 'Peak-Power ist 0.');

  // Required identification
  check(issues, !!profile.name, 'name', 'Name fehlt.');
  if (profile.name && profile.name.length > LIMITS.MAX_NAME) {
    issues.push({ field: 'name', message: `Name > ${LIMITS.MAX_NAME} Zeichen.`, severity: 'warning' });
  }

  const points = db
    .select({
      offsetSeconds: referenceCurvePoints.offsetSeconds,
      apower: referenceCurvePoints.apower,
    })
    .from(referenceCurvePoints)
    .where(eq(referenceCurvePoints.curveId, curve.id))
    .all();

  if (points.length === 0) {
    issues.push({ field: 'curve', message: 'Keine Curve-Points in der DB.', severity: 'error' });
    return { profileId: '', chargerId: null, issues, artifacts: [] };
  }

  // Detect constant / all-zero curves
  const minP = Math.min(...points.map((p) => p.apower));
  const maxP = Math.max(...points.map((p) => p.apower));
  check(issues, maxP > 0, 'curve', 'Curve ist all-zero — vermutlich kein echter Ladevorgang.');
  check(issues, maxP - minP > 0.5, 'curve', 'Curve ist nahezu konstant — kein typisches Lade-Profil.', 'warning');

  // Build CSV + check size
  const csvLines = ['offset_seconds,apower'];
  for (const p of points.sort((a, b) => a.offsetSeconds - b.offsetSeconds)) {
    csvLines.push(`${p.offsetSeconds},${roundCoarse(p.apower, 2)}`);
  }
  const csv = csvLines.join('\n') + '\n';
  if (Buffer.byteLength(csv) > LIMITS.MAX_CSV_BYTES) {
    issues.push({ field: 'curve', message: `Curve-CSV ${Buffer.byteLength(csv)}B > ${LIMITS.MAX_CSV_BYTES}B Limit.`, severity: 'error' });
  }

  // Charger (optional)
  let charger: typeof chargers.$inferSelect | null = null;
  if (profile.chargerId != null) {
    charger = db.select().from(chargers).where(eq(chargers.id, profile.chargerId)).get() ?? null;
  }
  let chargerCatalogId: string | null = null;
  if (charger) {
    const efficiency = charger.efficiency ?? 0.85;
    chargerCatalogId = sha256Hex(
      'CHARGER:' +
        canonicalChargerKey({
          manufacturer: charger.manufacturer,
          model: charger.model,
          maxVoltageV: charger.maxVoltageV,
          maxCurrentA: charger.maxCurrentA,
          outputType: charger.outputType ?? 'DC',
          efficiency,
        })
    ).slice(0, 16);
  }

  // SOC boundaries
  const boundaries: CatalogSocBoundary[] = db
    .select({
      soc: socBoundaries.soc,
      offsetSeconds: socBoundaries.offsetSeconds,
      cumulativeWh: socBoundaries.cumulativeWh,
      expectedPower: socBoundaries.expectedPower,
    })
    .from(socBoundaries)
    .where(eq(socBoundaries.curveId, curve.id))
    .all()
    .sort((a, b) => a.soc - b.soc)
    .map((b) => ({
      soc: b.soc,
      offsetSeconds: b.offsetSeconds,
      cumulativeWh: roundCoarse(b.cumulativeWh, 4),
      expectedPower: roundCoarse(b.expectedPower, 2),
    }));

  // Catalog id from curve hash
  const fullHash = sha256Hex(canonicalCurve(points));
  const profileCatalogId = fullHash.slice(0, 16);

  // Photo (optional) — pick primary; downscale + recompress is the
  // submitter's responsibility, here we just include the bytes as-is. If the
  // raw photo is huge, we warn (catalog gates max ~300KB per photo).
  let photoArtifact: PublishArtifact | null = null;
  const primaryPhoto = db
    .select()
    .from(profilePhotos)
    .where(eq(profilePhotos.profileId, localProfileId))
    .all()
    .find((p) => p.isPrimary) ?? null;
  if (primaryPhoto) {
    const photoPath = path.join(process.cwd(), 'data', 'profile-photos', String(localProfileId), primaryPhoto.fileName);
    try {
      const buf = fs.readFileSync(photoPath);
      if (buf.byteLength > 500 * 1024) {
        issues.push({
          field: 'photo',
          message: `Foto ist ${(buf.byteLength / 1024).toFixed(0)} KB — wird über die Pipeline nicht herunterskaliert (Phase 1 limitation).`,
          severity: 'warning',
        });
      }
      photoArtifact = {
        path: `catalog/profiles/${profileCatalogId}.photo.jpg`,
        contentType: primaryPhoto.contentType,
        contentBase64: buf.toString('base64'),
      };
    } catch (err) {
      issues.push({
        field: 'photo',
        message: `Foto-Datei nicht lesbar: ${err instanceof Error ? err.message : String(err)}`,
        severity: 'warning',
      });
    }
  }

  // Charger photo (optional)
  let chargerPhotoArtifact: PublishArtifact | null = null;
  if (charger && charger.photoFileName) {
    const chPath = path.join(process.cwd(), 'data', 'charger-photos', charger.photoFileName);
    try {
      const buf = fs.readFileSync(chPath);
      if (chargerCatalogId) {
        chargerPhotoArtifact = {
          path: `catalog/chargers/${chargerCatalogId}.photo.jpg`,
          contentType: charger.photoContentType ?? 'image/jpeg',
          contentBase64: buf.toString('base64'),
        };
      }
    } catch { /* ignore */ }
  }

  // Catalog profile JSON
  const sourceLabel = getInstanceLabel();
  const now = new Date().toISOString();
  const profileJson: CatalogProfile = {
    id: profileCatalogId,
    schemaVersion: 1,
    kind: 'profile',
    publishedAt: now,
    source: sourceLabel,
    name: safeStr(profile.name, LIMITS.MAX_NAME) ?? profile.name.slice(0, LIMITS.MAX_NAME),
    manufacturer: safeStr(profile.manufacturer, LIMITS.MAX_MFR),
    modelName: safeStr(profile.modelName, LIMITS.MAX_MODEL),
    articleNumber: safeStr(profile.articleNumber, 60),
    gtin: safeStr(profile.gtin, 30),
    productUrl: safeUrl(profile.productUrl),
    documentUrl: safeUrl(profile.documentUrl),
    targetSoc: profile.targetSoc ?? 80,
    capacityWh: profile.capacityWh ?? null,
    weightGrams: profile.weightGrams ?? null,
    chemistry: safeStr(profile.chemistry, 40),
    cellDesignation: safeStr(profile.cellDesignation, 40),
    cellConfiguration: safeStr(profile.cellConfiguration, 40),
    nominalVoltageV: profile.nominalVoltageV ?? null,
    nominalCapacityMah: profile.nominalCapacityMah ?? null,
    maxChargeCurrentA: profile.maxChargeCurrentA ?? null,
    maxChargeVoltageV: profile.maxChargeVoltageV ?? null,
    chargeTempMinC: profile.chargeTempMinC ?? null,
    chargeTempMaxC: profile.chargeTempMaxC ?? null,
    dischargeTempMinC: profile.dischargeTempMinC ?? null,
    dischargeTempMaxC: profile.dischargeTempMaxC ?? null,
    batteryFormFactor: safeStr(profile.batteryFormFactor, 40),
    replaceable: profile.replaceable ?? null,
    chargerCatalogId,
    chargerModel: safeStr(profile.chargerModel, LIMITS.MAX_MODEL),
    chargerEfficiency: profile.chargerEfficiency ?? null,
    notes: safeStr(profile.notes, LIMITS.MAX_NOTES),
    photo: photoArtifact
      ? {
          file: `${profileCatalogId}.photo.jpg`,
          contentType: photoArtifact.contentType,
          sizeBytes: Buffer.byteLength(Buffer.from(photoArtifact.contentBase64, 'base64')),
        }
      : null,
    curve: {
      pointCount: curve.pointCount,
      durationSeconds: curve.durationSeconds,
      totalEnergyWh: roundCoarse(curve.totalEnergyWh, 4),
      peakPowerW: roundCoarse(curve.peakPower, 2),
      startPowerW: roundCoarse(curve.startPower, 2),
      sha256: fullHash,
      pointsFile: `${profileCatalogId}.curve.csv`,
    },
    socBoundaries: boundaries,
  };

  const artifacts: PublishArtifact[] = [];
  artifacts.push({
    path: `catalog/profiles/${profileCatalogId}.json`,
    contentType: 'application/json',
    contentBase64: Buffer.from(JSON.stringify(profileJson, null, 2) + '\n').toString('base64'),
  });
  artifacts.push({
    path: `catalog/profiles/${profileCatalogId}.curve.csv`,
    contentType: 'text/csv',
    contentBase64: Buffer.from(csv).toString('base64'),
  });
  if (photoArtifact) artifacts.push(photoArtifact);

  // Charger JSON (only if charger linked and not already in catalog)
  if (charger && chargerCatalogId) {
    const idx = loadIndex();
    const alreadyInCatalog = idx?.chargers.some((c) => c.id === chargerCatalogId) ?? false;
    if (!alreadyInCatalog) {
      const chargerJson: CatalogCharger = {
        id: chargerCatalogId,
        schemaVersion: 1,
        kind: 'charger',
        publishedAt: now,
        source: sourceLabel,
        name: safeStr(charger.name, LIMITS.MAX_NAME) ?? charger.name.slice(0, LIMITS.MAX_NAME),
        manufacturer: safeStr(charger.manufacturer, LIMITS.MAX_MFR),
        model: safeStr(charger.model, LIMITS.MAX_MODEL),
        efficiency: roundCoarse(charger.efficiency ?? 0.85, 4),
        maxCurrentA: charger.maxCurrentA ?? null,
        maxVoltageV: charger.maxVoltageV ?? null,
        outputType: charger.outputType ?? 'DC',
        notes: safeStr(charger.notes, LIMITS.MAX_NOTES),
        photo: chargerPhotoArtifact
          ? {
              file: `${chargerCatalogId}.photo.jpg`,
              contentType: chargerPhotoArtifact.contentType,
              sizeBytes: Buffer.byteLength(Buffer.from(chargerPhotoArtifact.contentBase64, 'base64')),
            }
          : null,
      };
      artifacts.push({
        path: `catalog/chargers/${chargerCatalogId}.json`,
        contentType: 'application/json',
        contentBase64: Buffer.from(JSON.stringify(chargerJson, null, 2) + '\n').toString('base64'),
      });
      if (chargerPhotoArtifact) artifacts.push(chargerPhotoArtifact);
    }
  }

  return {
    profileId: profileCatalogId,
    chargerId: chargerCatalogId,
    issues,
    artifacts,
  };
}

// ---------------------------------------------------------------------------
// INDEX.json regeneration (from local catalog/ tree + the new artifacts)
// ---------------------------------------------------------------------------

/**
 * Read all profile + charger JSON files from local catalog/ and produce
 * an INDEX.json. Used to regenerate the index after a submission so the
 * commit batch includes a consistent index alongside the new entries.
 */
export function rebuildIndex(extraProfileJsons: CatalogProfile[] = [], extraChargerJsons: CatalogCharger[] = []): {
  schemaVersion: number;
  generatedAt: string;
  profiles: Array<Record<string, unknown>>;
  chargers: Array<Record<string, unknown>>;
} {
  const profileDir = path.join(CATALOG_DIR, 'profiles');
  const chargerDir = path.join(CATALOG_DIR, 'chargers');

  const onDiskProfiles: CatalogProfile[] = [];
  const onDiskChargers: CatalogCharger[] = [];

  try {
    for (const file of fs.readdirSync(profileDir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = fs.readFileSync(path.join(profileDir, file), 'utf8');
        onDiskProfiles.push(JSON.parse(raw) as CatalogProfile);
      } catch { /* skip */ }
    }
  } catch { /* dir missing */ }

  try {
    for (const file of fs.readdirSync(chargerDir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = fs.readFileSync(path.join(chargerDir, file), 'utf8');
        onDiskChargers.push(JSON.parse(raw) as CatalogCharger);
      } catch { /* skip */ }
    }
  } catch { /* dir missing */ }

  // Merge: extras override on-disk by id.
  const profileById = new Map<string, CatalogProfile>();
  for (const p of onDiskProfiles) profileById.set(p.id, p);
  for (const p of extraProfileJsons) profileById.set(p.id, p);

  const chargerById = new Map<string, CatalogCharger>();
  for (const c of onDiskChargers) chargerById.set(c.id, c);
  for (const c of extraChargerJsons) chargerById.set(c.id, c);

  const index = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    profiles: Array.from(profileById.values())
      .map((p) => ({
        id: p.id,
        name: p.name,
        manufacturer: p.manufacturer,
        modelName: p.modelName,
        chemistry: p.chemistry,
        capacityWh: p.capacityWh,
        targetSoc: p.targetSoc,
        pointCount: p.curve.pointCount,
        durationSeconds: p.curve.durationSeconds,
        totalEnergyWh: p.curve.totalEnergyWh,
        peakPowerW: p.curve.peakPowerW,
        chargerCatalogId: p.chargerCatalogId,
        hasPhoto: !!p.photo,
        productUrl: p.productUrl,
        source: p.source,
        publishedAt: p.publishedAt,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    chargers: Array.from(chargerById.values())
      .map((c) => ({
        id: c.id,
        name: c.name,
        manufacturer: c.manufacturer,
        model: c.model,
        maxVoltageV: c.maxVoltageV,
        maxCurrentA: c.maxCurrentA,
        outputType: c.outputType,
        efficiency: c.efficiency,
        hasPhoto: !!c.photo,
        source: c.source,
        publishedAt: c.publishedAt,
      }))
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '')),
  };
  return index;
}
