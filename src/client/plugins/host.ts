import { slashCommandOwners, type PluginManifest } from '@/shared/plugins'
import type { WsCommand } from '@/shared/ws'
import type { SlashCommandInvocation } from '@/client/lib/slash-commands'

/** Kept framework-neutral so lazy host behavior is testable without mounting Vue. */
export type ToolRenderer = unknown
export type ConfigRenderer = unknown
export type MessageFooterRenderer = unknown
export type SettingsPanelRenderer = unknown
export type WorkspacePanelRenderer = unknown
export type ProjectPanelRenderer = unknown
export type NotificationRenderer = unknown

/** What a plugin asks of the workspace panel; the shell decides whether to grant it. */
export interface WorkspaceAttention {
  /** A handoff or anything else a person must see now; otherwise the shell may decline quietly. */
  force?: boolean
}

export type SlashCommandToastKind = 'info' | 'success' | 'error'

/** What a slash command sees of the chat it was typed into, taken when it was submitted. */
export interface SlashCommandContext {
  /** Null while the conversation has not been started. */
  conversationId: number | null
  streaming: boolean
  compacting: boolean
  /** This plugin's `plugin.command`; false when no socket is available to carry it. */
  send(payload: unknown): boolean
  /** This plugin's `plugin.event`s; released with the plugin if the command never unsubscribes. */
  on(handler: (payload: unknown) => void): () => void
  toast(message: string, kind?: SlashCommandToastKind): void
}

/** What the chat supplies; the host adds the plugin-scoped channel. */
export type SlashCommandEnvironment = Pick<SlashCommandContext, 'conversationId' | 'streaming' | 'compacting' | 'toast'>

export interface SlashCommand {
  /** `true` when it can run now, otherwise the reason it cannot, shown to the person. */
  enabled?(ctx: SlashCommandContext): true | string
  /** Resolves when done; a rejection's message is shown as an error and the input is kept. */
  run(ctx: SlashCommandContext, args: string): Promise<void>
}

