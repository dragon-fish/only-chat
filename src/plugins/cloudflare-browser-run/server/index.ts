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
import { storeGeneratedAttachment } from './attachments'
import { BrowserRateLimited } from './browser-api'
import { BrowserSessions, type StoredSession } from './sessions'

const SKIPPED_MESSAGE = '用户没有处理这次接管就继续了对话'

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
      if (options.close) {
        await this.sessions.forget(conversationId)
        return undefined
      }
      const next = { ...session, liveView: result.liveView ?? session.liveView }
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

const states = new WeakMap<Hub, BrowserRunState>()
function stateOf(ctx: Context): BrowserRunState {
  const hub = ctx.hub
  let state = states.get(hub)
  if (!state) {
    state = new BrowserRunState(hub, ctx.env)
    states.set(hub, state)
  }
  return state
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function buildOutput(result: RunResult, scratch: RunScratch): BrowserUseOutput | BrowserUseError {
  const { logs, truncated } = truncateLogs(scratch.lines.join('\n'))
  const screenshots = result.screenshots.map(shot => ({ attachment_id: shot.attachmentId, name: shot.name }))
  if (result.ok) {
    return { result: result.result ?? '', logs, logs_truncated: truncated, screenshots, url: result.url, title: result.title }
  }
  const detail = result.error ? [result.error.message, result.error.stack].filter(Boolean).join('\n') : '未知错误'
  return { error: detail, timed_out: result.timedOut, logs, logs_truncated: truncated, screenshots, url: result.url }
}

function browserUseTool(ctx: Context, toolCtx: ToolContext): Tool<BrowserUseInput, BrowserUseResult> {
  const execute = async (input: BrowserUseInput, { toolCallId }: { toolCallId: string }): Promise<BrowserUseResult> => {
    const state = stateOf(ctx)
    const config = BROWSER_RUN_CONFIG_SCHEMA.parse(toolCtx.config)
    const conversation = BROWSER_RUN_CONVERSATION_CONFIG_SCHEMA.parse(toolCtx.conversationConfig)
    if (new TextEncoder().encode(input.code).byteLength > MAX_CODE_BYTES) {
      return { error: `代码超过 ${MAX_CODE_BYTES} 字节的上限，拆成几次调用。` }
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
            refused: `浏览器额度暂时用尽${wait ? `，${wait} 秒后再试` : ''}。先把已有的信息告诉用户。`,
            ...(wait ? { retry_after_s: wait } : {}),
          }
        }
        return { error: `无法打开浏览器：${message(error)}` }
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
        return { error: `浏览器执行环境失败：${message(error)}`, logs: scratch.lines.join('\n') }
      }
      if (result.storageState) await state.saveProfile(scope, result.storageState)
      const session = { ...ensured.session, liveView: result.liveView ?? ensured.session.liveView }
      await state.sessions.put(toolCtx.conversationId, session)
      await state.publish(toolCtx.conversationId, scope.profile, session)
      return buildOutput(result, scratch)
    })
  }
  /**
   * Screenshots reach the model here, as media beside the JSON, and only when it can see them.
   * The scratch is dropped afterwards: the persisted result keeps attachment ids, not bytes.
   */
  const toModelOutput: NonNullable<Tool<BrowserUseInput, BrowserUseResult>['toModelOutput']> = ({ toolCallId, output }) => {
    const state = stateOf(ctx)
    const scratch = state.scratch.get(toolCallId)
    state.scratch.delete(toolCallId)
    const text = JSON.stringify(output)
    if (!toolCtx.acceptsImages || !scratch || scratch.images.length === 0) return { type: 'text', value: text }
    return {
      type: 'content',
      value: [
        { type: 'text', text },
        ...scratch.images.map(image => ({ type: 'file' as const, data: { type: 'data' as const, data: image.bytes }, mediaType: image.mime, filename: `${image.name}.jpg` })),
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
    ctx.tools.register(BROWSER_RUN_PLUGIN_ID, BROWSER_USE_TOOL_ID, (toolCtx: ToolContext) => browserUseTool(ctx, toolCtx))

    ctx.tools.register(BROWSER_RUN_PLUGIN_ID, BROWSER_HANDOFF_TOOL_ID, () => tool({
      description: BROWSER_HANDOFF_DESCRIPTION,
      inputSchema: BrowserHandoffInputSchema,
    }), {
      respond: (input, result, call) => {
        BrowserHandoffInputSchema.parse(input)
        const parsed = BrowserHandoffResultSchema.parse(result)
        if (parsed.status === 'skipped') throw new Error('skipped is not an answer a person gives')
        // Whatever the person did in the browser is worth keeping now, not after the next tool call.
        void stateOf(ctx).probe(call.conversationId, { close: false }).catch(error => console.error('browser profile export failed', error))
        return parsed
      },
      skip: () => ({ status: 'skipped', message: SKIPPED_MESSAGE }),
      skipped: content => BrowserHandoffResultSchema.parse(content).status === 'skipped',
    })

    ctx.pluginChannel.onCommand(BROWSER_RUN_PLUGIN_ID, async (payload) => {
      const command = BrowserPluginCommandSchema.parse(payload)
      const state = stateOf(ctx)
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
      const state = stateOf(ctx)
      const scratch = state.scratch.get(call.callId)
      switch (call.kind) {
        case 'log': {
          scratch?.lines.push(call.line)
          await state.hub.broadcast({ type: 'tool.progress', message_id: call.messageId, call_id: call.callId, lines: [call.line] })
          return undefined
        }
        case 'attach': {
          const bytes = new Uint8Array(call.bytes)
          const attachmentId = await storeGeneratedAttachment(state.hub.db, state.hub.app.assets, state.hub.userId, bytes, call.mime)
          scratch?.images.push({ attachmentId, name: call.name, mime: call.mime, bytes })
          await state.hub.broadcast({ type: 'tool.progress', message_id: call.messageId, call_id: call.callId, lines: [`[截图] ${call.name}`] })
          return attachmentId
        }
      }
    })

    // A deleted conversation must not leave a browser running on the meter.
    ctx.on('conversation/before-purge', async ({ conversationId }) => {
      const state = stateOf(ctx)
      if (await state.sessions.get(conversationId)) {
        await state.probe(conversationId, { close: true }).catch(error => console.error('browser close on purge failed', error))
      }
    })
  },
}
