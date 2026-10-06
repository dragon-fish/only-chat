import type { Database } from './plugins/database'
import type { Authentication } from './plugins/auth'
import type { Assets } from './plugins/assets'
import type { Llm } from './plugins/llm'
import type { Hub } from './plugins/hub'
import type { BeforeSendPayload } from './plugins/hub/generation'
import type { ConversationForked } from './plugins/hub/conversations'
import type { ApiApp, PluginApi } from './plugins/api'
import type { ModelCatalog } from './plugins/model-catalog'
import type { ToolRegistry } from './plugins/tools'
import type { PromptSections } from './plugins/prompt-sections'
import type { PluginConfig } from './plugins/plugin-config'
import type { PluginChannel } from './plugins/plugin-channel'
import type { ImageBackends } from './plugins/artifacts/backends'
import type { GenerationTurn } from './plugins/hub/generation-turn'
import type { CheckpointCommittedPayload, CheckpointComposePayload } from './plugins/hub/checkpoint-writer'
import type { Message, Project, Conversation } from '@/shared/models'

declare module 'cordis' {
  interface Context {
    env: Env
    doState: DurableObjectState
    db: Database
    auth: Authentication
    assets: Assets
    llm: Llm
    api: ApiApp
    pluginApi: PluginApi
    modelCatalog: ModelCatalog
    tools: ToolRegistry
    promptSections: PromptSections
    pluginConfig: PluginConfig
    pluginChannel: PluginChannel
    imageBackends: ImageBackends
  }
}

declare module 'cordis' {
  interface Context {
    hub: Hub
  }

  interface Events {
    'conversation/created'(conversation: Conversation): void
    'conversation/updated'(conversation: Conversation): void
    'conversation/deleted'(conversationId: number): void
    /** Awaited through `ctx.parallel`, inside the fork's rollback: a listener that throws undoes it. */
    'conversation/forked'(payload: ConversationForked): Promise<void>
    /**
     * The conversation row is about to be destroyed for good. Awaited, so a listener owning rows
     * that would otherwise be cascaded away can carry them somewhere the user can still reach.
     */
    'conversation/before-purge'(payload: { userId: number, conversationId: number }): Promise<void>
    /**
     * A generation is about to be sent (spec §3.5, §4.5). Awaited through `ctx.parallel` before the prompt
     * is built: a plugin prepares its per-turn state in `turn.state`, may add `turn.notes`, and one
     * plugin may set `turn.labeler`.
     */
    'generation/prepare'(turn: GenerationTurn): Promise<void>
    /**
     * The generation stopped being read — finished, failed or stopped. Awaited through
     * `ctx.parallel`, once per turn that `generation/prepare` saw, so a plugin can release what its
     * tools opened in `turn.state`. A listener's failure is logged and never fails the message.
     */
    'generation/settled'(turn: GenerationTurn): Promise<void>
    /** Messages joined a running generation (an interjection), after its prompt was first built. */
    'generation/interjected'(turn: GenerationTurn, messages: readonly Message[]): Promise<void>
    /**
     * A checkpoint is about to be composed (spec §1.5). Awaited through `ctx.parallel`. Collect-only:
     * a listener appends `{ pluginId, text }` to `payload.blocks` and has no other effect, since the
     * checkpoint may still fail. Emitted through `hub.checkpoints.compose`.
     */
    'checkpoint/compose'(payload: CheckpointComposePayload): Promise<void>
    /**
     * A checkpoint was written and is the conversation's head (spec §1.5); never emitted for one that
     * was not. Awaited through `ctx.parallel`; a listener's failure is logged and changes nothing.
     */
    'checkpoint/committed'(payload: CheckpointCommittedPayload): Promise<void>
    'message/before-send'(payload: BeforeSendPayload): void
    'message/done'(message: Message): void
    'project/created'(project: Project): void
    'project/updated'(project: Project): void
    'project/deleted'(projectId: number): void
  }
}
