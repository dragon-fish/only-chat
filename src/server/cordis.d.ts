import type { Database } from './plugins/database'
import type { Assets } from './plugins/assets'
import type { Llm } from './plugins/llm'
import type { Hub } from './plugins/hub'
import type { BeforeSendPayload } from './plugins/hub/generation'
import type { Message, Session } from '@/shared/models'

declare module 'cordis' {
  interface Context {
    env: Env
    doState: DurableObjectState
    db: Database
    assets: Assets
    llm: Llm
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
  }
}
