import type { PluginManifest } from '@/shared/plugins'

/** Kept framework-neutral so lazy host behavior is testable without mounting Vue. */
export type ToolRenderer = unknown
export type ConfigRenderer = unknown

export interface ClientPluginContext {
  manifests: readonly PluginManifest[]
  tools: { register(toolId: string, renderer: ToolRenderer): () => void }
  /**
   * Replaces the declaration-driven settings form for this plugin. Whether a plugin registered one
   * IS the answer — a boolean on the manifest saying it did would be one more thing that can
   * disagree with reality.
   */
  config: { register(component: ConfigRenderer): () => void }
}

export type ClientPluginSetup = (ctx: ClientPluginContext) => void | (() => void)
export interface ClientPluginModule { setup: ClientPluginSetup }
export type ClientPluginLoader = () => Promise<ClientPluginModule>

export interface ClientPluginHostOptions {
  manifests: readonly PluginManifest[]
  loaders: Record<string, ClientPluginLoader>
}

/** Loads optional client implementations only on demand and owns their renderer lifecycles. */
export class ClientPluginHost {
  readonly manifests: readonly PluginManifest[]
  private readonly loaders: Record<string, ClientPluginLoader>
  private readonly toolPlugins = new Map<string, string>()
  private readonly renderers = new Map<string, ToolRenderer>()
  private readonly configRenderers = new Map<string, ConfigRenderer>()
  private readonly pending = new Map<string, Promise<void>>()
  private readonly disposers = new Map<string, () => void>()

  constructor({ manifests, loaders }: ClientPluginHostOptions) {
    this.manifests = manifests
    this.loaders = loaders
    for (const manifest of manifests) {
      for (const { id: toolId } of manifest.tools) {
        const owner = this.toolPlugins.get(toolId)
        if (owner) throw new Error(`tool ${toolId} is owned by multiple plugins: ${owner}, ${manifest.id}`)
        this.toolPlugins.set(toolId, manifest.id)
      }
    }
  }

  renderer(toolId: string): ToolRenderer | undefined {
    return this.renderers.get(toolId)
  }

  configRenderer(pluginId: string): ConfigRenderer | undefined {
    return this.configRenderers.get(pluginId)
  }

  /** Historical Parts use this path even when their plugin is now globally disabled. */
  async ensureConfigRenderer(pluginId: string): Promise<ConfigRenderer | undefined> {
    const existing = this.configRenderer(pluginId)
    if (existing !== undefined) return existing
    if (!this.loaders[pluginId]) return undefined
    await this.ensurePlugin(pluginId)
    return this.configRenderer(pluginId)
  }

  install(setup: ClientPluginSetup, pluginId: string): () => void {
    this.disposePlugin(pluginId)
    const registrations: (() => void)[] = []
    let cleanup: void | (() => void)
    try {
      cleanup = setup({
        manifests: this.manifests,
        tools: {
          register: (toolId, renderer) => {
            if (this.toolPlugins.get(toolId) !== pluginId) throw new Error(`plugin ${pluginId} does not own tool ${toolId}`)
            if (this.renderers.has(toolId)) throw new Error(`tool renderer already registered: ${toolId}`)
            this.renderers.set(toolId, renderer)
            const unregister = () => {
              if (this.renderers.get(toolId) === renderer) this.renderers.delete(toolId)
            }
            registrations.push(unregister)
            return unregister
          },
        },
        config: {
          register: (component) => {
            if (this.configRenderers.has(pluginId)) throw new Error(`config renderer already registered: ${pluginId}`)
            this.configRenderers.set(pluginId, component)
            const unregister = () => {
              if (this.configRenderers.get(pluginId) === component) this.configRenderers.delete(pluginId)
            }
            registrations.push(unregister)
            return unregister
          },
        },
      })
    } catch (error) {
      for (const unregister of registrations.splice(0)) unregister()
      throw error
    }
    const dispose = () => {
      for (const unregister of registrations.splice(0)) unregister()
      if (typeof cleanup === 'function') cleanup()
      if (this.disposers.get(pluginId) === dispose) this.disposers.delete(pluginId)
    }
    this.disposers.set(pluginId, dispose)
    return dispose
  }

  async ensurePlugin(pluginId: string): Promise<void> {
    if (this.disposers.has(pluginId)) return
    const current = this.pending.get(pluginId)
    if (current) return current
    const loader = this.loaders[pluginId]
    if (!loader) throw new Error(`unknown client plugin: ${pluginId}`)
    const load = loader().then(({ setup }) => { this.install(setup, pluginId) })
    this.pending.set(pluginId, load)
    try {
      await load
    } finally {
      this.pending.delete(pluginId)
    }
  }

  /** Historical Parts use this path even when their plugin is now globally disabled. */
  async ensureToolRenderer(toolId: string): Promise<ToolRenderer | undefined> {
    const existing = this.renderer(toolId)
    if (existing !== undefined) return existing
    const pluginId = this.toolPlugins.get(toolId)
    if (!pluginId) return undefined
    await this.ensurePlugin(pluginId)
    return this.renderer(toolId)
  }

  disposePlugin(pluginId: string): void {
    this.disposers.get(pluginId)?.()
  }

  dispose(): void {
    for (const pluginId of [...this.disposers.keys()]) this.disposePlugin(pluginId)
  }
}
