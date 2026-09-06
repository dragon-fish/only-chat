import { Context, Service } from 'cordis'
import type { FilesV4 } from '@ai-sdk/provider'
import type { LanguageModel } from 'ai'
import type { ModelRow, ProviderRow } from '../../db/schema'
import { decryptSecret } from './crypto'
import { openaiCompletionsProtocol } from './protocols/openai-completions'
import { openaiResponsesProtocol } from './protocols/openai-responses'
import { anthropicProtocol } from './protocols/anthropic'
import { vertexProtocol } from './protocols/vertex'
import { vertexCompatibleProtocol } from './protocols/vertex-compatible'

/**
 * One protocol's bindings to a provider SDK. `createFiles` is optional: a Files API is a provider
 * capability, and a protocol that has none simply never offers one (spec §4.8).
 */
export interface LlmProtocolAdapter {
  createModel(provider: ProviderRow, model: ModelRow, apiKey: string): LanguageModel
  createFiles?: (provider: ProviderRow, apiKey: string) => FilesV4
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
  hasFiles(provider: ProviderRow): boolean {
    return provider.native_files && this._adapters.get(provider.protocol)?.createFiles !== undefined
  }

  async decryptKey(provider: ProviderRow): Promise<string | null> {
    return provider.api_key ? decryptSecret(this._secret, provider.api_key) : null
  }

  async createModel(provider: ProviderRow, model: ModelRow): Promise<LanguageModel> {
    const adapter = this._adapters.get(provider.protocol)
    if (!adapter) throw new Error(`no adapter for protocol ${provider.protocol}`)
    const key = await this.decryptKey(provider)
    if (key === null) throw new Error(`provider ${provider.id} has no API key`)
    return adapter.createModel(provider, model, key)
  }

  async createFiles(provider: ProviderRow): Promise<FilesV4> {
    const adapter = this._adapters.get(provider.protocol)
    if (!adapter) throw new Error(`no adapter for protocol ${provider.protocol}`)
    if (!provider.native_files) throw new Error(`provider ${provider.id} has native files disabled`)
    if (!adapter.createFiles) throw new Error(`protocol ${provider.protocol} has no Files API`)
    const key = await this.decryptKey(provider)
    if (key === null) throw new Error(`provider ${provider.id} has no API key`)
    return adapter.createFiles(provider, key)
  }
}

export const LlmPlugin = {
  name: 'llm',
  async apply(ctx: Context) {
    await ctx.plugin(Llm)
    await ctx.plugin(openaiCompletionsProtocol)
    await ctx.plugin(openaiResponsesProtocol)
    await ctx.plugin(anthropicProtocol)
    await ctx.plugin(vertexProtocol)
    await ctx.plugin(vertexCompatibleProtocol)
  },
}
