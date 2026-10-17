import { Context, Service } from 'cordis'
import { and, eq } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import type { PluginConfigField, PluginConfigStatus, PluginManifest } from '@/shared/plugins'
import { findPluginManifest, pluginManifests } from '@/shared/plugin-manifests'
import { configFieldApplies, isKeyValueConfigKey, isSecretConfigKey, providerFitsFilter } from '@/shared/plugins'
import type { KeyValueEntry, KeyValueEntryView } from '@/shared/key-value'
import type { DB } from '../../db/client'
import { pluginConfigs, providerInterfaces, providers, type ProviderRow } from '../../db/schema'
import { providerCredentials, type ProviderCredentials } from '../llm/credentials'
import { decryptSecret, encryptSecret } from '../llm/crypto'
import { entriesView, keepSavedSecrets, openEntries, sealEntries } from '../llm/key-value-secrets'

/** `null` clears a secret; omitting the key leaves the stored value alone. */
export type PluginConfigPatch = Record<string, unknown>

/**
 * A configuration the schema accepts but the database no longer backs: a provider reference whose
 * provider was deleted, lost its key, or moved to another host. Its message is written for the
 * operator, like a schema failure's.
 */
export class PluginConfigInvalidError extends Error {}

function staleProvider(field: PluginConfigField): PluginConfigInvalidError {
  return new PluginConfigInvalidError(`${field.label}：所选供应商已删除、没有 API Key，或不再指向 ${field.provider!.host}`)
}

function manifestOrThrow(pluginId: string): PluginManifest {
  const manifest = findPluginManifest(pluginId)
  if (!manifest) throw new Error(`unknown plugin: ${pluginId}`)
  if (!manifest.configSchema) throw new Error(`plugin ${pluginId} has no configuration`)
  return manifest
}

export class PluginConfig extends Service {
  static readonly provide = 'pluginConfig'
  static readonly inject = ['db', 'env']

  private readonly _db: DB
  private readonly _secret: string

  constructor(ctx: Context) {
    super(ctx, 'pluginConfig')
    this._db = ctx.db.orm
    this._secret = ctx.env.KEY_ENCRYPTION_SECRET
  }

  /** Stored values decoded but NOT schema-parsed: an unconfigured plugin has no defaults yet. */
  private async _stored(userId: number, manifest: PluginManifest): Promise<Record<string, unknown>> {
    const rows = await this._db.select().from(pluginConfigs)
      .where(and(eq(pluginConfigs.user_id, userId), eq(pluginConfigs.plugin_id, manifest.id)))
    const out: Record<string, unknown> = {}
    for (const row of rows) {
      if (isKeyValueConfigKey(manifest, row.key)) {
        out[row.key] = await openEntries(this._secret, JSON.parse(row.value) as KeyValueEntry[])
      } else {
        out[row.key] = isSecretConfigKey(manifest, row.key)
          ? await decryptSecret(this._secret, row.value)
          : JSON.parse(row.value)
      }
    }
    return out
  }

  /** How a value is kept at rest: a secret whole, or a key-value list with its secret rows sealed. */
  private async _encode(manifest: PluginManifest, key: string, value: unknown): Promise<string> {
    if (isKeyValueConfigKey(manifest, key)) {
      return JSON.stringify(await sealEntries(this._secret, value as KeyValueEntry[]))
    }
    return isSecretConfigKey(manifest, key) ? encryptSecret(this._secret, String(value)) : JSON.stringify(value)
  }

  /** The provider a reference may name, or null when the user has none such. */
  private async _eligibleProvider(userId: number, providerId: number, field: PluginConfigField): Promise<ProviderRow | null> {
    const [provider] = await this._db.select().from(providers)
      .where(and(eq(providers.id, providerId), eq(providers.user_id, userId)))
    if (!provider) return null
    const interfaces = await this._db.select({ base_url: providerInterfaces.base_url }).from(providerInterfaces)
      .where(eq(providerInterfaces.provider_id, providerId))
    const fits = providerFitsFilter({ has_key: provider.api_key !== null, base_urls: interfaces.map(row => row.base_url) }, field.provider!)
    return fits ? provider : null
  }

  /** The first applicable provider field whose reference no longer resolves. */
  private async _staleProviderField(userId: number, manifest: PluginManifest, values: Record<string, unknown>): Promise<PluginConfigField | null> {
    for (const field of manifest.config ?? []) {
      if (field.type !== 'provider' || !configFieldApplies(field, values)) continue
      const id = values[field.key]
      if (typeof id === 'number' && !await this._eligibleProvider(userId, id, field)) return field
    }
    return null
  }

  /** Schema-valid and every reference resolving: what `read` demands. */
  private async _valid(userId: number, manifest: PluginManifest, stored: Record<string, unknown>): Promise<boolean> {
    const parsed = manifest.configSchema!.safeParse(stored)
    return parsed.success && !await this._staleProviderField(userId, manifest, parsed.data as Record<string, unknown>)
  }

