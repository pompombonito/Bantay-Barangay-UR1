import { sqliteTable, text, integer, real, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const clients = sqliteTable('desktop_clients', {
  id: text('id').primaryKey(), sequence: integer('sequence').notNull(), updatedAt: text('updated_at').notNull(),
});
export const stations = sqliteTable('stations', {
  barangay: text('barangay').primaryKey(), sourceId: text('source_id').notNull(), clientId: text('client_id').notNull(),
  label: text('label').notNull(), type: text('type').notNull(), reason: text('reason').notNull(),
  level: real('level'), temp: real('temp'), humidity: real('humidity'), quality: text('quality').notNull(),
  source: text('source').notNull(), updatedAt: text('updated_at').notNull(),
});
export const alerts = sqliteTable('alerts', {
  id: text('id').primaryKey(), barangay: text('barangay').notNull(), sourceId: text('source_id').notNull(),
  label: text('label').notNull(), type: text('type').notNull(), reason: text('reason').notNull(), source: text('source').notNull(),
  active: integer('active').notNull(), createdAt: text('created_at').notNull(), resolvedAt: text('resolved_at'),
}, (table) => [
  uniqueIndex('one_active_alert_per_barangay').on(table.barangay).where(sql`${table.active} = 1`),
  index('alerts_barangay_created').on(table.barangay, table.createdAt),
]);
export const responses = sqliteTable('responses', {
  id: text('id').primaryKey(), alertId: text('alert_id').notNull().references(() => alerts.id),
  barangay: text('barangay').notNull(), username: text('username').notNull(), decision: text('decision').notNull(),
  note: text('note').notNull(), createdAt: text('created_at').notNull(),
}, (table) => [index('responses_barangay_created').on(table.barangay, table.createdAt)]);
export const loginAttempts = sqliteTable('login_attempts', {
  key: text('key').primaryKey(), count: integer('count').notNull(), expiresAt: integer('expires_at').notNull(),
});
