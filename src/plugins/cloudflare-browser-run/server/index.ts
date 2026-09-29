import type { Context } from 'cordis'
import { tool, type Tool } from 'ai'
import { BROWSER_HANDOFF_TOOL_ID, BROWSER_RUN_PLUGIN_ID, BROWSER_USE_TOOL_ID, conversationConfigOf } from '@/shared/plugins'
import type { ToolContext } from '@/server/plugins/tools'
import type { Hub } from '@/server/plugins/hub'
import { getConversation } from '@/server/plugins/hub/conversations'
import browserRunManifest from '../manifest'
import {
  BROWSER_HANDOFF_DESCRIPTION, BROWSER_RUN_CONFIG_SCHEMA, BROWSER_RUN_CONVERSATION_CONFIG_SCHEMA, BROWSER_USE_DESCRIPTION,
  BrowserHandoffInputSchema, BrowserHandoffResultSchema, BrowserPluginCommandSchema, BrowserUseInputSchema,
  LIVE_VIEW_TTL_MS, MAX_CODE_BYTES, MAX_TIMEOUT_MS, profileStorageKey, truncateLogs,
  type BrowserPluginEvent, type BrowserProfile, type BrowserSessionState, type BrowserUseError, type BrowserUseInput,
  type BrowserUseOutput, type BrowserUseRefusal,
} from '../shared'
import type { HostCall, RunResult } from '../runtime/protocol'
import type { RunnerArgs } from './entrypoints'
import { storeGeneratedAttachment } from '@/server/plugins/api/attachments'
import { BrowserRateLimited } from './browser-api'
import { BrowserSessions, probedSession, type StoredSession } from './sessions'

const SKIPPED_MESSAGE = 'The user continued the conversation without taking over.'

interface RunScratch {
  lines: string[]
  images: Array<{ attachmentId: number; name: string; mime: string; bytes: Uint8Array }>
}

/** Everything the plugin keeps per Durable Object: the session store and the scratch of running calls. */
class BrowserRunState {
  readonly sessions: BrowserSessions
  readonly scratch = new Map<string, RunScratch>()

  constructor(readonly hub: Hub, readonly env: Env) {
    this.sessions = new BrowserSessions(hub, env.BROWSER)
  }

  begin(callId: string): RunScratch {
    const scratch: RunScratch = { lines: [], images: [] }
    this.scratch.set(callId, scratch)
    return scratch
  }

  async publish(conversationId: number, profile: BrowserProfile, session: StoredSession | undefined): Promise<void> {
    const state: BrowserSessionState = session
      ? {
          conversation_id: conversationId, status: 'active', profile, started_at: session.startedAt,
          live_view_url: session.liveView?.url ?? null, live_view_expires_at: session.liveView?.expiresAt ?? null,
        }
      : { conversation_id: conversationId, status: 'closed', profile, started_at: null, live_view_url: null, live_view_expires_at: null }
    const event: BrowserPluginEvent = { kind: 'session', state }
    await this.hub.broadcastPlugin(BROWSER_RUN_PLUGIN_ID, event)
  }

  /** The conversation's profile choice, read fresh: a command may arrive with no tool context around. */
  async profileOf(conversationId: number): Promise<{ profile: BrowserProfile; projectId: number | null } | null> {
    const conversation = await getConversation(this.hub.db, conversationId, this.hub.userId)
    if (!conversation) return null
    const config = BROWSER_RUN_CONVERSATION_CONFIG_SCHEMA.parse(conversationConfigOf(browserRunManifest, conversation.plugin_settings))
    return { profile: config.browser_profile, projectId: conversation.project_id }
  }

  /**
   * A run without code: connects, mints a Live View link, exports the storage state, and either
   * disconnects or closes. What every command that is not `browser_use` needs.
   */
  async probe(conversationId: number, options: { close: boolean }): Promise<StoredSession | undefined> {
    return this.sessions.withLock(conversationId, async () => {
      const session = await this.sessions.alive(conversationId)
      if (!session) return undefined
      const profile = await this.profileOf(conversationId)
      const result = await runner(this.env).run({
        userId: this.hub.userId, conversationId, messageId: 0, callId: `probe:${conversationId}:${Date.now()}`,
        code: null, sessionId: session.sessionId, storageState: null, timeoutMs: 0, liveViewTtlMs: LIVE_VIEW_TTL_MS, close: options.close,
      })
      if (profile && result.storageState) await this.saveProfile(profile, result.storageState)
      const next = options.close ? undefined : probedSession(session, result)
      if (!next) {
        await this.sessions.forget(conversationId)
        return undefined
      }
      await this.sessions.put(conversationId, next)
      return next
    })
  }

  async saveProfile(scope: { profile: BrowserProfile; projectId: number | null }, storageState: unknown): Promise<void> {
    const key = profileStorageKey(scope.profile, { userId: this.hub.userId, projectId: scope.projectId })
    if (key) await this.env.KV.put(key, JSON.stringify(storageState))
  }

  async loadProfile(scope: { profile: BrowserProfile; projectId: number | null }): Promise<unknown | null> {
    const key = profileStorageKey(scope.profile, { userId: this.hub.userId, projectId: scope.projectId })
    return key ? this.env.KV.get(key, 'json') : null
  }
}