export interface ClientPluginContext {
  manifests: readonly PluginManifest[]
  tools: { register(toolId: string, renderer: ToolRenderer): () => void }
  /**
   * Replaces the declaration-driven settings form for this plugin. Whether a plugin registered one
   * IS the answer — a boolean on the manifest saying it did would be one more thing that can
   * disagree with reality.
   */
  config: { register(component: ConfigRenderer): () => void }
  /**
   * Something to say about a finished assistant message as a whole, rendered after its content —
   * what a per-tool-call card cannot do, because the point is the turn's outcome, not one call.
   */
  messageFooter: { register(component: MessageFooterRenderer): () => void }
  /**
   * Detail under a `task_notification` this plugin's background task produced, given the part as
   * `notification`. Without one the notification shows its summary text.
   */
  notifications: { register(component: NotificationRenderer): () => void }
  /**
   * Extra content on this plugin's own settings page, under `/settings/plugins/<id>`. The
   * declaration-driven form stays; this is for what a form cannot be — a file manager, a log, a
   * quota. Client surfaces are namespaced by plugin id the same way routes are.
   */
  settingsPanel: { register(component: SettingsPanelRenderer): () => void }
  /**
   * This plugin's tab in Project settings, given `pluginId` and `projectId`. The tab is declared in
   * the manifest (`projectTab`) so the strip needs nothing loaded; this is the component behind it.
   */
  projectPanel: { register(component: ProjectPanelRenderer): () => void }
  /**
   * This plugin's tab in the chat view's workspace panel. The tab itself is declared in the
   * manifest so the strip needs nothing loaded; this is the component behind it, given
   * `conversationId` and `projectId`. `attention` asks the shell to show the tab; the shell owns
   * the policy of when that actually happens.
   */
  workspacePanel: {
    register(component: WorkspacePanelRenderer): () => void
    attention(request?: WorkspaceAttention): void
  }
  /**
   * This plugin's own realtime channel to its server half, routed by plugin id and opaque to the
   * core. Nothing is buffered: an event that arrives before this plugin was loaded is gone, so a
   * plugin that needs the current state on load asks for it with `send`.
   */
  events: {
    on(handler: (payload: unknown) => void): () => void
    /** False when no socket is available to carry the command. */
    send(payload: unknown): boolean
  }
  /** The behaviour behind a command this plugin's manifest declares in `slashCommands`. */
  slashCommands: { register(name: string, command: SlashCommand): () => void }
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
  private readonly commandPlugins: Map<string, string>
  private readonly slashCommands = new Map<string, { command: SlashCommand, events: ClientPluginContext['events'] }>()
  private readonly renderers = new Map<string, ToolRenderer>()
  private readonly configRenderers = new Map<string, ConfigRenderer>()
  private readonly messageFooters = new Map<string, MessageFooterRenderer>()
  private readonly notificationRenderers = new Map<string, NotificationRenderer>()
  private readonly settingsPanels = new Map<string, SettingsPanelRenderer>()
  private readonly projectPanels = new Map<string, ProjectPanelRenderer>()
  private readonly eventListeners = new Map<string, Set<(payload: unknown) => void>>()
  private readonly workspacePanels = new Map<string, WorkspacePanelRenderer>()
  private readonly attentionListeners = new Set<(pluginId: string, request: WorkspaceAttention) => void>()
  private sender: ((command: WsCommand) => boolean) | null = null
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
    this.commandPlugins = slashCommandOwners(manifests)
  }

  /**
   * Loads the owning plugin if needed, then runs the command. Throws with a message fit to show
   * when the command is unavailable — `enabled`'s reason included — or when `run` rejects.
   */
  async runSlashCommand(invocation: SlashCommandInvocation, environment: SlashCommandEnvironment): Promise<void> {
    const { pluginId, name, args } = invocation
    if (this.commandPlugins.get(name) !== pluginId) throw new Error(`指令 /${name} 不属于插件 ${pluginId}`)
    await this.ensurePlugin(pluginId)
    const registered = this.slashCommands.get(name)
    if (!registered) throw new Error(`指令 /${name} 当前不可用`)
    const ctx: SlashCommandContext = { ...environment, send: registered.events.send, on: registered.events.on }
    const available = registered.command.enabled?.(ctx) ?? true
    if (available !== true) throw new Error(available)
    await registered.command.run(ctx, args)
  }

  renderer(toolId: string): ToolRenderer | undefined {
    return this.renderers.get(toolId)
  }

  configRenderer(pluginId: string): ConfigRenderer | undefined {
    return this.configRenderers.get(pluginId)
  }

  messageFooter(pluginId: string): MessageFooterRenderer | undefined {
    return this.messageFooters.get(pluginId)
  }

  settingsPanel(pluginId: string): SettingsPanelRenderer | undefined {
    return this.settingsPanels.get(pluginId)
  }

  workspacePanel(pluginId: string): WorkspacePanelRenderer | undefined {
    return this.workspacePanels.get(pluginId)
  }

  async ensureWorkspacePanel(pluginId: string): Promise<WorkspacePanelRenderer | undefined> {
    const existing = this.workspacePanel(pluginId)
    if (existing !== undefined) return existing
    if (!this.loaders[pluginId]) return undefined
    await this.ensurePlugin(pluginId)
    return this.workspacePanel(pluginId)
  }

  /** The shell listens here; a plugin's `attention` call reaches every mounted shell. */
  onWorkspaceAttention(listener: (pluginId: string, request: WorkspaceAttention) => void): () => void {
    this.attentionListeners.add(listener)
    return () => { this.attentionListeners.delete(listener) }
  }

  /** The socket that carries plugin commands; wired by the app once the sync store exists. */
  setSender(sender: ((command: WsCommand) => boolean) | null): void {
    this.sender = sender
  }

  /** A `plugin.event` frame from the server, handed to the plugin it names and nobody else. */
  dispatchEvent(pluginId: string, payload: unknown): void {
    for (const listener of this.eventListeners.get(pluginId) ?? []) {
      try { listener(payload) }
      catch (error) { console.error(`plugin ${pluginId} event listener failed`, error) }
    }
  }

  async ensureProjectPanel(pluginId: string): Promise<ProjectPanelRenderer | undefined> {
    const existing = this.projectPanels.get(pluginId)
    if (existing !== undefined) return existing
    if (!this.loaders[pluginId]) return undefined
    await this.ensurePlugin(pluginId)
    return this.projectPanels.get(pluginId)
  }

  /** Historical settings pages use this path even when the plugin is now globally disabled. */
  async ensureSettingsPanel(pluginId: string): Promise<SettingsPanelRenderer | undefined> {
    const existing = this.settingsPanel(pluginId)
    if (existing !== undefined) return existing
    if (!this.loaders[pluginId]) return undefined
    await this.ensurePlugin(pluginId)
    return this.settingsPanel(pluginId)
  }

  /** Which plugin owns a tool, so a message can load exactly the plugins its own calls belong to. */
  ownerOf(toolId: string): string | undefined {
    return this.toolPlugins.get(toolId)
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
    const events: ClientPluginContext['events'] = {
      on: (handler) => {
        let listeners = this.eventListeners.get(pluginId)
        if (!listeners) {
          listeners = new Set()
          this.eventListeners.set(pluginId, listeners)
        }
        listeners.add(handler)
        const unregister = () => { this.eventListeners.get(pluginId)?.delete(handler) }
        registrations.push(unregister)
        return unregister
      },
      send: payload => this.sender?.({ type: 'plugin.command', plugin: pluginId, payload }) ?? false,
    }
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
        settingsPanel: {
          register: (component) => {
            if (this.settingsPanels.has(pluginId)) throw new Error(`settings panel already registered: ${pluginId}`)
            this.settingsPanels.set(pluginId, component)
            const unregister = () => {
              if (this.settingsPanels.get(pluginId) === component) this.settingsPanels.delete(pluginId)
            }
            registrations.push(unregister)
            return unregister
          },
        },
        projectPanel: {
          register: (component) => {
            if (this.projectPanels.has(pluginId)) throw new Error(`project panel already registered: ${pluginId}`)
            this.projectPanels.set(pluginId, component)
            const unregister = () => {
              if (this.projectPanels.get(pluginId) === component) this.projectPanels.delete(pluginId)
            }
            registrations.push(unregister)
            return unregister
          },
        },
        messageFooter: {
          register: (component) => {
            if (this.messageFooters.has(pluginId)) throw new Error(`message footer already registered: ${pluginId}`)
            this.messageFooters.set(pluginId, component)
            const unregister = () => {
              if (this.messageFooters.get(pluginId) === component) this.messageFooters.delete(pluginId)
            }
            registrations.push(unregister)
            return unregister
          },
        },
        notifications: {
          register: (component) => {
            if (this.notificationRenderers.has(pluginId)) throw new Error(`notification renderer already registered: ${pluginId}`)
            this.notificationRenderers.set(pluginId, component)
            const unregister = () => {
              if (this.notificationRenderers.get(pluginId) === component) this.notificationRenderers.delete(pluginId)
            }
            registrations.push(unregister)
            return unregister
          },
        },
        workspacePanel: {
          register: (component) => {
            if (this.workspacePanels.has(pluginId)) throw new Error(`workspace panel already registered: ${pluginId}`)
            this.workspacePanels.set(pluginId, component)
            const unregister = () => {
              if (this.workspacePanels.get(pluginId) === component) this.workspacePanels.delete(pluginId)
            }
            registrations.push(unregister)
            return unregister
          },
          attention: (request = {}) => {
            for (const listener of this.attentionListeners) listener(pluginId, request)
          },
        },
        events,
        slashCommands: {
          register: (name, command) => {
            if (this.commandPlugins.get(name) !== pluginId) throw new Error(`plugin ${pluginId} does not declare slash command ${name}`)
            if (this.slashCommands.has(name)) throw new Error(`slash command already registered: ${name}`)
            const entry = { command, events }
            this.slashCommands.set(name, entry)
            const unregister = () => {
              if (this.slashCommands.get(name) === entry) this.slashCommands.delete(name)
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

  /** Historical notifications use this path even when their plugin is now globally disabled. */
  async ensureNotificationRenderer(pluginId: string): Promise<NotificationRenderer | undefined> {
    const existing = this.notificationRenderers.get(pluginId)
    if (existing !== undefined) return existing
    if (!this.loaders[pluginId]) return undefined
    await this.ensurePlugin(pluginId)
    return this.notificationRenderers.get(pluginId)
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
