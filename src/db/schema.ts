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