/**
 * The self-binding's generated type collapses `unknown`-bearing signatures to `never`; the runner's
 * contract is `RunnerArgs` in and `RunResult` out, stated here once.
 */
function runner(env: Env): { run(args: RunnerArgs): Promise<RunResult> } {
  return env.BROWSER_RUNNER as unknown as { run(args: RunnerArgs): Promise<RunResult> }
}

type BrowserUseResult = BrowserUseOutput | BrowserUseError | BrowserUseRefusal

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function buildOutput(result: RunResult, scratch: RunScratch): BrowserUseOutput | BrowserUseError {
  const { logs, truncated } = truncateLogs(scratch.lines.join('\n'))
  const screenshots = result.screenshots.map(shot => ({ attachment_id: shot.attachmentId, name: shot.name }))
  if (result.ok) {
    return { result: result.result ?? '', logs, logs_truncated: truncated, screenshots, url: result.url, title: result.title }
  }
  const detail = result.error ? [result.error.message, result.error.stack].filter(Boolean).join('\n') : 'unknown error'
  return { error: detail, timed_out: result.timedOut, logs, logs_truncated: truncated, screenshots, url: result.url }
}

/**
 * What the model is told in place of pictures it cannot be shown.
 *
 * Silence would be worse than a sentence: the call still reports `screenshots`, so a model that
 * hears nothing concludes it was handed pixels and starts describing them.
 */
function undeliverableScreenshots(count: number, reason: 'model' | 'protocol'): string {
  const subject = count === 1 ? '1 screenshot was' : `${count} screenshots were`
  const why = reason === 'model'
    ? 'the model answering this conversation does not accept image input'
    : 'the provider interface this conversation runs on cannot carry an image inside a tool result'
  return `[${subject} captured and stored, but you were not shown ${count === 1 ? 'it' : 'them'}: ${why}. `
    + 'Do not guess what the pictures contain. Say so plainly if seeing them would have mattered — '
    + 'the user can switch the model or the provider interface in settings.]'
}

function browserUseTool(state: BrowserRunState, toolCtx: ToolContext): Tool<BrowserUseInput, BrowserUseResult> {
  const execute = async (input: BrowserUseInput, { toolCallId }: { toolCallId: string }): Promise<BrowserUseResult> => {
    const config = BROWSER_RUN_CONFIG_SCHEMA.parse(toolCtx.config)
    const conversation = BROWSER_RUN_CONVERSATION_CONFIG_SCHEMA.parse(toolCtx.conversationConfig)
    if (new TextEncoder().encode(input.code).byteLength > MAX_CODE_BYTES) {
      return { error: `Code exceeds the ${MAX_CODE_BYTES} byte limit. Split it across several calls.` }
    }
    const timeoutMs = Math.min(input.timeout_ms ?? config.default_timeout_ms, MAX_TIMEOUT_MS)
    const scope = { profile: conversation.browser_profile, projectId: toolCtx.projectId }

    return state.sessions.withLock(toolCtx.conversationId, async () => {
      let ensured: Awaited<ReturnType<BrowserSessions['ensure']>>
      try {
        ensured = await state.sessions.ensure(toolCtx.conversationId, config.keep_alive_ms)
      } catch (error) {
        if (error instanceof BrowserRateLimited) {
          const wait = error.retryAfterSeconds
          return {
            refused: `The browser quota is exhausted${wait ? `; retry in ${wait} seconds` : ''}. Tell the user what you have so far.`,
            ...(wait ? { retry_after_s: wait } : {}),
          }
        }
        return { error: `Could not open the browser: ${message(error)}` }
      }
      const storageState = ensured.fresh ? await state.loadProfile(scope) : null
      const scratch = state.begin(toolCallId)
      let result: RunResult
      try {
        result = await runner(state.env).run({
          userId: toolCtx.userId, conversationId: toolCtx.conversationId, messageId: toolCtx.assistantMessageId, callId: toolCallId,
          code: input.code, sessionId: ensured.session.sessionId, storageState, timeoutMs, liveViewTtlMs: LIVE_VIEW_TTL_MS,
        })
      } catch (error) {
        state.scratch.delete(toolCallId)
        return { error: `The browser runtime failed: ${message(error)}`, logs: scratch.lines.join('\n') }
      }
      if (result.storageState) await state.saveProfile(scope, result.storageState)
      const session = { ...ensured.session, liveView: result.liveView ?? ensured.session.liveView }
      await state.sessions.put(toolCtx.conversationId, session)
      await state.publish(toolCtx.conversationId, scope.profile, session)
      return buildOutput(result, scratch)
    })
  }
  /**
   * Screenshots reach the model here, as media beside the JSON, and only when both the model and
   * the protocol can carry them. Bytes that cannot travel are replaced by a sentence saying so,
   * never dropped in silence.
   *
   * The scratch is read once and discarded: the persisted result keeps attachment ids, not bytes,
   * so a later turn rebuilt from the database shows the ids alone by design.
   */
  const toModelOutput: NonNullable<Tool<BrowserUseInput, BrowserUseResult>['toModelOutput']> = ({ toolCallId, output }) => {
    const scratch = state.scratch.get(toolCallId)
    state.scratch.delete(toolCallId)
    const text = JSON.stringify(output)
    const images = scratch?.images ?? []
    if (images.length === 0) return { type: 'text', value: text }
    if (!toolCtx.acceptsImages) return { type: 'text', value: `${text}\n${undeliverableScreenshots(images.length, 'model')}` }
    if (!toolCtx.acceptsToolResultImages) return { type: 'text', value: `${text}\n${undeliverableScreenshots(images.length, 'protocol')}` }
    return {
      type: 'content',
      value: [
        { type: 'text', text },
        ...images.map(image => ({ type: 'file' as const, data: { type: 'data' as const, data: image.bytes }, mediaType: image.mime, filename: `${image.name}.jpg` })),
      ],
    }
  }
  return tool({ description: BROWSER_USE_DESCRIPTION, inputSchema: BrowserUseInputSchema, execute, toModelOutput })
}

