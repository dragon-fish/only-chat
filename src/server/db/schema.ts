import { index, integer, sqliteTable, text, uniqueIndex, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core'
import type { Part } from '@/shared/parts'
import type {
  ModelCapabilities, ModelPricing, PersistedStatus, Protocol, SessionParams, Usage, UserSettings,
} from '@/shared/models'

export const users = sqliteTable('users', {
  id: integer().primaryKey({ autoIncrement: true }),
  name: text().notNull(),
  settings: text({ mode: 'json' }).$type<UserSettings>().notNull(),
  created_at: integer().notNull(),
})

export const providers = sqliteTable('providers', {
  id: integer().primaryKey({ autoIncrement: true }),
  user_id: integer().notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text().notNull(),
  protocol: text().$type<Protocol>().notNull(),
  base_url: text().notNull(),
  /** AES-GCM ciphertext, base64 "iv.ct"; null when no key stored. */
  api_key: text(),
  extra: text({ mode: 'json' }).$type<Record<string, unknown>>(),
  enabled: integer({ mode: 'boolean' }).notNull().default(true),
  created_at: integer().notNull(),
}, (t) => [index('providers_user_idx').on(t.user_id)])

export const models = sqliteTable('models', {
  id: integer().primaryKey({ autoIncrement: true }),
  provider_id: integer().notNull().references(() => providers.id, { onDelete: 'cascade' }),
  model_id: text().notNull(),
  display_name: text().notNull(),
  capabilities: text({ mode: 'json' }).$type<ModelCapabilities>().notNull(),
  pricing: text({ mode: 'json' }).$type<ModelPricing>(),
  enabled: integer({ mode: 'boolean' }).notNull().default(true),
  sort: integer().notNull().default(0),
}, (t) => [uniqueIndex('models_provider_model_uq').on(t.provider_id, t.model_id)])

export const sessions = sqliteTable('sessions', {
  id: integer().primaryKey({ autoIncrement: true }),
  user_id: integer().notNull().references(() => users.id, { onDelete: 'cascade' }),
  title: text().notNull(),
  head_message_id: integer(),
  provider_id: integer(),
  model_id: text(),
  system_prompt: text(),
  params: text({ mode: 'json' }).$type<SessionParams>(),
  created_at: integer().notNull(),
  updated_at: integer().notNull(),
  archived_at: integer(),
}, (t) => [index('sessions_user_updated_idx').on(t.user_id, t.updated_at)])

export const messages = sqliteTable('messages', {
  id: integer().primaryKey({ autoIncrement: true }),
  session_id: integer().notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  parent_id: integer().references((): AnySQLiteColumn => messages.id, { onDelete: 'cascade' }),
  seq: integer().notNull(),
  role: text().$type<'user' | 'assistant'>().notNull(),
  parts: text({ mode: 'json' }).$type<Part[]>().notNull(),
  provider_id: integer(),
  model_id: text(),
  usage: text({ mode: 'json' }).$type<Usage>(),
  status: text().$type<PersistedStatus>().notNull(),
  error: text(),
  created_at: integer().notNull(),
}, (t) => [
  uniqueIndex('messages_session_seq_uq').on(t.session_id, t.seq),
  index('messages_parent_idx').on(t.parent_id),
])

export const attachments = sqliteTable('attachments', {
  id: integer().primaryKey({ autoIncrement: true }),
  user_id: integer().notNull().references(() => users.id, { onDelete: 'cascade' }),
  sha256: text().notNull(),
  mime: text().notNull(),
  size: integer().notNull(),
  width: integer(),
  height: integer(),
  r2_key: text().notNull(),
  origin: text().$type<'upload' | 'generated'>().notNull(),
  created_at: integer().notNull(),
}, (t) => [uniqueIndex('attachments_user_sha_uq').on(t.user_id, t.sha256)])

export type UserRow = typeof users.$inferSelect
export type ProviderRow = typeof providers.$inferSelect
export type ModelRow = typeof models.$inferSelect
export type SessionRow = typeof sessions.$inferSelect
export type MessageRow = typeof messages.$inferSelect
export type AttachmentRow = typeof attachments.$inferSelect
