import { Context, Service } from 'cordis'
import type { LanguageModel } from 'ai'
import type { ProviderKind } from '@/shared/models'
import type { ScopedFilesClient } from './files/types'
import type { LlmRequestTrace } from './observability'
import type { ModelRow, ProviderInterfaceRow, ProviderRow } from '../../db/schema'
import { decryptSecret } from './crypto'
import { chatCompletionsProtocol } from './protocols/chat-completions'
import { responsesProtocol } from './protocols/responses'
import { anthropicProtocol } from './protocols/anthropic'
import { vertexCompatibleProtocol } from './protocols/vertex-compatible'
import { codexProvider } from './providers/codex'

/**
 * One protocol's bindings to a provider SDK. `createFiles` is optional: a Files API is a provider
 * capability, and a protocol that has none simply never offers one (spec §4.8).
 */
export interface LlmProtocolAdapter {
  createModel(provider: ProviderRow, providerInterface: ProviderInterfaceRow, model: ModelRow, apiKey: string, trace?: LlmRequestTrace): LanguageModel
  createFiles?: (provider: ProviderRow, providerInterface: ProviderInterfaceRow, apiKey: string) => ScopedFilesClient
}

export interface LlmProviderAdapter {
  createModel(provider: ProviderRow, providerInterface: ProviderInterfaceRow, model: ModelRow, trace?: LlmRequestTrace): Promise<LanguageModel>
}

export class Llm extends Service {
  static readonly provide = 'llm'
  static readonly inject = ['env']

  private readonly _adapters = new Map<string, LlmProtocolAdapter>()
  private readonly _providers = new Map<ProviderKind, LlmProviderAdapter>()
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

  registerProvider(kind: ProviderKind, adapter: LlmProviderAdapter): () => void {
    return this.ctx.effect(() => {
      this._providers.set(kind, adapter)
      return () => { this._providers.delete(kind) }
    }, `llm.registerProvider(${kind})`)
  }

  /**
   * Whether uploads may be attempted at all. Callers ask this before `createFiles` so that a
   * provider with the capability switched off is never probed — it falls straight through to the
   * next attachment transport instead of surfacing an error (spec §5.6).
   */
  hasFiles(providerInterface: ProviderInterfaceRow): boolean {
    return providerInterface.native_files && this._adapters.get(providerInterface.protocol)?.createFiles !== undefined
  }

  async decryptKey(provider: ProviderRow): Promise<string | null> {
    return provider.api_key ? decryptSecret(this._secret, provider.api_key) : null
  }

  async createModel(provider: ProviderRow, providerInterface: ProviderInterfaceRow, model: ModelRow, trace?: LlmRequestTrace): Promise<LanguageModel> {
    if (providerInterface.provider_id !== provider.id || model.provider_id !== provider.id) throw new Error('model and interface must belong to the provider')
    const providerAdapter = this._providers.get(provider.kind)
    if (providerAdapter) return providerAdapter.createModel(provider, providerInterface, model, trace)
    const adapter = this._adapters.get(providerInterface.protocol)
    if (!adapter) throw new Error(`no adapter for protocol ${providerInterface.protocol}`)
    const key = await this.decryptKey(provider)
    if (key === null) throw new Error(`provider ${provider.id} has no API key`)
    return adapter.createModel(provider, providerInterface, model, key, trace)
  }

  async createFiles(provider: ProviderRow, providerInterface: ProviderInterfaceRow): Promise<ScopedFilesClient> {
    if (providerInterface.provider_id !== provider.id) throw new Error('interface must belong to the provider')
    const adapter = this._adapters.get(providerInterface.protocol)
    if (!adapter) throw new Error(`no adapter for protocol ${providerInterface.protocol}`)
    if (!providerInterface.native_files) throw new Error(`interface ${providerInterface.id} has native files disabled`)
    if (!adapter.createFiles) throw new Error(`protocol ${providerInterface.protocol} has no Files API`)
    const key = await this.decryptKey(provider)
    if (key === null) throw new Error(`provider ${provider.id} has no API key`)
    return adapter.createFiles(provider, providerInterface, key)
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
    await ctx.plugin(codexProvider)
  },
}
