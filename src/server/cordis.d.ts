import type { Database } from './plugins/database'
import type { Assets } from './plugins/assets'
import type { Llm } from './plugins/llm'

declare module 'cordis' {
  interface Context {
    env: Env
    doState: DurableObjectState
    db: Database
    assets: Assets
    llm: Llm
  }
}
