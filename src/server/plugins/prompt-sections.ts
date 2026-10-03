import { Context, Service } from 'cordis'
import { findPluginManifest, pluginManifests } from '@/shared/plugin-manifests'

/** Everything a section may depend on. Nothing here varies within a conversation unless the tools do. */
export interface PromptSectionInput {
  /** The tools this generation offers, requirements included. */
  toolIds: readonly string[]
}

/**
 * A plugin's standing instructions to the model. Synchronous and pure on purpose: the system prompt
 * heads the cached prefix, so a section that read the user, the conversation, the clock or the
 * database would invalidate every turn after it. Text that has to vary goes into a user message or a
 * tool result instead.
 */
export type PromptSection = (input: PromptSectionInput) => string | undefined

/**
 * Plugin-contributed system prompt sections (memory spec §2).
 *
 * Its only input is the tool set, and tool definitions precede the system prompt in the cached
 * prefix, so nothing a section can say adds a way for the cache to break. Do not widen the input —
 * plugin configuration, for one, can change while the tool definitions stay byte-identical.
 */
export class PromptSections extends Service {
  static readonly provide = 'promptSections'

  private readonly sections = new Map<string, PromptSection>()

  constructor(ctx: Context) {
    super(ctx, 'promptSections')
  }

  /** Registration belongs to the caller's Cordis lifecycle and is reversible. */
  register(pluginId: string, section: PromptSection): () => void {
    // Rendering walks the manifest list, so a section under any other id would never be seen.
    if (!findPluginManifest(pluginId)) throw new Error(`prompt section for an unknown plugin: ${pluginId}`)
    if (this.sections.has(pluginId)) throw new Error(`prompt section already registered: ${pluginId}`)
    return this.ctx.effect(() => {
      this.sections.set(pluginId, section)
      return () => {
        if (this.sections.get(pluginId) === section) this.sections.delete(pluginId)
      }
    }, `promptSections.register(${pluginId})`) as () => void
  }

  /** The user's own prompt, then each section in manifest order. Never the order plugins loaded in. */
  render(systemPrompt: string | null, input: PromptSectionInput): string | null {
    return renderSystemPrompt(systemPrompt, pluginManifests.map(manifest => manifest.id), this.sections, input)
  }
}

export function renderSystemPrompt(
  systemPrompt: string | null,
  order: readonly string[],
  sections: ReadonlyMap<string, PromptSection>,
  input: PromptSectionInput,
): string | null {
  const blocks = systemPrompt !== null && systemPrompt.length > 0 ? [systemPrompt] : []
  for (const pluginId of order) {
    const text = sections.get(pluginId)?.(input)
    if (text === undefined || text.length === 0) continue
    blocks.push(`<plugin id="${pluginId}">\n${text}\n</plugin>`)
  }
  return blocks.length > 0 ? blocks.join('\n\n') : null
}

export const PromptSectionsPlugin = {
  name: 'prompt-sections',
  async apply(ctx: Context) {
    await ctx.plugin(PromptSections)
  },
}
