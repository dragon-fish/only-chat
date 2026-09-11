import { env } from 'cloudflare:workers'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { createDb } from '@/server/db/client'
import { models, providerInterfaces, providers, users } from '@/server/db/schema'
import { encryptSecret } from '@/server/plugins/llm/crypto'
import { MOCK_BASE_URL } from '@/server/plugins/mock-provider/constants'
import { listMessages } from '@/server/plugins/hub/conversations'
import { ensureTestUser as seedTestUser } from './auth-helper'
import { connect } from './ws-helper'

/**
 * Exercises the whole path with no network: the mock adapter answers because the interface points at
 * the reserved `.invalid` host, while the interface keeps its real `responses` protocol.
 */
async function seedMockProvider(metadata: Record<string, unknown> = { tool_call: true }): Promise<number> {
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
  await db.insert(models).values({ provider_id: provider!.id, model_id: 'mock-tools', metadata_resolved: metadata, enabled: true, sort: 0 })
  await db.update(users).set({ settings: { plugins: { ask_user: true } } }).where(eq(users.id, 1))
  return provider!.id
}

async function send(providerId: number, text: string, conversationId?: number) {
  const c = await connect(await seedTestUser())
  c.ws.send(JSON.stringify({
    type: 'send', conversation_id: conversationId ?? null, parent_id: null, parts: [{ type: 'text', text }],
    provider_id: providerId, model_id: 'mock-tools',
    // Conversation-init fields are only accepted while creating one.
    ...(conversationId === undefined ? { tools: ['ask_user'] } : {}),
  }))
  await c.next('message.done')
  const assistant = (c.events.filter(e => e.type === 'message.created')[1] as { message: { id: number, conversation_id: number } }).message
  return listMessages(createDb(env.DB), assistant.conversation_id, 1)
}

describe('mock provider', () => {
  it('streams generated prose without reaching the network', async () => {
    const rows = await send(await seedMockProvider(), '说点什么')
    expect(rows[1]!.status).toBe('done')
    const text = rows[1]!.parts.filter(part => part.type === 'text').map(part => part.text).join('')
    expect(text.length).toBeGreaterThan(0)
    expect(rows[1]!.parts.some(part => part.type === 'tool_call')).toBe(false)
  })

  it('turns a directive into a real tool call the hub persists', async () => {
    const rows = await send(await seedMockProvider(), '/tool_call ask_user {"questions":[{"id":"q","header":"H","question":"选哪个","type":"single","options":[{"label":"A"},{"label":"B"}]}]}')
    const calls = rows[1]!.parts.filter(part => part.type === 'tool_call')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ name: 'ask_user' })
  })

  it('still calls tools on a later turn of the same conversation', async () => {
    const providerId = await seedMockProvider()
    const args = '{"questions":[{"id":"q","header":"H","question":"选哪个","type":"single","options":[{"label":"A"},{"label":"B"}]}]}'
    const first = await send(providerId, `/tool_call ask_user ${args}`)
    expect(first[1]!.parts.filter(part => part.type === 'tool_call')).toHaveLength(1)

    // The mock stops calling once THIS turn has a result; an earlier turn must not silence it.
    const conversationId = first[1]!.conversation_id
    const second = await send(providerId, `/tool_call ask_user ${args}`, conversationId)
    expect(second.at(-1)!.parts.filter(part => part.type === 'tool_call')).toHaveLength(1)
  })

  it('reproduces the parallel tool calls that a real model can emit', async () => {
    const args = '{"questions":[{"id":"q","header":"H","question":"选哪个","type":"single","options":[{"label":"A"},{"label":"B"}]}]}'
    const rows = await send(await seedMockProvider(), `/parallel [{"name":"ask_user","args":${args}},{"name":"ask_user","args":${args}}]`)
    const calls = rows[1]!.parts.filter(part => part.type === 'tool_call')
    expect(calls).toHaveLength(2)
    expect(new Set(calls.map(call => call.id)).size).toBe(2)
  })
})
