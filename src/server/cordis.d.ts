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
import type { PluginConfig } from './plugins/plugin-config'
import type { PluginChannel } from './plugins/plugin-channel'
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
    pluginConfig: PluginConfig
    pluginChannel: PluginChannel
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
    'message/before-send'(payload: BeforeSendPayload): void
    'message/done'(message: Message): void
    'project/created'(project: Project): void
    'project/updated'(project: Project): void
    'project/deleted'(projectId: number): void
  }
}
