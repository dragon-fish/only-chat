import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { expect, it } from 'vitest'
import type { UserHub } from '@/server/index'
import { createDb } from '@/server/db/client'
import { models, providerInterfaces, providers, users } from '@/server/db/schema'
import { getUser } from '@/server/plugins/hub/conversations'
import { resolveFileUnderstanding } from '@/server/plugins/hub/file-understanding'
import { ensureTestUser } from './auth-helper'
import { connect } from './ws-helper'

it('saves file settings without overwriting other slots and rejects a text-only model', async () => {
  const db = createDb(env.DB)
  await connect(await ensureTestUser())
  const [provider] = await db.insert(providers).values({ user_id: 1, name: 'file service', enabled: true, created_at: 0 }).returning()
  const [iface] = await db.insert(providerInterfaces).values({ provider_id: provider!.id, protocol: 'responses', base_url: 'https://example.test', native_files: false, created_at: 0 }).returning()
  await db.update(providers).set({ default_interface_id: iface!.id }).where(eq(providers.id, provider!.id))
  for (const [model_id, input] of [['text', ['text']], ['vision', ['text', 'image']]] as const) {
    await db.insert(models).values({ provider_id: provider!.id, model_id, enabled: true, metadata_resolved: { modalities: { input: [...input], output: ['text'] } } })
  }
  const text = { provider_id: provider!.id, model_id: 'text' }
  const vision = { provider_id: provider!.id, model_id: 'vision' }
  await db.update(users).set({ settings: { plugins: {}, service_models: { text }, service_prompts: { conversation_title: 'Name: {user_message:1}' } } }).where(eq(users.id, 1))
  await runInDurableObject(env.USER_HUB.getByName('1'), async (instance: UserHub) => {
    await expect(instance.app.hub.settingsUpdate({ service_models: { file_understanding: text } })).rejects.toThrow('file understanding model not found')
    await instance.app.hub.settingsUpdate({ service_models: { file_understanding: vision }, service_prompts: { file_understanding: 'Describe in detail.' } })
    const settings = (await getUser(db, 1))!.settings
    expect(settings.service_models).toEqual({ text, file_understanding: vision })
    expect(settings.service_prompts).toEqual({ conversation_title: 'Name: {user_message:1}', file_understanding: 'Describe in detail.' })
    const deps = { db, userId: 1, llm: instance.app.llm, assets: instance.app.assets }
    const service = await resolveFileUnderstanding(deps, settings)
    expect(service?.canRead('image/png')).toBe(true)
    expect(service?.canRead('application/pdf')).toBe(false)
    await expect(service!.analyze(999999, undefined, AbortSignal.abort())).rejects.toBeDefined()
    expect(await resolveFileUnderstanding({ ...deps, userId: 99999 }, settings)).toBeUndefined()
    await db.update(models).set({ enabled: false }).where(eq(models.model_id, 'vision'))
    expect(await resolveFileUnderstanding(deps, settings)).toBeUndefined()
    // The running turn keeps the resolved model snapshot.
    expect(service?.canRead('image/png')).toBe(true)
  })
})
