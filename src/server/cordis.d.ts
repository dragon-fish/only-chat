import type { Database } from './plugins/database'
import type { Assets } from './plugins/assets'

declare module 'cordis' {
  interface Context {
    env: Env
    doState: DurableObjectState
    db: Database
    assets: Assets
  }
}
