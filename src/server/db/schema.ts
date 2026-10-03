import { sql } from 'drizzle-orm'
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core'
import type { CatalogMatches, ModelMetadata, ModelMetadataOverride } from '@/shared/model-metadata'
import type { ArtifactRunStatus, ArtifactUsage, ImageExtraBody, ImageGenerationParams } from '@/shared/artifacts'
import type { Part } from '@/shared/parts'
import type { WorkspaceMount } from '@/shared/workspace-files'
import type { McpServerStatus, McpTransport, StoredMcpHeader } from '@/shared/mcp'
import type {
  InterfaceProtocol, PersistedStatus, ConversationParams, ConversationPluginSettings, ProjectPluginSettings, Usage, UserSettings,
} from '@/shared/models'

export const users = sqliteTable('users', {
  id: integer().primaryKey({ autoIncrement: true }),
  name: text().notNull(),
  email: text().notNull(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  image: text(),
  role: text().notNull().default('user'),
  banned: integer({ mode: 'boolean' }).notNull().default(false),
  banReason: text('ban_reason'),
  banExpires: integer('ban_expires', { mode: 'timestamp_ms' }),
  settings: text({ mode: 'json' }).$type<UserSettings>().notNull().default({ plugins: {} }),
  enabled_models_revision: integer().notNull().default(1),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, t => [uniqueIndex('users_email_unique').on(t.email)])

export const authAccounts = sqliteTable('auth_accounts', {
  id: text().primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp_ms' }),
  refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp_ms' }),
  scope: text(),
  password: text(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$onUpdate(() => new Date()),
}, t => [index('auth_accounts_user_id_idx').on(t.userId)])

export const authSessions = sqliteTable('auth_sessions', {
  id: text().primaryKey(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  token: text().notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$onUpdate(() => new Date()),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  impersonatedBy: text('impersonated_by'),
}, t => [uniqueIndex('auth_sessions_token_unique').on(t.token), index('auth_sessions_user_id_idx').on(t.userId)])

export const authVerifications = sqliteTable('auth_verifications', {
  id: text().primaryKey(),
  identifier: text().notNull(),
  value: text().notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`).$onUpdate(() => new Date()),
}, t => [index('auth_verifications_identifier_idx').on(t.identifier)])

export const siteSettings = sqliteTable('site_settings', {
  key: text().primaryKey(),
  value: text(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})

export const modelCatalogRefresh = sqliteTable('model_catalog_refresh', {
  id: integer().primaryKey(),
  owner: text(),
  expires_at: integer().notNull().default(0),
  current_version: text(),
  previous_version: text(),
  last_success_at: integer(),
  last_error: text(),
}, t => [check('model_catalog_refresh_singleton_check', sql`${t.id} = 1`)])

export const providers = sqliteTable('providers', {
  id: integer().primaryKey({ autoIncrement: true }),
  user_id: integer().notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text().notNull(),
  /** AES-GCM ciphertext, base64 "iv.ct"; null when no key stored. */
  api_key: text(),
  enabled: integer({ mode: 'boolean' }).notNull().default(true),
  default_interface_id: integer().references((): AnySQLiteColumn => providerInterfaces.id, { onDelete: 'set null' }),
  credential_version: integer().notNull().default(1),
  models_dev_provider_id: text(),
  models_dev_provider_source: text().$type<'manual' | 'endpoint'>(),
  default_image_model_id: text(),
  model_revision: integer().notNull().default(1),
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
  check('provider_interfaces_native_files_check', sql`${t.protocol} != 'vertex-compatible' OR ${t.native_files} = 0`),
])

export const models = sqliteTable('models', {
  id: integer().primaryKey({ autoIncrement: true }),
  provider_id: integer().notNull().references(() => providers.id, { onDelete: 'cascade' }),
  model_id: text().notNull(),
  // Check after the statement so deleting a provider can cascade through both models and interfaces.
  interface_id: integer().references(() => providerInterfaces.id, { onDelete: 'no action' }),
  metadata_override: text({ mode: 'json' }).$type<ModelMetadataOverride>().notNull().default({}),
  metadata_resolved: text({ mode: 'json' }).$type<ModelMetadata>().notNull().default({}),
  catalog_matches: text({ mode: 'json' }).$type<CatalogMatches>().notNull().default({ operator: null, lab: null, global: null }),
  provider_metadata: text({ mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
  /** Merged under each image run's own extra body; see `ImageExtraBodySchema`. */
  image_extra_body: text({ mode: 'json' }).$type<ImageExtraBody>().notNull().default({}),
  lab_id: text(),
  supports_image_input: integer({ mode: 'boolean' }).notNull().default(false),
  supports_reasoning: integer({ mode: 'boolean' }).notNull().default(false),
  supports_tools: integer({ mode: 'boolean' }).notNull().default(false),
  supports_image_output: integer({ mode: 'boolean' }).notNull().default(false),
  context_limit: integer(),
  output_limit: integer(),
  enabled: integer({ mode: 'boolean' }).notNull().default(true),
  manual_pinned: integer({ mode: 'boolean' }).notNull().default(true),
  upstream_available: integer({ mode: 'boolean' }),
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
  index('models_provider_lab_state_idx').on(t.provider_id, t.lab_id, t.enabled, t.upstream_available, t.id),
])

export const projects = sqliteTable('projects', {
  id: integer().primaryKey({ autoIncrement: true }),
  user_id: integer().notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text().notNull(),
  icon_attachment_id: integer().references((): AnySQLiteColumn => attachments.id, { onDelete: 'set null' }),
  system_prompt: text(),
  provider_id: integer(),
  model_id: text(),
  params: text({ mode: 'json' }).$type<ConversationParams>(),
  /** Per-plugin Project settings, keyed by plugin id and validated through `projectConfigSchema`. */
  plugin_settings: text({ mode: 'json' }).$type<ProjectPluginSettings>(),
  created_at: integer().notNull(),
  updated_at: integer().notNull(),
}, (t) => [index('projects_user_updated_idx').on(t.user_id, t.updated_at)])

export const conversations = sqliteTable('conversations', {
  id: integer().primaryKey({ autoIncrement: true }),
  user_id: integer().notNull().references(() => users.id, { onDelete: 'cascade' }),
  project_id: integer().references(() => projects.id, { onDelete: 'set null' }),
  title: text().notNull(),
  kind: text().$type<'chat' | 'image'>().notNull().default('chat'),
  head_message_id: integer(),
  provider_id: integer(),
  model_id: text(),
  image_provider_id: integer(),
  image_model_id: text(),
  system_prompt: text(),
  params: text({ mode: 'json' }).$type<ConversationParams>(),
  tools: text({ mode: 'json' }).$type<string[]>().notNull().default([]),
  /** A master switch over `tools`, so turning tools off for a while does not lose the selection. */
  tools_enabled: integer({ mode: 'boolean' }).notNull().default(true),
  /**
   * Per-plugin settings that only make sense for one conversation, keyed by plugin id. Each value
   * is whatever that plugin's `conversationConfigSchema` accepts; the core never reads inside.
   */
  plugin_settings: text({ mode: 'json' }).$type<ConversationPluginSettings>(),
  created_at: integer().notNull(),
  updated_at: integer().notNull(),
  archived_at: integer(),
}, (t) => [
  index('conversations_user_updated_idx').on(t.user_id, t.updated_at),
  index('conversations_user_kind_updated_idx').on(t.user_id, t.kind, t.updated_at),
  index('conversations_project_updated_idx').on(t.project_id, t.updated_at),
  check('conversations_kind_check', sql`${t.kind} IN ('chat', 'image')`),
])

export const messages = sqliteTable('messages', {
  id: integer().primaryKey({ autoIncrement: true }),
  conversation_id: integer().notNull().references(() => conversations.id, { onDelete: 'cascade' }),
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
  uniqueIndex('messages_conversation_seq_uq').on(t.conversation_id, t.seq),
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
 * A named, mutable pointer in the workspace filesystem. Writes never mutate a row's content: they
 * append an immutable version and advance `current_version`.
 *
 * `mount` says which mount a row belongs to; never infer it from the id columns, which cannot tell
 * `/project` from `/memory/project` or a user's memory from an orphan:
 *
 * | mount            | project_id | conversation_id                |
 * | project          | set        | null                           |
 * | conversation     | null       | set; null once orphaned        |
 * | memory/user      | null       | null                           |
 * | memory/project   | set        | null                           |
 *
 * Deleting a conversation detaches its files instead of cascading them away, and those orphans are
 * listed and reclaimed on their own. The service enforces this, not a CHECK, so the scope model can
 * change without rebuilding the table.
 */
export const workspaceFiles = sqliteTable('workspace_files', {
  id: integer().primaryKey({ autoIncrement: true }),
  user_id: integer().notNull().references(() => users.id, { onDelete: 'cascade' }),
  project_id: integer().references(() => projects.id, { onDelete: 'cascade' }),
  conversation_id: integer().references(() => conversations.id, { onDelete: 'cascade' }),
  mount: text().$type<WorkspaceMount>().notNull(),
  relative_path: text().notNull(),
  current_version: integer().notNull().default(0),
  created_at: integer().notNull(),
  updated_at: integer().notNull(),
  /** Logical deletion. Versions outlive it until attachment cleanup can reclaim the bytes. */
  deleted_at: integer(),
}, (t) => [
  // Partial, because a deleted path must be reusable. This cannot move to the service: two
  // concurrent creates would both pass an existence check and then both insert.
  uniqueIndex('workspace_files_project_path_uq').on(t.project_id, t.mount, t.relative_path).where(sql`${t.deleted_at} IS NULL AND ${t.project_id} IS NOT NULL`),
  uniqueIndex('workspace_files_conversation_path_uq').on(t.conversation_id, t.relative_path).where(sql`${t.deleted_at} IS NULL AND ${t.conversation_id} IS NOT NULL`),
  uniqueIndex('workspace_files_user_memory_path_uq').on(t.user_id, t.relative_path).where(sql`${t.deleted_at} IS NULL AND ${t.mount} = 'memory/user'`),
  index('workspace_files_project_idx').on(t.project_id, t.deleted_at),
  index('workspace_files_conversation_idx').on(t.conversation_id, t.deleted_at),
])

/** Immutable content versions. Bytes live in `attachments`/R2; this row is the pointer plus metadata. */
export const workspaceFileVersions = sqliteTable('workspace_file_versions', {
  id: integer().primaryKey({ autoIncrement: true }),
  file_id: integer().notNull().references(() => workspaceFiles.id, { onDelete: 'cascade' }),
  version: integer().notNull(),
  // Restricted rather than cascading: losing the bytes out from under a version would leave a
  // readable file that cannot be read.
  attachment_id: integer().notNull().references(() => attachments.id, { onDelete: 'restrict' }),
  mime: text().notNull(),
  file_size: integer().notNull(),
  /** `content.split('\n').length`, 0 for empty. Must match what read offsets can address. */
  total_lines: integer().notNull(),
  // Provenance is cleared, not cascaded: deleting the conversation that produced a Project file
  // must not delete the file.
  source_conversation_id: integer().references(() => conversations.id, { onDelete: 'set null' }),
  source_message_id: integer().references(() => messages.id, { onDelete: 'set null' }),
  tool_call_id: text(),
  created_at: integer().notNull(),
}, (t) => [
  uniqueIndex('workspace_file_versions_file_version_uq').on(t.file_id, t.version),
  index('workspace_file_versions_attachment_idx').on(t.attachment_id),
])

/**
 * What the memory plugin knows about a file under `/memory`: the line the catalog shows for it. What
 * the memory is about is its path, so nothing here repeats it.
 *
 * Keyed on the file rather than its path, so a rename carries the description along, a trashed
 * file drops out of the catalog through the join, and purging the file cascades this away. A file
 * under `/memory` with no row here is listed as undescribed.
 */
export const memories = sqliteTable('memories', {
  file_id: integer().primaryKey().references(() => workspaceFiles.id, { onDelete: 'cascade' }),
  user_id: integer().notNull().references(() => users.id, { onDelete: 'cascade' }),
  description: text().notNull(),
  updated_at: integer().notNull(),
})

/**
 * The memory catalog one conversation leads with, rendered once and replayed byte for byte: it sits
 * in the first user message, where any change rewrites the head of the cached prefix.
 *
 * `project_id` is the Project it was rendered for and deliberately not a foreign key. Moving the
 * conversation, or deleting the Project, has to leave it mismatched so the next turn renders anew —
 * a cascade to null would make a deleted Project's catalog look current for a loose conversation.
 */
export const memorySnapshots = sqliteTable('memory_snapshots', {
  conversation_id: integer().primaryKey().references(() => conversations.id, { onDelete: 'cascade' }),
  project_id: integer(),
  /** The layers that were open, as `scopesKey` writes them. A different set renders anew. */
  scopes: text().notNull().default(''),
  text: text().notNull(),
  /**
   * The memory files this conversation knows about, by file id: what the catalog showed, plus what
   * its own turns changed and what reminders have told it since. A difference is what it is told next.
   * Null on a snapshot rendered before this was tracked: taken as known, not as everything new.
   */
  known: text({ mode: 'json' }).$type<Record<string, KnownMemoryFile>>(),
  created_at: integer().notNull(),
})

/** One memory file as a conversation last knew it. */
export interface KnownMemoryFile {
  path: string
  version: number
  description: string | null
}

/**
 * A reminder that ends one user message: memory that changed elsewhere since the conversation last
 * knew it. Stored because history is rebuilt every turn, and the reminder has to come back with it.
 */
export const memoryNotes = sqliteTable('memory_notes', {
  message_id: integer().primaryKey().references(() => messages.id, { onDelete: 'cascade' }),
  conversation_id: integer().notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  text: text().notNull(),
})

export const artifactRuns = sqliteTable('artifact_runs', {
  id: integer().primaryKey({ autoIncrement: true }),
  user_id: integer().notNull().references(() => users.id, { onDelete: 'cascade' }),
  client_request_id: text().notNull(),
  kind: text().$type<'image_generation'>().notNull(),
  source: text().$type<'studio' | 'tool' | 'provider_tool' | 'chat_output'>().notNull(),
  operation: text().$type<'generate' | 'edit'>().notNull(),
  status: text().$type<ArtifactRunStatus>().notNull(),
  conversation_id: integer().references(() => conversations.id, { onDelete: 'set null' }),
  message_id: integer().references(() => messages.id, { onDelete: 'set null' }),
  tool_call_id: text(),
  provider_id: integer().references(() => providers.id, { onDelete: 'set null' }),
  provider_name: text().notNull(),
  interface_id: integer().references(() => providerInterfaces.id, { onDelete: 'set null' }),
  /** A provider protocol, or the protocol an `imageBackends` entry was registered under. */
  interface_protocol: text().notNull(),
  credential_version: integer().notNull(),
  model_id: text().notNull(),
  model_name: text().notNull(),
  prompt: text().notNull(),
  params: text({ mode: 'json' }).$type<ImageGenerationParams>().notNull(),
  workflow_instance_id: text().notNull(),
  /** Private to the image backend that owns the run; null for provider runs. */
  backend_state: text({ mode: 'json' }).$type<Record<string, unknown>>(),
  error: text(),
  usage: text({ mode: 'json' }).$type<ArtifactUsage>(),
  created_at: integer().notNull(),
  started_at: integer(),
  completed_at: integer(),
}, (t) => [
  uniqueIndex('artifact_runs_user_request_uq').on(t.user_id, t.client_request_id),
  uniqueIndex('artifact_runs_workflow_uq').on(t.workflow_instance_id),
  index('artifact_runs_user_status_created_idx').on(t.user_id, t.status, t.created_at, t.id),
  index('artifact_runs_conversation_idx').on(t.conversation_id, t.id),
  check('artifact_runs_kind_check', sql`${t.kind} = 'image_generation'`),
  check('artifact_runs_source_check', sql`${t.source} IN ('studio', 'tool', 'provider_tool', 'chat_output')`),
  check('artifact_runs_operation_check', sql`${t.operation} IN ('generate', 'edit')`),
  check('artifact_runs_status_check', sql`${t.status} IN ('queued', 'running', 'completed', 'failed', 'cancelled')`),
])

export const artifactRunInputs = sqliteTable('artifact_run_inputs', {
  run_id: integer().notNull().references(() => artifactRuns.id, { onDelete: 'cascade' }),
  attachment_id: integer().notNull().references(() => attachments.id, { onDelete: 'restrict' }),
  position: integer().notNull(),
}, (t) => [
  primaryKey({ columns: [t.run_id, t.position] }),
  index('artifact_run_inputs_attachment_idx').on(t.attachment_id, t.run_id),
])

export const artifacts = sqliteTable('artifacts', {
  id: integer().primaryKey({ autoIncrement: true }),
  user_id: integer().notNull().references(() => users.id, { onDelete: 'cascade' }),
  run_id: integer().notNull().references(() => artifactRuns.id, { onDelete: 'cascade' }),
  kind: text().$type<'image'>().notNull(),
  attachment_id: integer().notNull().references(() => attachments.id, { onDelete: 'restrict' }),
  output_index: integer().notNull(),
  width: integer(),
  height: integer(),
  mime: text().notNull(),
  created_at: integer().notNull(),
  deleted_at: integer(),
}, (t) => [
  uniqueIndex('artifacts_run_output_uq').on(t.run_id, t.output_index),
  index('artifacts_user_gallery_idx').on(t.user_id, t.kind, t.deleted_at, t.created_at, t.id),
  index('artifacts_attachment_idx').on(t.attachment_id, t.id),
  check('artifacts_kind_check', sql`${t.kind} = 'image'`),
])

export const artifactLinks = sqliteTable('artifact_links', {
  artifact_id: integer().notNull().references(() => artifacts.id, { onDelete: 'cascade' }),
  conversation_id: integer().notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  message_id: integer().notNull().references(() => messages.id, { onDelete: 'cascade' }),
  tool_call_id: text(),
  purpose: text().$type<'output' | 'reference'>().notNull(),
}, (t) => [
  primaryKey({ columns: [t.artifact_id, t.conversation_id, t.message_id, t.purpose] }),
  index('artifact_links_conversation_idx').on(t.conversation_id, t.artifact_id),
  index('artifact_links_message_idx').on(t.message_id, t.artifact_id),
  check('artifact_links_purpose_check', sql`${t.purpose} IN ('output', 'reference')`),
])

/**
 * One upload per row, including expired pointers awaiting cleanup. Never overwrite historical
 * references or keep upload credentials on a pointer.
 */
export const attachmentProviderFiles = sqliteTable('attachment_provider_files', {
  id: integer().primaryKey({ autoIncrement: true }),
  attachment_id: integer().notNull().references(() => attachments.id, { onDelete: 'cascade' }),
  provider_id: integer().notNull().references(() => providers.id, { onDelete: 'cascade' }),
  credential_version: integer().notNull().default(1),
  file_family: text().$type<'openai' | 'anthropic'>().notNull(),
  base_url: text().notNull(),
  provider_reference: text({ mode: 'json' }).$type<Record<string, string>>().notNull(),
  expires_at: integer().notNull(),
  cleanup_after: integer().notNull().default(0),
  cleanup_attempts: integer().notNull().default(0),
  last_cleanup_error: text(),
  created_at: integer().notNull(),
}, (t) => [
  index('attachment_provider_files_reuse_idx').on(t.attachment_id, t.provider_id, t.credential_version, t.file_family, t.base_url, t.expires_at),
  index('attachment_provider_files_cleanup_idx').on(t.cleanup_after, t.expires_at),
  index('attachment_provider_files_provider_idx').on(t.provider_id, t.id),
  check('attachment_provider_files_family_check', sql`${t.file_family} IN ('openai', 'anthropic')`),
])

/**
 * One row per configured field. `plugin_id` and `key` stay separate columns rather than one
 * "plugin:key" string so a plugin's whole configuration can be dropped by prefix and so no caller
 * can forge a namespace.
 *
 * `value` holds a JSON-encoded value for an ordinary field and the raw AES-GCM ciphertext for a
 * secret one — never a JSON string wrapping the ciphertext. Which one a key is comes from the
 * manifest, not from this table.
 */
export const pluginConfigs = sqliteTable('plugin_configs', {
  user_id: integer().notNull().references(() => users.id, { onDelete: 'cascade' }),
  plugin_id: text().notNull(),
  key: text().notNull(),
  value: text().notNull(),
  updated_at: integer().notNull(),
}, t => [primaryKey({ columns: [t.user_id, t.plugin_id, t.key] })])

/**
 * A user's remote MCP servers (spec 2026-09-29-mcp-client-design §3.1). `key` is what the model
 * addresses a server by and never changes, so renaming or re-pointing a server leaves every past
 * tool call readable. `oauth` is one AES-GCM ciphertext of the credentials the SDK asks to keep.
 * `config_version` names the current tool-list cache entry in KV: bumping it invalidates the cache
 * without a KV delete, which would take time to reach every location.
 */
export const mcpServers = sqliteTable('mcp_servers', {
  id: integer().primaryKey({ autoIncrement: true }),
  user_id: integer().notNull().references(() => users.id, { onDelete: 'cascade' }),
  key: text().notNull(),
  name: text().notNull(),
  url: text().notNull(),
  transport: text().$type<McpTransport>().notNull().default('http'),
  headers: text({ mode: 'json' }).$type<StoredMcpHeader[]>().notNull().default([]),
  enabled: integer({ mode: 'boolean' }).notNull().default(true),
  disabled_tools: text({ mode: 'json' }).$type<string[]>().notNull().default([]),
  oauth: text(),
  status: text().$type<McpServerStatus>().notNull().default('unknown'),
  last_error: text(),
  config_version: integer().notNull().default(1),
  created_at: integer().notNull(),
  updated_at: integer().notNull(),
}, t => [
  uniqueIndex('mcp_servers_user_key_uq').on(t.user_id, t.key),
  check('mcp_servers_transport_check', sql`${t.transport} IN ('http', 'sse')`),
])

export type UserRow = typeof users.$inferSelect
export type McpServerRow = typeof mcpServers.$inferSelect
export type PluginConfigRow = typeof pluginConfigs.$inferSelect
export type ProviderRow = typeof providers.$inferSelect
export type ProviderInterfaceRow = typeof providerInterfaces.$inferSelect
export type ModelRow = typeof models.$inferSelect
export type ProjectRow = typeof projects.$inferSelect
export type ConversationRow = typeof conversations.$inferSelect
export type MessageRow = typeof messages.$inferSelect
export type AttachmentRow = typeof attachments.$inferSelect
export type ArtifactRunRow = typeof artifactRuns.$inferSelect
export type ArtifactRow = typeof artifacts.$inferSelect
export type AttachmentProviderFileRow = typeof attachmentProviderFiles.$inferSelect
export type WorkspaceFileRow = typeof workspaceFiles.$inferSelect
export type WorkspaceFileVersionRow = typeof workspaceFileVersions.$inferSelect
export type MemoryRow = typeof memories.$inferSelect