export const BrowserRunServerPlugin = {
  name: 'cloudflare-browser-run',
  // `hub` is injected, so this plugin loads after the hub exists; its tools register late, which the
  // registry allows because tools are only resolved per generation.
  inject: ['tools', 'pluginChannel', 'env', 'hub'] as const,
  apply(ctx: Context) {
    // Built once and closed over. It cannot be cached against `ctx.hub`: cordis hands out a fresh
    // traceable Proxy on every service access, so `ctx.hub === ctx.hub` is false and any map keyed
    // on it misses every time — which silently gave each caller its own empty scratch, losing every
    // screenshot between `attach` and `toModelOutput` and voiding the per-conversation browser lock.
    const state = new BrowserRunState(ctx.hub, ctx.env)

    ctx.tools.register(BROWSER_RUN_PLUGIN_ID, BROWSER_USE_TOOL_ID, (toolCtx: ToolContext) => browserUseTool(state, toolCtx))

    ctx.tools.register(BROWSER_RUN_PLUGIN_ID, BROWSER_HANDOFF_TOOL_ID, () => tool({
      description: BROWSER_HANDOFF_DESCRIPTION,
      inputSchema: BrowserHandoffInputSchema,
    }), {
      respond: (input, result, call) => {
        BrowserHandoffInputSchema.parse(input)
        const parsed = BrowserHandoffResultSchema.parse(result)
        if (parsed.status === 'skipped') throw new Error('skipped is not an answer a person gives')
        // Whatever the person did in the browser is worth keeping now, not after the next tool call.
        void state.probe(call.conversationId, { close: false }).catch(error => console.error('browser profile export failed', error))
        return parsed
      },
      skip: () => ({ status: 'skipped', message: SKIPPED_MESSAGE }),
      skipped: content => BrowserHandoffResultSchema.parse(content).status === 'skipped',
    })

    ctx.pluginChannel.onCommand(BROWSER_RUN_PLUGIN_ID, async (payload) => {
      const command = BrowserPluginCommandSchema.parse(payload)
      const scope = await state.profileOf(command.conversation_id)
      if (!scope) throw new Error('conversation not found')
      switch (command.kind) {
        case 'state': {
          // A stored Live View link may point at a tab that no longer exists; a mount always gets
          // a link minted against the page that is there now, or learns the session is gone.
          const session = await state.probe(command.conversation_id, { close: false })
          await state.publish(command.conversation_id, scope.profile, session)
          return
        }
        case 'refresh_live_view': {
          const session = await state.probe(command.conversation_id, { close: false })
          await state.publish(command.conversation_id, scope.profile, session)
          return
        }
        case 'close': {
          await state.probe(command.conversation_id, { close: true })
          await state.publish(command.conversation_id, scope.profile, undefined)
          return
        }
      }
    })

    ctx.pluginChannel.onHostCall(BROWSER_RUN_PLUGIN_ID, async (payload) => {
      const call = payload as HostCall
      const scratch = state.scratch.get(call.callId)
      switch (call.kind) {
        case 'log': {
          scratch?.lines.push(call.line)
          await state.hub.broadcastGeneration({ type: 'tool.progress', message_id: call.messageId, call_id: call.callId, lines: [call.line] })
          return undefined
        }
        case 'attach': {
          const bytes = new Uint8Array(call.bytes)
          const attachmentId = await storeGeneratedAttachment(state.hub.db, state.hub.app.assets, state.hub.userId, bytes, call.mime)
          scratch?.images.push({ attachmentId, name: call.name, mime: call.mime, bytes })
          await state.hub.broadcastGeneration({ type: 'tool.progress', message_id: call.messageId, call_id: call.callId, lines: [`[截图] ${call.name}`] })
          return attachmentId
        }
      }
    })

    // A deleted conversation must not leave a browser running on the meter.
    ctx.on('conversation/before-purge', async ({ conversationId }) => {
      if (await state.sessions.get(conversationId)) {
        await state.probe(conversationId, { close: true }).catch(error => console.error('browser close on purge failed', error))
      }
    })
  },
}
