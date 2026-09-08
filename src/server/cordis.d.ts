import type { Database } from './plugins/database'
import type { Assets } from './plugins/assets'
import type { Llm } from './plugins/llm'
import type { Hub } from './plugins/hub'
import type { BeforeSendPayload } from './plugins/hub/generation'
import type { ApiApp } from './plugins/api'
import type { ModelCatalog } from './plugins/model-catalog'
import type { ToolRegistry } from './plugins/tools'
import type { Message, Project, Session } from '@/shared/models'

declare module 'cordis' {
  interface Context {
    env: Env
    doState: DurableObjectState
    db: Database
    assets: Assets
    llm: Llm
    api: ApiApp
    modelCatalog: ModelCatalog
    tools: ToolRegistry
  }
}

declare module 'cordis' {
  interface Context {
    hub: Hub
  }

  interface Events {
    'session/created'(session: Session): void
    'session/updated'(session: Session): void
    'session/deleted'(sessionId: number): void
    'message/before-send'(payload: BeforeSendPayload): void
    'message/done'(message: Message): void
    'project/created'(project: Project): void
    'project/updated'(project: Project): void
    'project/deleted'(projectId: number): void
  }
}
