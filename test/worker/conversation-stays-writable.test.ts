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
 * The floor, stated once and checked against every way a turn can end.
 *
 * Wasting a turn is acceptable. Wasting a tool result is acceptable. A conversation that can never
 * be written to again is not — and it is the failure this codebase has produced three separate
 * times, each from a different direction: a guard that demanded success where terminal would do, a
 * call nothing could answer, a result that arrived too late to be stored. The shapes below are
 * those, plus the ones next to them.
 *
 * Driven through the real path rather than by seeding rows: the bug was never in the shape of the
 * data, it was in what the hub refused to do with it.
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

interface Sent { conversationId: number, errors: string[] }

async function send(providerId: number, text: string, conversationId?: number): Promise<Sent> {
  const c = await connect(await seedTestUser())
  c.ws.send(JSON.stringify({
    type: 'send', conversation_id: conversationId ?? null, parent_id: null, parts: [{ type: 'text', text }],
    provider_id: providerId, model_id: 'mock-tools',
    ...(conversationId === undefined ? { tools: ['ask_user'] } : {}),
  }))
  await c.next('message.done')
  const created = c.events.filter(e => e.type === 'message.created') as Array<{ message: { conversation_id: number } }>
  return {
    conversationId: conversationId ?? created[0]!.message.conversation_id,
    errors: (c.events.filter(e => e.type === 'error') as Array<{ message: string }>).map(e => e.message),
  }
}

/** Every shape a finished turn can leave behind, named by how it got there. */
const ENDINGS: Array<{ name: string, directive: string }> = [
  { name: 'a turn that simply answered', directive: '说点什么' },
  { name: 'a turn that failed upstream', directive: '/error 上游炸了' },
  {
    name: 'a question still waiting on a person',
    directive: '/tool_call ask_user {"questions":[{"id":"q","header":"H","question":"选哪个","type":"single","options":[{"label":"A"},{"label":"B"}]}]}',
  },
  {
    name: 'a question too malformed to ask, which repair could not fix',
    directive: '/tool_call ask_user {"questions":[]}',
  },
  { name: 'a call to a tool the model was never given', directive: '/tool_call list_files {}' },
  { name: 'several calls at once, none of them available', directive: '/parallel [{"name":"nope"},{"name":"also_nope"}]' },
  { name: 'a turn that said nothing at all', directive: '/tool_call ask_user {"questions":[{"id":"q","header":"H","question":"问","type":"single","options":[{"label":"A"},{"label":"B"}]}]}\n/content 5' },
]

describe('a conversation stays writable', () => {
  for (const { name, directive } of ENDINGS) {
    it(`after ${name}`, async () => {
      const providerId = await seedMockProvider()
      const first = await send(providerId, directive)
      expect(first.errors).toEqual([])

      // The floor: whatever that left behind, the next message goes through.
      const second = await send(providerId, '接着说', first.conversationId)
      expect(second.errors).toEqual([])

      const rows = await listMessages(createDb(env.DB), first.conversationId, 1)
      const said = rows.filter(row => row.role === 'user')
      expect(said.length).toBeGreaterThanOrEqual(2)
      expect(said.at(-1)!.parts).toMatchObject([{ type: 'text', text: '接着说' }])
    })
  }
})