  /**
   * The plugin's runtime configuration. Throws when a required field is unset or a provider it
   * names is gone — a tool must fail loudly here rather than reach the provider without a credential.
   */
  async read(userId: number, pluginId: string): Promise<Record<string, unknown>> {
    const manifest = manifestOrThrow(pluginId)
    const parsed = manifest.configSchema!.parse(await this._stored(userId, manifest)) as Record<string, unknown>
    const stale = await this._staleProviderField(userId, manifest, parsed)
    if (stale) throw staleProvider(stale)
    return parsed
  }

  /**
   * The credentials behind a `provider` field's reference, read when they are about to be used so
   * a key the provider has since rotated is the one sent.
   */
  async providerCredentials(userId: number, pluginId: string, key: string, providerId: number): Promise<ProviderCredentials> {
    const field = manifestOrThrow(pluginId).config?.find(candidate => candidate.key === key && candidate.type === 'provider')
    if (!field?.provider) throw new Error(`plugin ${pluginId} has no provider field ${key}`)
    const provider = await this._eligibleProvider(userId, providerId, field)
    const credentials = provider ? await providerCredentials(this._secret, provider) : null
    if (!credentials) throw staleProvider(field)
    return credentials
  }

  /** `read` for a plugin that may declare no configuration at all. */
  async readIfConfigurable(userId: number, pluginId: string): Promise<Record<string, unknown>> {
    return findPluginManifest(pluginId)?.configSchema ? this.read(userId, pluginId) : {}
  }

  /** Whether `read` would succeed, without decrypting more than it must. */
  async isConfigured(userId: number, pluginId: string): Promise<boolean> {
    const manifest = findPluginManifest(pluginId)
    if (!manifest?.configSchema) return true
    return this._valid(userId, manifest, await this._stored(userId, manifest))
  }

  /**
   * A patch carries only the fields the form changed, so it is merged onto what is stored before
   * the schema sees it: parsing a patch on its own would reject every edit that does not resend
   * the API key. Nothing is written unless the merged whole validates.
   */
  async write(userId: number, pluginId: string, patch: PluginConfigPatch): Promise<void> {
    const manifest = manifestOrThrow(pluginId)
    const stored = await this._stored(userId, manifest)
    const merged: Record<string, unknown> = { ...stored }
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete merged[key]
      else merged[key] = isKeyValueConfigKey(manifest, key) && Array.isArray(value)
        ? keepSavedSecrets(value as KeyValueEntryView[], stored[key] as KeyValueEntry[] | undefined)
        : value
    }
    const parsed = manifest.configSchema!.parse(merged) as Record<string, unknown>
    const stale = await this._staleProviderField(userId, manifest, parsed)
    if (stale) throw staleProvider(stale)
    const now = Date.now()
    const writes = await Promise.all(Object.entries(parsed).map(async ([key, value]) => ({
      user_id: userId,
      plugin_id: manifest.id,
      key,
      value: await this._encode(manifest, key, value),
      updated_at: now,
    })))
    // Keys the patch cleared have already left `parsed`; drop their rows so a later read does not
    // resurrect them.
    const kept = new Set(Object.keys(parsed))
    const removed = Object.keys(stored).filter(key => !kept.has(key))
    const operations: BatchItem<'sqlite'>[] = [
      ...removed.map(key => this._db.delete(pluginConfigs).where(and(
        eq(pluginConfigs.user_id, userId),
        eq(pluginConfigs.plugin_id, manifest.id),
        eq(pluginConfigs.key, key),
      ))),
      ...writes.map(row => this._db.insert(pluginConfigs).values(row).onConflictDoUpdate({
        target: [pluginConfigs.user_id, pluginConfigs.plugin_id, pluginConfigs.key],
        set: { value: row.value, updated_at: row.updated_at },
      })),
    ]
    if (operations.length === 0) return
    await this._db.batch(operations as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]])
  }

  /** Every configurable plugin's masked state, for the settings page. */
  async status(userId: number): Promise<Record<string, PluginConfigStatus>> {
    const out: Record<string, PluginConfigStatus> = {}
    for (const manifest of pluginManifests) {
      if (!manifest.configSchema) continue
      const stored = await this._stored(userId, manifest)
      const values: Record<string, unknown> = {}
      const secrets: Record<string, boolean> = {}
      const configured = await this._valid(userId, manifest, stored)
      for (const [key, value] of Object.entries(stored)) {
        if (isKeyValueConfigKey(manifest, key)) values[key] = entriesView(value as KeyValueEntry[])
        else if (isSecretConfigKey(manifest, key)) secrets[key] = String(value).length > 0
        else values[key] = value
      }
      for (const field of manifest.config ?? []) {
        if (field.type === 'secret' && secrets[field.key] === undefined) secrets[field.key] = false
      }
      out[manifest.id] = { configured, values, secrets }
    }
    return out
  }
}

export const PluginConfigPlugin = {
  name: 'plugin-config',
  async apply(ctx: Context) {
    await ctx.plugin(PluginConfig)
  },
}
