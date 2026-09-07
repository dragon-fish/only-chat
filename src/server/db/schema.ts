import { sql } from 'drizzle-orm'
import { check, index, integer, sqliteTable, text, uniqueIndex, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core'
import type { CatalogMatches, ModelMetadata, ModelMetadataOverride } from '@/shared/model-metadata'
import type { Part } from '@/shared/parts'
import type {
  InterfaceProtocol, ModelCapabilities, ModelPricing, PersistedStatus, Protocol, SessionParams, Usage, UserSettings,
} from '@/shared/models'

export const users = sqliteTable('users', {
  id: integer().primaryKey({ autoIncrement: true }),
  name: text().notNull(),
  settings: text({ mode: 'json' }).$type<UserSettings>().notNull(),
  created_at: integer().notNull(),
})

export const modelCatalogRefresh = sqliteTable('model_catalog_refresh', {
  id: integer().primaryKey(),
  owner: text(),
  expires_at: integer().notNull().default(0),
  current_version: text(),
  previous_version: text(),
}, t => [check('model_catalog_refresh_singleton_check', sql`${t.id} = 1`)])

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
  /** Supports this provider's native Files API with upload-time expiry. Custom providers default false. */
  native_files: integer({ mode: 'boolean' }).notNull().default(false),
  default_interface_id: integer().references((): AnySQLiteColumn => providerInterfaces.id, { onDelete: 'set null' }),
  credential_version: integer().notNull().default(1),
  models_dev_provider_id: text(),
  models_dev_provider_source: text().$type<'manual' | 'endpoint'>(),
  created_at: integer().notNull(),
}, (t) => [index('providers_user_idx').on(t.user_id)])

export const providerInterfaces = sqliteTable('provider_interfaces', {
  id: integer().primaryKey({ autoIncrement: true }),
  provider_id: integer().notNull().references(() => providers.id, { onDelete: 'cascade' }),
  protocol: text().$type<InterfaceProtocol>().notNull(),
  base_url: text().notNull(),
  native_files: integer({ mode: 'boolean' }).notNull().default(false),
  created_at: integer().notNull(),
}, (t) => [
  uniqueIndex('provider_interfaces_provider_protocol_uq').on(t.provider_id, t.protocol),
  check('provider_interfaces_protocol_check', sql`${t.protocol} IN ('responses', 'chat-completions', 'anthropic', 'vertex-compatible')`),
  check('provider_interfaces_native_files_check', sql`${t.protocol} != 'vertex-compatible' OR ${t.native_files} = 0`),
])

export const models = sqliteTable('models', {
  id: integer().primaryKey({ autoIncrement: true }),
  provider_id: integer().notNull().references(() => providers.id, { onDelete: 'cascade' }),
  model_id: text().notNull(),
  display_name: text().notNull(),
  capabilities: text({ mode: 'json' }).$type<ModelCapabilities>().notNull(),
  pricing: text({ mode: 'json' }).$type<ModelPricing>(),
  // Check after the statement so deleting a provider can cascade through both models and interfaces.
  interface_id: integer().references(() => providerInterfaces.id, { onDelete: 'no action' }),
  metadata_override: text({ mode: 'json' }).$type<ModelMetadataOverride>().notNull().default({}),
  metadata_resolved: text({ mode: 'json' }).$type<ModelMetadata>().notNull().default({}),
  catalog_matches: text({ mode: 'json' }).$type<CatalogMatches>().notNull().default({ operator: null, lab: null, global: null }),
  search_name: text().notNull().default(''),
  lab_id: text(),
  supports_image_input: integer({ mode: 'boolean' }).notNull().default(false),
  supports_reasoning: integer({ mode: 'boolean' }).notNull().default(false),
  supports_tools: integer({ mode: 'boolean' }).notNull().default(false),
  supports_image_output: integer({ mode: 'boolean' }).notNull().default(false),
  context_limit: integer(),
  output_limit: integer(),
  enabled: integer({ mode: 'boolean' }).notNull().default(true),
  sort: integer().notNull().default(0),
}, (t) => [
  uniqueIndex('models_provider_model_uq').on(t.provider_id, t.model_id),
  index('models_provider_enabled_sort_idx').on(t.provider_id, t.enabled, t.sort, t.id),
  index('models_enabled_image_idx').on(t.enabled, t.supports_image_input, t.sort, t.id),
  index('models_enabled_reasoning_idx').on(t.enabled, t.supports_reasoning, t.sort, t.id),
  index('models_enabled_tools_idx').on(t.enabled, t.supports_tools, t.sort, t.id),
  index('models_enabled_image_output_idx').on(t.enabled, t.supports_image_output, t.sort, t.id),
  index('models_enabled_context_idx').on(t.enabled, t.context_limit),
  index('models_interface_idx').on(t.interface_id),
  index('models_lab_enabled_sort_idx').on(t.lab_id, t.enabled, t.sort, t.id),
])

