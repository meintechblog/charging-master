import { sqliteTable, text, integer, real, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core';

export const plugs = sqliteTable('plugs', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  ipAddress: text('ip_address'),
  channel: integer('channel').notNull().default(0),
  pollingInterval: integer('polling_interval').notNull().default(5),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  online: integer('online', { mode: 'boolean' }).notNull().default(false),
  lastSeen: integer('last_seen'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const powerReadings = sqliteTable('power_readings', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  plugId: text('plug_id').notNull().references(() => plugs.id),
  apower: real('apower').notNull(),
  voltage: real('voltage'),
  current: real('current'),
  output: integer('output', { mode: 'boolean' }),
  totalEnergy: real('total_energy'),
  timestamp: integer('timestamp').notNull(),
});

export const config = sqliteTable('config', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

// --- Phase 3: Charge Intelligence tables ---

export const deviceProfiles = sqliteTable('device_profiles', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  description: text('description'),
  modelName: text('model_name'),
  purchaseDate: text('purchase_date'),
  estimatedCycles: integer('estimated_cycles'),
  targetSoc: integer('target_soc').notNull().default(80),
  productUrl: text('product_url'),
  documentUrl: text('document_url'),
  manufacturer: text('manufacturer'),
  articleNumber: text('article_number'),
  gtin: text('gtin'),
  capacityWh: real('capacity_wh'),
  weightGrams: integer('weight_grams'),
  priceEur: real('price_eur'),
  priceUpdatedAt: integer('price_updated_at'),
  // --- Battery cell + chemistry ---
  chemistry: text('chemistry'),                       // 'Li-ion', 'LiFePO4', 'NiMH', 'Pb', etc.
  cellDesignation: text('cell_designation'),          // IEC code, e.g. 'INR19/66' or '18650'
  cellConfiguration: text('cell_configuration'),      // e.g. '6S2P', '13S4P'
  nominalVoltageV: real('nominal_voltage_v'),
  nominalCapacityMah: integer('nominal_capacity_mah'),
  // --- Charge spec from label ---
  maxChargeCurrentA: real('max_charge_current_a'),
  maxChargeVoltageV: real('max_charge_voltage_v'),
  chargeTempMinC: integer('charge_temp_min_c'),
  chargeTempMaxC: integer('charge_temp_max_c'),
  dischargeTempMinC: integer('discharge_temp_min_c'),
  dischargeTempMaxC: integer('discharge_temp_max_c'),
  // --- Identity / provenance ---
  serialNumber: text('serial_number'),
  productionDate: text('production_date'),            // 'YYYY-MM' or 'YYYY-MM-DD'
  countryOfOrigin: text('country_of_origin'),
  certifications: text('certifications'),             // JSON array, e.g. '["UL 62133-2","CE","PSE"]'
  // --- Lifecycle / warranty ---
  batteryFormFactor: text('battery_form_factor'),     // 'pack' | 'single-cell' | 'integrated' | 'removable'
  replaceable: integer('replaceable', { mode: 'boolean' }),
  endOfLifeCapacityPct: integer('end_of_life_capacity_pct').default(80),
  warrantyUntil: text('warranty_until'),              // 'YYYY-MM-DD'
  warrantyCycles: integer('warranty_cycles'),
  // --- Charging accessory binding ---
  // Free-text fallback for profiles without a structured charger record.
  chargerModel: text('charger_model'),
  // Per-profile efficiency override (legacy + ad-hoc). When chargerId is set,
  // the linked charger's efficiency takes precedence at render time.
  chargerEfficiency: real('charger_efficiency').default(0.85),
  // Optional reference to a shared charger entity (chargers table).
  chargerId: integer('charger_id').references((): AnySQLiteColumn => chargers.id, { onDelete: 'set null' }),
  // --- Free-form user notes (separate from description) ---
  notes: text('notes'),
  // --- JSON escape hatch for fields we haven't typed yet ---
  extra: text('extra'),                               // arbitrary JSON object
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const priceHistory = sqliteTable('price_history', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  profileId: integer('profile_id').notNull().references(() => deviceProfiles.id, { onDelete: 'cascade' }),
  priceEur: real('price_eur').notNull(),
  recordedAt: integer('recorded_at').notNull(),
});

export const chargers = sqliteTable('chargers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  manufacturer: text('manufacturer'),
  model: text('model'),
  efficiency: real('efficiency').default(0.85),       // 0..1, AC->DC ratio
  maxCurrentA: real('max_current_a'),
  maxVoltageV: real('max_voltage_v'),
  outputType: text('output_type').default('DC'),      // 'AC' | 'DC'
  notes: text('notes'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

// Snapshot of measured battery capacity at a point in time. Inserted on
// every full charge (learn save or target_soc=100 complete). Trend over
// time = degradation curve.
export const batteryHealthSnapshots = sqliteTable('battery_health_snapshots', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  profileId: integer('profile_id').notNull().references(() => deviceProfiles.id, { onDelete: 'cascade' }),
  sessionId: integer('session_id').references(() => chargeSessions.id, { onDelete: 'set null' }),
  recordedAt: integer('recorded_at').notNull(),
  totalEnergyWhAc: real('total_energy_wh_ac').notNull(),
  effectiveDcWh: real('effective_dc_wh').notNull(),     // ac * effective efficiency at time of snapshot
  efficiencyUsed: real('efficiency_used').notNull(),    // the efficiency factor applied
  peakPowerW: real('peak_power_w'),
  durationSeconds: integer('duration_seconds'),
  source: text('source').notNull(),                     // 'learn' | 'full_charge'
});

export const profilePhotos = sqliteTable('profile_photos', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  profileId: integer('profile_id').notNull().references(() => deviceProfiles.id, { onDelete: 'cascade' }),
  fileName: text('file_name').notNull(),         // on-disk filename, e.g. '42.jpeg'
  originalName: text('original_name'),           // user's original upload name
  contentType: text('content_type').notNull(),   // 'image/jpeg' | 'image/png' | 'image/webp'
  sizeBytes: integer('size_bytes').notNull(),
  isPrimary: integer('is_primary', { mode: 'boolean' }).notNull().default(false),
  caption: text('caption'),
  createdAt: integer('created_at').notNull(),
});

export const referenceCurves = sqliteTable('reference_curves', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  profileId: integer('profile_id').notNull().references(() => deviceProfiles.id, { onDelete: 'cascade' }),
  startPower: real('start_power').notNull(),
  peakPower: real('peak_power').notNull(),
  totalEnergyWh: real('total_energy_wh').notNull(),
  durationSeconds: integer('duration_seconds').notNull(),
  pointCount: integer('point_count').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const referenceCurvePoints = sqliteTable('reference_curve_points', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  curveId: integer('curve_id').notNull().references(() => referenceCurves.id, { onDelete: 'cascade' }),
  offsetSeconds: integer('offset_seconds').notNull(),
  apower: real('apower').notNull(),
  voltage: real('voltage'),
  current: real('current'),
  cumulativeWh: real('cumulative_wh').notNull(),
});

export const socBoundaries = sqliteTable('soc_boundaries', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  curveId: integer('curve_id').notNull().references(() => referenceCurves.id, { onDelete: 'cascade' }),
  soc: integer('soc').notNull(),
  offsetSeconds: integer('offset_seconds').notNull(),
  cumulativeWh: real('cumulative_wh').notNull(),
  expectedPower: real('expected_power').notNull(),
});

export const chargeSessions = sqliteTable('charge_sessions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  plugId: text('plug_id').notNull().references(() => plugs.id),
  profileId: integer('profile_id').references(() => deviceProfiles.id),
  state: text('state').notNull().default('detecting'),
  detectionConfidence: real('detection_confidence'),
  curveOffsetSeconds: integer('curve_offset_seconds'),
  targetSoc: integer('target_soc'),
  estimatedSoc: integer('estimated_soc'),
  startedAt: integer('started_at').notNull(),
  stoppedAt: integer('stopped_at'),
  stopReason: text('stop_reason'),
  energyWh: real('energy_wh'),
  // Shelly aenergy.total snapshot at session start. Immutable after write.
  // sessionWh_display = latest(totalEnergy) - startTotalEnergy, so display
  // Wh stays correct across service restarts AND SOC corrections.
  startTotalEnergy: real('start_total_energy'),
  dtwScore: real('dtw_score'),
  createdAt: integer('created_at').notNull(),
});

export const sessionReadings = sqliteTable('session_readings', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: integer('session_id').notNull().references(() => chargeSessions.id, { onDelete: 'cascade' }),
  offsetMs: integer('offset_ms').notNull(),
  apower: real('apower').notNull(),
  voltage: real('voltage'),
  current: real('current'),
  timestamp: integer('timestamp').notNull(),
});

