import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WsEventSchema, type WsCommand, type WsEvent } from '@/shared/ws'
import { DemoBackend } from '@/client/demo/backend'
import * as script from '@/client/demo/script'

function sendCommand(text: string, conversationId: number | null, parentId: number | null): WsCommand {
  return {
    type: 'send', request_id: crypto.randomUUID(), conversation_id: conversationId, parent_id: parentId,
    parts: [{ type: 'text', text }], provider_id: script.PROVIDER_ID, model_id: script.DEFAULT_MODEL_ID,
    project_id: null, system_prompt: null, params: null, conversation_provider_id: null, conversation_model_id: null,
    tools: ['web_search'], tools_enabled: true,
  }
}

describe('demo backend', () => {
  let backend: DemoBackend
  let events: WsEvent[]

  beforeEach(() => {
    vi.useFakeTimers()
    backend = new DemoBackend()
    events = []
    backend.attach(event => events.push(event))
  })
  afterEach(() => { vi.useRealTimers() })

  const heads = () => events.filter(event => event.type === 'head.changed').map(event => event.message_id)
  const created = () => events.flatMap(event => event.type === 'message.created' ? [event.message] : [])

  it('plays the whole tour with frames the client schema accepts', async () => {
    // The client drops a frame that fails WsEventSchema with only a console warning, so a
    // malformed scripted frame would silently freeze the tour mid-stream.
    backend.receive(sendCommand(script.TOUR_QUESTION, null, null))
    await vi.runAllTimersAsync()
    const [user, first] = created()
    backend.receive({ type: 'regenerate', message_id: first!.id })
    await vi.runAllTimersAsync()
    backend.receive({ type: 'switch_head', conversation_id: script.TOUR_CONVERSATION_ID, message_id: first!.id })
    backend.receive(sendCommand(script.ENDING_QUESTION, script.TOUR_CONVERSATION_ID, first!.id))
    await vi.runAllTimersAsync()

    for (const event of events) expect(WsEventSchema.safeParse(event).success, JSON.stringify(event)).toBe(true)
    expect(user!.role).toBe('user')
    expect(events.filter(event => event.type === 'message.done').map(event => event.type === 'message.done' && event.status)).toEqual(['done', 'done', 'done'])
  })

  it('grows a sibling on regenerate and moves the head on switch', async () => {
    backend.receive(sendCommand(script.TOUR_QUESTION, null, null))
    await vi.runAllTimersAsync()
    const [user, first] = created()
    backend.receive({ type: 'regenerate', message_id: first!.id })
    await vi.runAllTimersAsync()
    const second = created()[2]!

    expect(second.parent_id).toBe(user!.id)
    expect(second.seq).toBeGreaterThan(first!.seq)
    expect(heads().at(-1)).toBe(second.id)

    backend.receive({ type: 'switch_head', conversation_id: script.TOUR_CONVERSATION_ID, message_id: first!.id })
    expect(heads().at(-1)).toBe(first!.id)
  })

  it('stores what it streamed, so a reload mid-tour matches the socket', async () => {
    backend.receive(sendCommand(script.TOUR_QUESTION, null, null))
    await vi.runAllTimersAsync()
    const messages = backend.routes().find(route => route.path.test(`/api/conversations/${script.TOUR_CONVERSATION_ID}/messages`))!
      .handle({ method: 'GET', path: '', query: new URLSearchParams(), match: ['', String(script.TOUR_CONVERSATION_ID)] as unknown as RegExpMatchArray }) as Array<{ status: string, parts: Array<{ type: string, text?: string }> }>

    expect(messages.at(-1)!.status).toBe('done')
    expect(messages.at(-1)!.parts.map(part => part.type)).toEqual(['reasoning', 'tool_call', 'tool_result', 'reasoning', 'text'])
    expect(messages.at(-1)!.parts.at(-1)!.text).toBe((script.TOUR_ANSWER.at(-1) as { text: string }).text)
  })

  it('refuses anything off the script instead of improvising', () => {
    backend.receive(sendCommand('随便聊聊', null, null))
    backend.receive({ type: 'conversation.delete', conversation_id: script.ATTACHMENT_CONVERSATION_ID })

    expect(events.slice(1).map(event => event.type)).toEqual(['error', 'error'])
  })
})
