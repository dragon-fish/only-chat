import { Context } from 'cordis'
import { Database } from './plugins/database'
import { Authentication } from './plugins/auth'
import { Assets } from './plugins/assets'
import { LlmPlugin } from './plugins/llm'
import { HubPlugin } from './plugins/hub'
import { ApiPlugin } from './plugins/api'
import { ModelCatalog } from './plugins/model-catalog'
import { ToolRegistryPlugin } from './plugins/tools'
import { PluginConfigPlugin } from './plugins/plugin-config'
import { AskUserServerPlugin } from '@/plugins/ask-user/server'
import { TavilyServerPlugin } from '@/plugins/tavily/server'
import { DatetimeServerPlugin } from '@/plugins/datetime/server'
import { WorkspaceFilesServerPlugin } from '@/plugins/workspace-files/server'
import { WorkspaceFilesApiPlugin } from '@/plugins/workspace-files/server/api'

export type Side = 'worker' | 'hub'

export type AppOptions = {
  env: Env
} & ({ side: 'worker' } | { side: 'workflow' } | { side: 'hub'; doState: DurableObjectState; userId: number })

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
  if (options.side === 'hub') ctx.provide('doState', options.doState)

  await ctx.plugin(Database)
  await ctx.plugin(Assets)
  await ctx.plugin(PluginConfigPlugin)
  if (!ctx.get('pluginConfig')) throw new Error('PluginConfigPlugin loaded but ctx.pluginConfig is unavailable')
  if (options.side === 'hub' || options.side === 'workflow') {
    await ctx.plugin(LlmPlugin)
    // `await ctx.plugin()` resolves even when the plugin stays PENDING on a missing injection,
    // so assert the service is actually reachable rather than failing later at first use.
    if (!ctx.get('llm')) throw new Error('LlmPlugin loaded but ctx.llm is unavailable')
    if (options.side === 'hub') {
      await ctx.plugin(ToolRegistryPlugin)
      if (!ctx.get('tools')) throw new Error('ToolRegistryPlugin loaded but ctx.tools is unavailable')
      await ctx.plugin(AskUserServerPlugin)
      await ctx.plugin(TavilyServerPlugin)
      await ctx.plugin(DatetimeServerPlugin)
      await ctx.plugin(WorkspaceFilesServerPlugin)
      await ctx.plugin(HubPlugin, { userId: options.userId })
      if (!ctx.get('hub')) throw new Error('HubPlugin loaded but ctx.hub is unavailable')
    }
  }
  if (options.side === 'worker') {
    await ctx.plugin(Authentication)
    if (!ctx.get('auth')) throw new Error('Authentication loaded but ctx.auth is unavailable')
    await ctx.plugin(ModelCatalog)
    if (!ctx.get('modelCatalog')) throw new Error('ModelCatalog loaded but ctx.modelCatalog is unavailable')
    await ctx.plugin(ApiPlugin)
    if (!ctx.get('api')) throw new Error('ApiPlugin loaded but ctx.api is unavailable')
    // Plugin routes mount after the guard is in place, which is what puts them behind it.
    await ctx.plugin(WorkspaceFilesApiPlugin)
  }
  return ctx
}
