import { Context } from 'cordis'
import { Database } from './plugins/database'
import { Assets } from './plugins/assets'
import { LlmPlugin } from './plugins/llm'
import { HubPlugin } from './plugins/hub'
import { ApiPlugin } from './plugins/api'

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
  if (options.side === 'hub' && !options.doState) throw new Error('hub side requires doState')
  if (typeof options.env.KEY_ENCRYPTION_SECRET !== 'string' || options.env.KEY_ENCRYPTION_SECRET.length < 16) {
    throw new Error('KEY_ENCRYPTION_SECRET is missing or too short')
  }
  const ctx = new Context()
  ctx.logger.exporter({
    colors: false,
    export: (m) => console.log(`[cordis:${m.type}] ${m.name}`, ...m.args),
  })
  ctx.provide('env', options.env)
  if (options.doState) ctx.provide('doState', options.doState)

  await ctx.plugin(Database)
  await ctx.plugin(Assets)
  if (options.side === 'hub') {
    await ctx.plugin(LlmPlugin)
    // `await ctx.plugin()` resolves even when the plugin stays PENDING on a missing injection,
    // so assert the service is actually reachable rather than failing later at first use.
    if (!ctx.get('llm')) throw new Error('LlmPlugin loaded but ctx.llm is unavailable')
    await ctx.plugin(HubPlugin)
    if (!ctx.get('hub')) throw new Error('HubPlugin loaded but ctx.hub is unavailable')
  }
  if (options.side === 'worker') {
    await ctx.plugin(ApiPlugin)
    if (!ctx.get('api')) throw new Error('ApiPlugin loaded but ctx.api is unavailable')
  }
  return ctx
}
