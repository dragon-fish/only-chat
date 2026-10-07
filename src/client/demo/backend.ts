import type { Conversation, Message } from '@/shared/models'
import type { WsCommand, WsEvent } from '@/shared/ws'
import type { FakeRoute } from './fake-fetch'
import type { SocketPeer } from './fake-socket'
import { assistantFrames, assistantShell, type Timed, type TurnStep } from './stream'
import * as script from './script'

export type BackendSignal = 'turn-start' | 'turn-done' | 'switched'

/**
 * The demo's stand-in for the server: the REST answers, and the hub's side of the socket.
 *
 * It only knows the turns the tour scripts. State is kept as the hub would persist it, so a REST
 * reload in the middle of the tour returns what the socket already showed.
 */
export class DemoBackend implements SocketPeer {
  private readonly conversations = new Map<number, Conversation>()
  private readonly messages = new Map<number, Message[]>()
  private emit: (event: WsEvent) => void = () => {}
  private nextMessageId = 2001
  private timer: ReturnType<typeof setTimeout> | undefined
  private playing: { conversationId: number; messageId: number } | null = null
  private alternatives = 0
  private ended = false
  private readonly listeners = new Set<(signal: BackendSignal) => void>()

  constructor() {
    for (const conversation of script.CONVERSATIONS) this.conversations.set(conversation.id, structuredClone(conversation))
    for (const message of script.MESSAGES) this.messagesOf(message.conversation_id).push(structuredClone(message))
  }

