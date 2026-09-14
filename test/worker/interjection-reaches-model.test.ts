import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { describe, expect, it } from 'vitest'
import type { UserHub } from '@/server/index'
import { createDb } from '@/server/db/client'
import { models, providerInterfaces, providers, users } from '@/server/db/schema'
import { encryptSecret } from '@/server/plugins/llm/crypto'
import { MOCK_BASE_URL } from '@/server/plugins/mock-provider/constants'
import { listMessages } from '@/server/plugins/hub/conversations'
import { ensureTestUser as seedTestUser } from './auth-helper'
import { connect } from './ws-helper'

/**
 * Storing what they said mid-turn is only half of it; the model has to hear it.
 *
 * The SDK carries its own message list from one step to the next, built before the run began, so a
 * handoff that only writes the row leaves the model answering a question nobody is still asking —
 * it reads the tool result, sees no new instruction, and carries on with the old one.
 *
 * Driven through the mock's macro language, which takes its script from the newest thing the
 * operator said: if the words reached the model, the second step runs the macro they interjected
 * with. If they did not, it re-runs the first one.
 */
async function seedMockProvider(): Promise<number> {
  const db = createDb(env.DB)
  await seedTestUser(db)
  const [provider] = await db.insert(providers).values({
    user_id: 1, name: 'Mock (local)',
    api_key: await encryptSecret(env.KEY_ENCRYPTION_SECRET, 'unused'), enabled: true, created_at: 0,
  }).returning()
  const [iface] = await db.insert(providerInterfaces).values({
    provider_id: provider!.id, protocol: 'responses', base_url: MOCK_BASE_URL, native_files: false, created_at: 0,
  }).returning()
  await db.update(providers).set({ default_interface_id: iface!.id }).where(eq(providers.id, provider!.id))
  await db.insert(models).values({
    provider_id: provider!.id, model_id: 'mock-tools',
    metadata_resolved: { tool_call: true }, enabled: true, sort: 0,
  })
  await db.update(users).set({ settings: { plugins: { ask_user: true } } }).where(eq(users.id, 1))
  return provider!.id
}

describe('a message said mid-turn', () => {
  it('reaches the model, not just the database', async () => {
    const providerId = await seedMockProvider()
    const c = await connect(await seedTestUser())
    // A tool that answers at once, so the run reaches a second step — which is where a handoff can
    // happen at all. The hub exists only once a socket has opened it.
    await runInDurableObject(env.USER_HUB.getByName(String(1)), async (instance: UserHub) => {
      instance.app.tools.register('ask_user', 'echo', () => ({
        description: 'echo', inputSchema: z.object({}), execute: async () => ({ ok: true }),
      }))
    })

    // Slow enough that the interjection lands while the first step is still in the air.
    c.ws.send(JSON.stringify({
      type: 'send', conversation_id: null, parent_id: null,
      parts: [{ type: 'text', text: '/tool_call@400 echo {}' }],
      provider_id: providerId, model_id: 'mock-tools', tools: ['echo'],
    }))
    const created = await c.next('message.created') as { message: { conversation_id: number } }
    const conversationId = created.message.conversation_id

    c.ws.send(JSON.stringify({
      type: 'interject', conversation_id: conversationId,
      parts: [{ type: 'text', text: '/content 听见了' }],
    }))

    // The handoff announces the half-turn it closed, so the reply beneath their words is the second.
    await c.nextAfter('message.done', 2)
    const rows = await listMessages(createDb(env.DB), conversationId, 1)

    // The handoff wrote their words as their own message, between two replies.
    expect(rows.map(row => row.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(rows[2]!.parts).toMatchObject([{ type: 'text', text: '/content 听见了' }])

    // And the reply beneath it ran the macro they interjected with, which is only possible if the
    // model was given it.
    const said = rows[3]!.parts.filter(part => part.type === 'text').map(part => part.text).join('')
    expect(said).toContain('听见了')
  })
})
