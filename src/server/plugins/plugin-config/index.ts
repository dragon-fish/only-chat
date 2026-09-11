import { Context, Service } from 'cordis'
import { and, eq } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import type { PluginConfigStatus, PluginManifest } from '@/shared/plugins'
import { findPluginManifest, pluginManifests } from '@/shared/plugin-manifests'
import { isSecretConfigKey } from '@/shared/plugins'
import type { DB } from '../../db/client'
import { pluginConfigs } from '../../db/schema'
import { decryptSecret, encryptSecret } from '../llm/crypto'

/** `null` clears a secret; omitting the key leaves the stored value alone. */
export type PluginConfigPatch = Record<string, unknown>

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
      out[row.key] = isSecretConfigKey(manifest, row.key)
        ? await decryptSecret(this._secret, row.value)
        : JSON.parse(row.value)
    }
    return out
  }

  /**
   * The plugin's runtime configuration. Throws when a required field is unset — a tool must fail
   * loudly here rather than reach the provider with a missing credential.
   */
  async read(userId: number, pluginId: string): Promise<Record<string, unknown>> {
    const manifest = manifestOrThrow(pluginId)
    return manifest.configSchema!.parse(await this._stored(userId, manifest)) as Record<string, unknown>
  }

  /** `read` for a plugin that may declare no configuration at all. */
  async readIfConfigurable(userId: number, pluginId: string): Promise<Record<string, unknown>> {
    return findPluginManifest(pluginId)?.configSchema ? this.read(userId, pluginId) : {}
  }

  /** Whether `read` would succeed, without decrypting more than it must. */
  async isConfigured(userId: number, pluginId: string): Promise<boolean> {
    const manifest = findPluginManifest(pluginId)
    if (!manifest?.configSchema) return true
    return manifest.configSchema.safeParse(await this._stored(userId, manifest)).success
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
      else merged[key] = value
    }
    const parsed = manifest.configSchema!.parse(merged) as Record<string, unknown>
    const now = Date.now()
    const writes = await Promise.all(Object.entries(parsed).map(async ([key, value]) => ({
      user_id: userId,
      plugin_id: manifest.id,
      key,
      value: isSecretConfigKey(manifest, key)
        ? await encryptSecret(this._secret, String(value))
        : JSON.stringify(value),
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
      const configured = manifest.configSchema.safeParse(stored).success
      for (const [key, value] of Object.entries(stored)) {
        if (isSecretConfigKey(manifest, key)) secrets[key] = String(value).length > 0
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