  on(listener: (signal: BackendSignal) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  attach(emit: (event: WsEvent) => void): void {
    this.emit = emit
    emit({ type: 'snapshot', inflight: this.playing ? [this.find(this.playing.messageId)!] : [], compacting: [] })
  }

  receive(command: WsCommand): void {
    switch (command.type) {
      case 'send': return this.onSend(command)
      case 'regenerate': return this.onRegenerate(command.message_id)
      case 'switch_head': return this.onSwitchHead(command.conversation_id, command.message_id)
      case 'stop': return this.onStop()
      case 'conversation.update': return this.onConversationUpdate(command)
      default: return this.refuse('演示模式不支持该操作')
    }
  }

  routes(): FakeRoute[] {
    return [
      { method: 'GET', path: /^\/api\/auth\/get-session$/, handle: () => script.SESSION },
      { method: 'POST', path: /^\/api\/auth\/get-session$/, handle: () => script.SESSION },
      { method: 'GET', path: /^\/api\/me$/, handle: () => script.ME },
      { method: 'GET', path: /^\/api\/site-config$/, handle: () => script.SITE_CONFIG },
      { method: 'GET', path: /^\/api\/conversations$/, handle: () => [...this.conversations.values()].sort((a, b) => b.updated_at - a.updated_at) },
      { method: 'GET', path: /^\/api\/conversations\/(\d+)\/messages$/, handle: ({ match }) => this.messagesOf(Number(match[1])) },
      { method: 'GET', path: /^\/api\/projects$/, handle: () => script.PROJECTS },
      { method: 'GET', path: /^\/api\/providers$/, handle: () => script.PROVIDERS },
      { method: 'GET', path: /^\/api\/providers\/\d+\/models\/by-ref$/, handle: ({ query }) => script.MODELS.find(model => model.model_id === query.get('model_id')) ?? null },
      { method: 'GET', path: /^\/api\/models\/summary$/, handle: () => ({ models: script.MODEL_LIST }) },
      { method: 'GET', path: /^\/api\/model-catalog\/providers$/, handle: () => [] },
      { method: 'GET', path: /^\/api\/plugins\/file_reader\/conversations\/\d+\/assets$/, handle: () => ({ assets: [] }) },
    ]
  }

  /** The skip path: a conversation of its own that opens straight onto the closing reply. */
  playSkipEnding(): Conversation {
    this.onStop()
    const at = Date.now()
    const conversation: Conversation = { ...structuredClone(script.CONVERSATIONS[0]!), id: script.SKIP_CONVERSATION_ID, title: script.ENDING_QUESTION, head_message_id: null, created_at: at, updated_at: at }
    this.conversations.set(conversation.id, conversation)
    this.publish({ type: 'conversation.created', conversation })
    this.turn(conversation.id, [{ type: 'text', text: script.ENDING_QUESTION }], script.ENDING_ANSWER)
    this.ended = true
    return conversation
  }

  private onSend(command: Extract<WsCommand, { type: 'send' }>): void {
    const text = command.parts.find(part => part.type === 'text')?.text.trim()
    if (this.ended) return this.refuse('演示已经结束，点上面的链接重新开始吧', command.request_id)
    if (text === script.TOUR_QUESTION && command.conversation_id === null) {
      const at = Date.now()
      const conversation: Conversation = {
        ...structuredClone(script.CONVERSATIONS[0]!), id: script.TOUR_CONVERSATION_ID, title: text.slice(0, 40),
        head_message_id: null, tools: command.tools ?? [], tools_enabled: command.tools_enabled ?? true, created_at: at, updated_at: at,
      }
      this.conversations.set(conversation.id, conversation)
      this.publish({ type: 'conversation.created', conversation })
      return this.turn(conversation.id, command.parts, script.TOUR_ANSWER)
    }
    if (text === script.ENDING_QUESTION && command.conversation_id === script.TOUR_CONVERSATION_ID) {
      this.ended = true
      return this.turn(command.conversation_id, command.parts, script.ENDING_ANSWER)
    }
    this.refuse('演示模式只能按引导操作', command.request_id)
  }

  private onRegenerate(messageId: number): void {
    const original = this.find(messageId)
    if (!original || original.conversation_id !== script.TOUR_CONVERSATION_ID || this.playing || this.ended) return this.refuse('演示模式不支持该操作')
    const steps = this.alternatives++ % 2 === 0 ? script.TOUR_ALTERNATIVE : script.TOUR_ANSWER
    this.reply(original.conversation_id, original.parent_id!, steps)
  }

  private onSwitchHead(conversationId: number, messageId: number): void {
    const conversation = this.conversations.get(conversationId)
    if (!conversation || !this.find(messageId)) return this.refuse('演示模式不支持该操作')
    this.moveHead(conversation, messageId)
    this.signal('switched')
  }

  private onStop(): void {
    if (!this.playing) return
    clearTimeout(this.timer)
    const { messageId } = this.playing
    this.playing = null
    this.publish({ type: 'message.done', message_id: messageId, status: 'aborted', usage: null, error: null })
    this.signal('turn-done')
  }

  private onConversationUpdate(command: Extract<WsCommand, { type: 'conversation.update' }>): void {
    const conversation = this.conversations.get(command.conversation_id)
    if (!conversation) return this.refuse('演示模式不支持该操作')
    const { type: _type, conversation_id: _id, request_id: _request, ...fields } = command
    Object.assign(conversation, Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)), { updated_at: Date.now() })
    this.publish({ type: 'conversation.updated', conversation: structuredClone(conversation) })
  }

  /** A user message and the reply to it, in the order the hub reserves them. */
  private turn(conversationId: number, parts: Message['parts'], steps: TurnStep[]): void {
    const conversation = this.conversations.get(conversationId)!
    const id = this.nextMessageId++
    const user: Message = {
      id, conversation_id: conversationId, parent_id: conversation.head_message_id, seq: id,
      role: 'user', parts, provider_id: null, model_id: null, usage: null, status: 'done', error: null, notes: null, created_at: Date.now(),
    }
    this.messagesOf(conversationId).push(user)
    this.publish({ type: 'message.created', message: structuredClone(user) })
    this.moveHead(conversation, user.id)
    this.reply(conversationId, user.id, steps)
  }

  private reply(conversationId: number, parentId: number, steps: TurnStep[]): void {
    const conversation = this.conversations.get(conversationId)!
    const id = this.nextMessageId++
    const assistant = assistantShell({ id, conversation_id: conversationId, parent_id: parentId, seq: id, provider_id: script.PROVIDER_ID, model_id: script.DEFAULT_MODEL_ID, created_at: Date.now() })
    this.messagesOf(conversationId).push(assistant)
    this.publish({ type: 'message.created', message: structuredClone(assistant) })
    this.moveHead(conversation, id)
    this.playing = { conversationId, messageId: id }
    this.signal('turn-start')
    this.play(assistantFrames(id, steps, script.USAGE))
  }

  private play(frames: Timed[]): void {
    const [next, ...rest] = frames
    if (!next) {
      this.playing = null
      this.signal('turn-done')
      return
    }
    this.timer = setTimeout(() => {
      this.publish(next.event)
      this.play(rest)
    }, next.delay)
  }

  private moveHead(conversation: Conversation, messageId: number): void {
    conversation.head_message_id = messageId
    conversation.updated_at = Date.now()
    this.publish({ type: 'head.changed', conversation_id: conversation.id, message_id: messageId })
    this.publish({ type: 'conversation.updated', conversation: structuredClone(conversation) })
  }

  /** Sends an event and folds it into the stored rows, the way the hub persists what it streams. */
  private publish(event: WsEvent): void {
    if (event.type === 'message.delta') {
      const message = this.find(event.message_id)!
      const part = message.parts[event.part_index]
      if (part && (part.type === 'text' || part.type === 'reasoning')) part.text += event.delta
    } else if (event.type === 'message.part') {
      this.find(event.message_id)!.parts[event.part_index] = structuredClone(event.part)
    } else if (event.type === 'message.done') {
      Object.assign(this.find(event.message_id)!, { status: event.status, usage: event.usage, error: event.error })
    }
    this.emit(event)
  }

  private refuse(message: string, requestId?: string): void {
    this.emit({ type: 'error', ...(requestId ? { request_id: requestId } : {}), message })
  }

  private signal(signal: BackendSignal): void {
    for (const listener of this.listeners) listener(signal)
  }

  private messagesOf(conversationId: number): Message[] {
    let list = this.messages.get(conversationId)
    if (!list) this.messages.set(conversationId, list = [])
    return list
  }

  private find(messageId: number): Message | undefined {
    for (const list of this.messages.values()) {
      const found = list.find(message => message.id === messageId)
      if (found) return found
    }
    return undefined
  }
}
