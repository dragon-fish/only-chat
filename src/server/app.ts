import { Context } from 'cordis'
import { Database } from './plugins/database'
import { Assets } from './plugins/assets'

export type Side = 'worker' | 'hub'

export interface AppOptions {
  env: Env
  side: Side
  doState?: DurableObjectState
}

/**
 * Builds a cordis root. The Worker isolate and each UserHub DO instance each own one.
 * Plugin activation in cordis is always async, so callers must await this before using services.
 */
export async function createApp(options: AppOptions): Promise<Context> {
  const ctx = new Context()
  ctx.logger.exporter({
    colors: false,
    export: (m) => console.log(`[cordis:${m.type}] ${m.name}`, ...m.args),
  })
  ctx.provide('env', options.env)
  if (options.doState) ctx.provide('doState', options.doState)

  await ctx.plugin(Database)
  await ctx.plugin(Assets)
  // Task 8 adds: if (options.side === 'hub') await ctx.plugin(LlmPlugin)
  // Task 10 adds: if (options.side === 'hub') await ctx.plugin(HubPlugin)
  // Task 12 adds: if (options.side === 'worker') await ctx.plugin(ApiPlugin)
  return ctx
}
