import { env } from 'cloudflare:workers'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { createDb, type DB } from '@/server/db/client'
import { models, providerInterfaces, providers } from '@/server/db/schema'
import { resolveServiceModel } from '@/server/plugins/hub/service-model'
import { createConversation, getConversation, renameIfTitleUnchanged, updateConversation } from '@/server/plugins/hub/conversations'
import type { UserSettings } from '@/shared/models'
import { ensureTestUser } from './auth-helper'

const TEXT = { modalities: { input: ['text'], output: ['text'] } } as const
const IMAGE_OUT = { modalities: { input: ['text'], output: ['image'] } } as const

async function fixture(): Promise<{ db: DB, providerId: number }> {
  const db = createDb(env.DB)
  await ensureTestUser(db)
  await db.delete(models)
  await db.delete(providerInterfaces)
  await db.delete(providers)
  const [provider] = await db.insert(providers).values({
    user_id: 1, name: 'P', api_key: 'k', enabled: true, credential_version: 1, created_at: 0,
  }).returning()
  const [iface] = await db.insert(providerInterfaces).values({
    provider_id: provider!.id, protocol: 'chat-completions', base_url: 'https://example.com/v1',
    native_files: false, created_at: 0,
  }).returning()
  await db.update(providers).set({ default_interface_id: iface!.id }).where(eq(providers.id, provider!.id))
  return { db, providerId: provider!.id }
}

async function addModel(db: DB, providerId: number, modelId: string, metadata: object, enabled = true) {
  await db.insert(models).values({
    provider_id: providerId, model_id: modelId, interface_id: null,
    metadata_resolved: metadata as never, enabled,
  })
}

const settings = (modelId: string | null, providerId: number): UserSettings => ({
  plugins: {},
  service_model: modelId === null ? null : { provider_id: providerId, model_id: modelId },
})

describe('the service model is whatever is still usable right now', () => {
  let db: DB
  let providerId: number
  beforeEach(async () => { ({ db, providerId } = await fixture()) })

  it('resolves a text model that is switched on', async () => {
    await addModel(db, providerId, 'light', TEXT)
    const resolved = await resolveServiceModel(db, 1, settings('light', providerId))
    expect(resolved?.model.model_id).toBe('light')
    expect(resolved?.providerInterface.protocol).toBe('chat-completions')
  })

  it('reads as unset when nothing was chosen', async () => {
    expect(await resolveServiceModel(db, 1, settings(null, providerId))).toBeNull()
  })

  /** The whole point of resolving at use time: a setting outlives the thing it points at. */
  it('reads as unset once the model is switched off', async () => {
    await addModel(db, providerId, 'light', TEXT)
    await db.update(models).set({ enabled: false }).where(eq(models.model_id, 'light'))
    expect(await resolveServiceModel(db, 1, settings('light', providerId))).toBeNull()
  })

  it('reads as unset once the provider is switched off', async () => {
    await addModel(db, providerId, 'light', TEXT)
    await db.update(providers).set({ enabled: false }).where(eq(providers.id, providerId))
    expect(await resolveServiceModel(db, 1, settings('light', providerId))).toBeNull()
  })

  it('reads as unset when the model is gone entirely', async () => {
    expect(await resolveServiceModel(db, 1, settings('never-existed', providerId))).toBeNull()
  })

  it('refuses a model that answers with pictures', async () => {
    await addModel(db, providerId, 'painter', IMAGE_OUT)
    expect(await resolveServiceModel(db, 1, settings('painter', providerId))).toBeNull()
  })
})

describe('a suggested name never overwrites one the user chose', () => {
  it('replaces the placeholder it was given', async () => {
    const db = createDb(env.DB)
    await ensureTestUser(db)
    const conversation = await createConversation(db, { user_id: 1, title: '占位标题', provider_id: null, model_id: null })

    const updated = await renameIfTitleUnchanged(db, conversation.id, 1, '占位标题', '解析 UTF-8 的正则')

    expect(updated?.title).toBe('解析 UTF-8 的正则')
  })

  /** The model thinks for seconds; a rename takes one. Losing it would be the worst kind of bug. */
  it('does nothing when the user renamed it while the model was thinking', async () => {
    const db = createDb(env.DB)
    await ensureTestUser(db)
    const conversation = await createConversation(db, { user_id: 1, title: '占位标题', provider_id: null, model_id: null })
    await updateConversation(db, conversation.id, 1, { title: '我自己起的名字' })

    const updated = await renameIfTitleUnchanged(db, conversation.id, 1, '占位标题', '模型起的名字')

    expect(updated).toBeUndefined()
    expect((await getConversation(db, conversation.id, 1))?.title).toBe('我自己起的名字')
  })
})
