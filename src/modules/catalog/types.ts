/**
 * Shared types for the read-only profile catalog stored under `catalog/`
 * at the repo root. Files arrive on each box via self-update (git reset),
 * so the on-disk layout is the source of truth.
 */

export type CatalogPhoto = {
  file: string;
  contentType: string;
  sizeBytes: number;
};

export type CatalogSocBoundary = {
  soc: number;
  offsetSeconds: number;
  cumulativeWh: number;
  expectedPower: number;
};

export type CatalogCharger = {
  id: string;
  schemaVersion: number;
  kind: 'charger';
  publishedAt: string;
  source: string;
  name: string;
  manufacturer: string | null;
  model: string | null;
  efficiency: number;
  maxCurrentA: number | null;
  maxVoltageV: number | null;
  outputType: string;
  notes: string | null;
  photo: CatalogPhoto | null;
};

export type CatalogProfile = {
  id: string;
  schemaVersion: number;
  kind: 'profile';
  publishedAt: string;
  source: string;
  name: string;
  manufacturer: string | null;
  modelName: string | null;
  articleNumber: string | null;
  gtin: string | null;
  productUrl: string | null;
  documentUrl: string | null;
  targetSoc: number;
  capacityWh: number | null;
  weightGrams: number | null;
  chemistry: string | null;
  cellDesignation: string | null;
  cellConfiguration: string | null;
  nominalVoltageV: number | null;
  nominalCapacityMah: number | null;
  maxChargeCurrentA: number | null;
  maxChargeVoltageV: number | null;
  chargeTempMinC: number | null;
  chargeTempMaxC: number | null;
  dischargeTempMinC: number | null;
  dischargeTempMaxC: number | null;
  batteryFormFactor: string | null;
  replaceable: boolean | null;
  chargerCatalogId: string | null;
  chargerModel: string | null;
  chargerEfficiency: number | null;
  notes: string | null;
  photo: CatalogPhoto | null;
  curve: {
    pointCount: number;
    durationSeconds: number;
    totalEnergyWh: number;
    peakPowerW: number;
    startPowerW: number;
    sha256: string;
    pointsFile: string;
  };
  socBoundaries: CatalogSocBoundary[];
};

export type CatalogIndexProfile = {
  id: string;
  name: string;
  manufacturer: string | null;
  modelName: string | null;
  chemistry: string | null;
  capacityWh: number | null;
  targetSoc: number;
  pointCount: number;
  durationSeconds: number;
  totalEnergyWh: number;
  peakPowerW: number;
  chargerCatalogId: string | null;
  hasPhoto: boolean;
  productUrl: string | null;
  source: string;
  publishedAt: string;
};

export type CatalogIndexCharger = {
  id: string;
  name: string;
  manufacturer: string | null;
  model: string | null;
  maxVoltageV: number | null;
  maxCurrentA: number | null;
  outputType: string;
  efficiency: number;
  hasPhoto: boolean;
  source: string;
  publishedAt: string;
};

export type CatalogIndex = {
  schemaVersion: number;
  generatedAt: string;
  profiles: CatalogIndexProfile[];
  chargers: CatalogIndexCharger[];
};

export type CurvePoint = { offsetSeconds: number; apower: number };

export type CatalogMatch = {
  catalogId: string;
  name: string;
  manufacturer: string | null;
  modelName: string | null;
  similarity: number; // 0..1
  peakRatio: number; // queryPeak / catalogPeak
};
