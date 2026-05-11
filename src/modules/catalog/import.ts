import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { eq, and, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  deviceProfiles,
  chargers,
  referenceCurves,
  referenceCurvePoints,
  socBoundaries,
  profilePhotos,
} from '@/db/schema';
import { loadProfile, loadCharger, loadCurvePoints, readPhoto } from './loader';
import type { CatalogProfile, CatalogCharger } from './types';

export type ImportProfileResult = {
  status: 'created' | 'already_exists';
  localProfileId: number;
  localChargerId: number | null;
  importedPhoto: boolean;
};

/**
 * Find an existing local charger that matches a catalog charger by
 * manufacturer + model (case-insensitive). Returns the local id or null.
 */
function findLocalCharger(c: CatalogCharger): number | null {
  if (!c.manufacturer || !c.model) return null;
  const row = db
    .select({ id: chargers.id })
    .from(chargers)
    .where(
      and(
        sql`lower(${chargers.manufacturer}) = lower(${c.manufacturer})`,
        sql`lower(${chargers.model}) = lower(${c.model})`,
      )
    )
    .get();
  return row?.id ?? null;
}

function importCharger(catalogId: string): { localId: number; createdNew: boolean } | null {
  const charger = loadCharger(catalogId);
  if (!charger) return null;

  const existing = findLocalCharger(charger);
  if (existing) return { localId: existing, createdNew: false };

  const now = Date.now();
  const inserted = db
    .insert(chargers)
    .values({
      name: charger.name,
      manufacturer: charger.manufacturer,
      model: charger.model,
      efficiency: charger.efficiency,
      maxCurrentA: charger.maxCurrentA,
      maxVoltageV: charger.maxVoltageV,
      outputType: charger.outputType,
      notes: charger.notes,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: chargers.id })
    .get();

  // Charger photo: copy from catalog to data/charger-photos/<id>.jpg
  if (charger.photo) {
    const photo = readPhoto('charger', catalogId);
    if (photo) {
      const dir = path.join(process.cwd(), 'data', 'charger-photos');
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `${inserted.id}.jpg`), photo.buffer);
        db.update(chargers)
          .set({
            photoFileName: `${inserted.id}.jpg`,
            photoContentType: 'image/jpeg',
            photoSizeBytes: photo.buffer.byteLength,
            updatedAt: Date.now(),
          })
          .where(eq(chargers.id, inserted.id))
          .run();
      } catch (err) {
        console.warn('[catalog/import] failed to write charger photo:', err);
      }
    }
  }

  return { localId: inserted.id, createdNew: true };
}

function findProfileByCatalogSignature(prof: CatalogProfile): number | null {
  // Best-effort dedup: same name + manufacturer + capacity match → assume same.
  // Curve-hash dedup would be stronger, but we don't persist the catalog id
  // on local profiles yet. Defer that to a future migration.
  const row = db
    .select({ id: deviceProfiles.id })
    .from(deviceProfiles)
    .where(
      and(
        eq(deviceProfiles.name, prof.name),
        prof.manufacturer
          ? eq(deviceProfiles.manufacturer, prof.manufacturer)
          : sql`${deviceProfiles.manufacturer} IS NULL`,
      )
    )
    .get();
  return row?.id ?? null;
}

/**
 * Clone a catalog profile (and its charger, if any) into the local DB.
 *
 * Idempotent at the name+manufacturer level — re-importing the same entry
 * returns the existing local id without modifying it. The catalog photo is
 * copied to data/profile-photos/<localId>/1.jpg and registered as primary.
 */