export const sessionEvents = sqliteTable('session_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: integer('session_id').notNull().references(() => chargeSessions.id, { onDelete: 'cascade' }),
  state: text('state').notNull(),
  timestamp: integer('timestamp').notNull(),
});

// --- SOC calibration log ---
// Every time the user clicks "SOC korrigieren", we log (predicted, corrected,
// charged_wh_so_far) tied to the active session and profile. The matcher
// then applies a moving-average bias to estimatedStartSoc on future matches
// of the same profile, and the eta-recalibrator uses early corrections
// (where charged_wh ≈ 0) as ground-truth start-SOC anchors to refit the
// charger efficiency on session complete.
export const socCorrections = sqliteTable('soc_corrections', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  profileId: integer('profile_id').notNull().references(() => deviceProfiles.id, { onDelete: 'cascade' }),
  sessionId: integer('session_id').notNull().references(() => chargeSessions.id, { onDelete: 'cascade' }),
  createdAt: integer('created_at').notNull(),
  predictedSoc: integer('predicted_soc').notNull(),     // matcher's value just before user override
  correctedSoc: integer('corrected_soc').notNull(),     // user-supplied real SOC
  chargedWhAtCorrection: real('charged_wh_at_correction').notNull(),
});

// --- Phase 7: Self-update audit log ---

export const updateRuns = sqliteTable('update_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  startAt: integer('start_at', { mode: 'timestamp_ms' }).notNull(),
  endAt: integer('end_at', { mode: 'timestamp_ms' }),
  fromSha: text('from_sha').notNull(),
  toSha: text('to_sha'),
  status: text('status', {
    enum: ['running', 'success', 'failed', 'rolled_back'] as const,
  }).notNull(),
  stage: text('stage'),
  errorMessage: text('error_message'),
  rollbackStage: text('rollback_stage'),
});

export type UpdateRunRow = typeof updateRuns.$inferSelect;
export type NewUpdateRunRow = typeof updateRuns.$inferInsert;
