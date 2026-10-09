import { Context, Service } from 'cordis'
import type { LanguageModel } from 'ai'
import type { ScopedFilesClient } from './files/types'
import type { ScopedImagesClient } from './images/types'
import type { LlmRequestTrace } from './observability'
import type { ModelRow, ProviderInterfaceRow, ProviderRow } from '../../db/schema'
import { providerCredentials, type ProviderCredentials } from './credentials'
import { chatCompletionsProtocol } from './protocols/chat-completions'
import { responsesProtocol } from './protocols/responses'
import { anthropicProtocol } from './protocols/anthropic'
import { vertexCompatibleProtocol } from './protocols/vertex-compatible'

/**
 * One protocol's bindings to a provider SDK. `createFiles` is optional: a Files API is a provider
 * capability, and a protocol that has none simply never offers one (spec §4.8).
 */
export interface LlmProtocolAdapter {
  createModel(provider: ProviderRow, providerInterface: ProviderInterfaceRow, model: ModelRow, credentials: ProviderCredentials, trace?: LlmRequestTrace): LanguageModel
  createFiles?: (provider: ProviderRow, providerInterface: ProviderInterfaceRow, credentials: ProviderCredentials) => ScopedFilesClient
  createImages?: (provider: ProviderRow, providerInterface: ProviderInterfaceRow, credentials: ProviderCredentials) => ScopedImagesClient
}

export class Llm extends Service {
  static readonly provide = 'llm'
  static readonly inject = ['env']

  private readonly _adapters = new Map<string, LlmProtocolAdapter>()
  private readonly _secret: string

  constructor(ctx: Context) {
    super(ctx, 'llm')
    this._secret = ctx.env.KEY_ENCRYPTION_SECRET
  }

  /** Caller-scoped: the registration is removed when the registering plugin is disposed. */
  register(protocol: string, adapter: LlmProtocolAdapter): () => void {
    return this.ctx.effect(() => {
      this._adapters.set(protocol, adapter)
      return () => { this._adapters.delete(protocol) }
    }, `llm.register(${protocol})`)
  }

  has(protocol: string): boolean {
    return this._adapters.has(protocol)
  }

  /**
   * Whether uploads may be attempted at all. Callers ask this before `createFiles` so that a
   * provider with the capability switched off is never probed — it falls straight through to the
   * next attachment transport instead of surfacing an error (spec §5.6).
   */
  hasFiles(providerInterface: ProviderInterfaceRow): boolean {
    return providerInterface.native_files && this._adapters.get(providerInterface.protocol)?.createFiles !== undefined
  }

  hasImages(providerInterface: ProviderInterfaceRow): boolean {
    return this._adapters.get(providerInterface.protocol)?.createImages !== undefined
  }

  private async _credentials(provider: ProviderRow): Promise<ProviderCredentials> {
    const credentials = await providerCredentials(this._secret, provider)
    if (credentials === null) throw new Error(`provider ${provider.id} has no API key`)
    return credentials
  }

  async createModel(provider: ProviderRow, providerInterface: ProviderInterfaceRow, model: ModelRow, trace?: LlmRequestTrace): Promise<LanguageModel> {
    if (providerInterface.provider_id !== provider.id || model.provider_id !== provider.id) throw new Error('model and interface must belong to the provider')
    const adapter = this._adapters.get(providerInterface.protocol)
    if (!adapter) throw new Error(`no adapter for protocol ${providerInterface.protocol}`)
    const credentials = await this._credentials(provider)
    return adapter.createModel(provider, providerInterface, model, credentials, trace)
  }

  async createFiles(provider: ProviderRow, providerInterface: ProviderInterfaceRow): Promise<ScopedFilesClient> {
    if (providerInterface.provider_id !== provider.id) throw new Error('interface must belong to the provider')
    const adapter = this._adapters.get(providerInterface.protocol)
    if (!adapter) throw new Error(`no adapter for protocol ${providerInterface.protocol}`)
    if (!providerInterface.native_files) throw new Error(`interface ${providerInterface.id} has native files disabled`)
    if (!adapter.createFiles) throw new Error(`protocol ${providerInterface.protocol} has no Files API`)
    const credentials = await this._credentials(provider)
    return adapter.createFiles(provider, providerInterface, credentials)
  }

  async createImages(provider: ProviderRow, providerInterface: ProviderInterfaceRow): Promise<ScopedImagesClient> {
    if (providerInterface.provider_id !== provider.id) throw new Error('interface must belong to the provider')
    const adapter = this._adapters.get(providerInterface.protocol)
    if (!adapter?.createImages) throw new Error(`protocol ${providerInterface.protocol} has no Images API`)
    const credentials = await this._credentials(provider)
    return adapter.createImages(provider, providerInterface, credentials)
  }
}

export const LlmPlugin = {
  name: 'llm',
  async apply(ctx: Context) {
    await ctx.plugin(Llm)
    await ctx.plugin(chatCompletionsProtocol)
    await ctx.plugin(responsesProtocol)
    await ctx.plugin(anthropicProtocol)
    await ctx.plugin(vertexCompatibleProtocol)
    // Wraps the registrations above, so it must come last. Gated here rather than inside the plugin
    // so production builds drop the module entirely.
    if (import.meta.env.DEV) {
      const { MockProviderPlugin } = await import('../mock-provider/index')
      await ctx.plugin(MockProviderPlugin)
    }
  },
}
