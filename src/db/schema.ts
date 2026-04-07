import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';

export const plugs = sqliteTable('plugs', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  mqttTopicPrefix: text('mqtt_topic_prefix').notNull(),
  ipAddress: text('ip_address'),
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
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const priceHistory = sqliteTable('price_history', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  profileId: integer('profile_id').notNull().references(() => deviceProfiles.id, { onDelete: 'cascade' }),
  priceEur: real('price_eur').notNull(),
  recordedAt: integer('recorded_at').notNull(),
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
