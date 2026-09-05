import { Context, Service } from 'cordis'
import type { LanguageModel } from 'ai'
import type { ModelRow, ProviderRow } from '../../db/schema'
import { decryptSecret } from './crypto'
import { openaiCompletionsProtocol } from './protocols/openai-completions'
import { openaiResponsesProtocol } from './protocols/openai-responses'
import { anthropicProtocol } from './protocols/anthropic'
import { vertexProtocol } from './protocols/vertex'

export type ModelFactory = (provider: ProviderRow, model: ModelRow, apiKey: string | null) => LanguageModel

export class Llm extends Service {
  static readonly provide = 'llm'
  static readonly inject = ['env']

  private readonly _factories = new Map<string, ModelFactory>()
  private readonly _secret: string

  constructor(ctx: Context) {
    super(ctx, 'llm')
    this._secret = ctx.env.KEY_ENCRYPTION_SECRET
  }

  /** Caller-scoped: the registration is removed when the registering plugin is disposed. */
  register(protocol: string, factory: ModelFactory): () => void {
    return this.ctx.effect(() => {
      this._factories.set(protocol, factory)
      return () => { this._factories.delete(protocol) }
    }, `llm.register(${protocol})`)
  }

  has(protocol: string): boolean {
    return this._factories.has(protocol)
  }

  async decryptKey(provider: ProviderRow): Promise<string | null> {
    return provider.api_key ? decryptSecret(this._secret, provider.api_key) : null
  }

  async createModel(provider: ProviderRow, model: ModelRow): Promise<LanguageModel> {
    const factory = this._factories.get(provider.protocol)
    if (!factory) throw new Error(`no factory for protocol ${provider.protocol}`)
    const key = await this.decryptKey(provider)
    if (key === null) throw new Error(`provider ${provider.id} has no API key`)
    return factory(provider, model, key)
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
  },
}