export const projects = sqliteTable('projects', {
  id: integer().primaryKey({ autoIncrement: true }),
  user_id: integer().notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text().notNull(),
  system_prompt: text(),
  provider_id: integer(),
  model_id: text(),
  params: text({ mode: 'json' }).$type<SessionParams>(),
  created_at: integer().notNull(),
  updated_at: integer().notNull(),
}, (t) => [index('projects_user_updated_idx').on(t.user_id, t.updated_at)])

export const sessions = sqliteTable('sessions', {
  id: integer().primaryKey({ autoIncrement: true }),
  user_id: integer().notNull().references(() => users.id, { onDelete: 'cascade' }),
  project_id: integer().references(() => projects.id, { onDelete: 'set null' }),
  title: text().notNull(),
  head_message_id: integer(),
  provider_id: integer(),
  model_id: text(),
  system_prompt: text(),
  params: text({ mode: 'json' }).$type<SessionParams>(),
  created_at: integer().notNull(),
  updated_at: integer().notNull(),
  archived_at: integer(),
}, (t) => [
  index('sessions_user_updated_idx').on(t.user_id, t.updated_at),
  index('sessions_project_updated_idx').on(t.project_id, t.updated_at),
])

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

/**
 * One upload per row, including expired pointers awaiting cleanup. Never overwrite historical
 * references. A null family identifies legacy pointers that allow local cleanup only.
 */
export const attachmentProviderFiles = sqliteTable('attachment_provider_files', {
  id: integer().primaryKey({ autoIncrement: true }),
  attachment_id: integer().notNull().references(() => attachments.id, { onDelete: 'cascade' }),
  provider_id: integer().notNull().references(() => providers.id, { onDelete: 'cascade' }),
  credential_version: integer().notNull().default(1),
  file_family: text().$type<'openai' | 'anthropic'>(),
  base_url: text(),
  provider_reference: text({ mode: 'json' }).$type<Record<string, string>>().notNull(),
  expires_at: integer().notNull(),
  cleanup_after: integer().notNull().default(0),
  cleanup_attempts: integer().notNull().default(0),
  last_cleanup_error: text(),
  created_at: integer().notNull(),
}, (t) => [
  index('attachment_provider_files_reuse_idx').on(t.attachment_id, t.provider_id, t.credential_version, t.file_family, t.base_url, t.expires_at),
  index('attachment_provider_files_cleanup_idx').on(t.cleanup_after, t.expires_at),
  index('attachment_provider_files_expiry_idx').on(t.expires_at),
])

export type UserRow = typeof users.$inferSelect
export type ProviderRow = typeof providers.$inferSelect
export type ProviderInterfaceRow = typeof providerInterfaces.$inferSelect
export type ModelRow = typeof models.$inferSelect
export type ProjectRow = typeof projects.$inferSelect
export type SessionRow = typeof sessions.$inferSelect
export type MessageRow = typeof messages.$inferSelect
export type AttachmentRow = typeof attachments.$inferSelect
export type AttachmentProviderFileRow = typeof attachmentProviderFiles.$inferSelect