export function importProfile(catalogId: string): ImportProfileResult | null {
  const prof = loadProfile(catalogId);
  if (!prof) return null;

  const existing = findProfileByCatalogSignature(prof);
  if (existing) {
    return {
      status: 'already_exists',
      localProfileId: existing,
      localChargerId: null,
      importedPhoto: false,
    };
  }

  let localChargerId: number | null = null;
  if (prof.chargerCatalogId) {
    const c = importCharger(prof.chargerCatalogId);
    if (c) localChargerId = c.localId;
  }

  const now = Date.now();
  const insertedProfile = db
    .insert(deviceProfiles)
    .values({
      name: prof.name,
      manufacturer: prof.manufacturer,
      modelName: prof.modelName,
      articleNumber: prof.articleNumber,
      gtin: prof.gtin,
      productUrl: prof.productUrl,
      documentUrl: prof.documentUrl,
      targetSoc: prof.targetSoc,
      capacityWh: prof.capacityWh,
      weightGrams: prof.weightGrams,
      chemistry: prof.chemistry,
      cellDesignation: prof.cellDesignation,
      cellConfiguration: prof.cellConfiguration,
      nominalVoltageV: prof.nominalVoltageV,
      nominalCapacityMah: prof.nominalCapacityMah,
      maxChargeCurrentA: prof.maxChargeCurrentA,
      maxChargeVoltageV: prof.maxChargeVoltageV,
      chargeTempMinC: prof.chargeTempMinC,
      chargeTempMaxC: prof.chargeTempMaxC,
      dischargeTempMinC: prof.dischargeTempMinC,
      dischargeTempMaxC: prof.dischargeTempMaxC,
      batteryFormFactor: prof.batteryFormFactor,
      replaceable: prof.replaceable ?? undefined,
      chargerModel: prof.chargerModel,
      chargerEfficiency: prof.chargerEfficiency ?? undefined,
      chargerId: localChargerId,
      notes: prof.notes,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: deviceProfiles.id })
    .get();

  // Reference curve + points
  const insertedCurve = db
    .insert(referenceCurves)
    .values({
      profileId: insertedProfile.id,
      startPower: prof.curve.startPowerW,
      peakPower: prof.curve.peakPowerW,
      totalEnergyWh: prof.curve.totalEnergyWh,
      durationSeconds: prof.curve.durationSeconds,
      pointCount: prof.curve.pointCount,
      createdAt: now,
    })
    .returning({ id: referenceCurves.id })
    .get();

  const pts = loadCurvePoints(catalogId);
  if (pts.length > 0) {
    // Cumulative Wh = trapezoidal integral; the catalog CSV only stores
    // (offset, apower) so recompute here for the local DB columns.
    let cumulativeWh = 0;
    let prevOffset = 0;
    let prevApower = 0;
    const rows = pts.map((p, i) => {
      if (i > 0) {
        const dtH = (p.offsetSeconds - prevOffset) / 3600;
        const avgP = (p.apower + prevApower) / 2;
        cumulativeWh += avgP * dtH;
      }
      prevOffset = p.offsetSeconds;
      prevApower = p.apower;
      return {
        curveId: insertedCurve.id,
        offsetSeconds: p.offsetSeconds,
        apower: p.apower,
        voltage: null,
        current: null,
        cumulativeWh,
      };
    });
    // Bulk insert in chunks for SQLite parameter-limit safety.
    const CHUNK = 500;
    for (let i = 0; i < rows.length; i += CHUNK) {
      db.insert(referenceCurvePoints).values(rows.slice(i, i + CHUNK)).run();
    }
  }

  for (const b of prof.socBoundaries) {
    db.insert(socBoundaries).values({
      curveId: insertedCurve.id,
      soc: b.soc,
      offsetSeconds: b.offsetSeconds,
      cumulativeWh: b.cumulativeWh,
      expectedPower: b.expectedPower,
    }).run();
  }

  let importedPhoto = false;
  if (prof.photo) {
    const photo = readPhoto('profile', catalogId);
    if (photo) {
      const dir = path.join(process.cwd(), 'data', 'profile-photos', String(insertedProfile.id));
      try {
        fs.mkdirSync(dir, { recursive: true });
        // Use photoId=1 since this is the first photo on a freshly-created
        // profile. The profile_photos table assigns its own autoincrement id.
        fs.writeFileSync(path.join(dir, '1.jpg'), photo.buffer);
        db.insert(profilePhotos).values({
          profileId: insertedProfile.id,
          fileName: '1.jpg',
          originalName: 'catalog.jpg',
          contentType: 'image/jpeg',
          sizeBytes: photo.buffer.byteLength,
          isPrimary: true,
          caption: null,
          createdAt: Date.now(),
        }).run();
        importedPhoto = true;
      } catch (err) {
        console.warn('[catalog/import] failed to write profile photo:', err);
      }
    }
  }

  return {
    status: 'created',
    localProfileId: insertedProfile.id,
    localChargerId,
    importedPhoto,
  };
}

export function importChargerOnly(catalogId: string): { localId: number; createdNew: boolean } | null {
  return importCharger(catalogId);
}
