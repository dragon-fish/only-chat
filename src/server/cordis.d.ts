import type { Database } from './plugins/database'
import type { Authentication } from './plugins/auth'
import type { Assets } from './plugins/assets'
import type { Llm } from './plugins/llm'
import type { Hub } from './plugins/hub'
import type { BeforeSendPayload } from './plugins/hub/generation'
import type { ApiApp } from './plugins/api'
import type { ModelCatalog } from './plugins/model-catalog'
import type { ToolRegistry } from './plugins/tools'
import type { PluginConfig } from './plugins/plugin-config'
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
    modelCatalog: ModelCatalog
    tools: ToolRegistry
    pluginConfig: PluginConfig
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
    'message/before-send'(payload: BeforeSendPayload): void
    'message/done'(message: Message): void
    'project/created'(project: Project): void
    'project/updated'(project: Project): void
    'project/deleted'(projectId: number): void
  }
}
