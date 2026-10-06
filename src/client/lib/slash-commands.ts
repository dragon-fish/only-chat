import { effectivePluginSwitches, type PluginManifest } from '@/shared/plugins'

/** One command the composer can offer, read from manifests alone. */
export interface SlashCommandEntry {
  pluginId: string
  name: string
  description: string
  argsHint?: string
}

export interface SlashCommandInvocation {
  pluginId: string
  name: string
  /** Everything after the command word, trimmed; empty when nothing follows. */
  args: string
}

/** What the composer is handed: the commands to offer and how to run one. */
export interface SlashCommandBinding {
  commands: readonly SlashCommandEntry[]
  /** Rejects with a message fit to show when the command is unavailable or fails. */
  run(invocation: SlashCommandInvocation): Promise<void>
}

/** Commands declared by the plugins that are switched on, in manifest order. */
export function availableSlashCommands(
  manifests: readonly PluginManifest[],
  switches: Readonly<Record<string, boolean>>,
): SlashCommandEntry[] {
  const enabled = effectivePluginSwitches(manifests, switches)
  return manifests
    .filter(manifest => enabled[manifest.id] === true)
    .flatMap(manifest => (manifest.slashCommands ?? []).map(command => ({
      pluginId: manifest.id,
      name: command.name,
      description: command.description,
      ...(command.argsHint === undefined ? {} : { argsHint: command.argsHint }),
    })))
}

/**
 * A command only when the first word is exactly `/` plus an available name. Anything else — a path
 * like `/project/a.md`, an unknown or mistyped name — is ordinary text and is sent as a message.
 */
export function parseSlashCommand(text: string, commands: readonly SlashCommandEntry[]): SlashCommandInvocation | null {
  const match = /^\/(\S+)(?:\s([\s\S]*))?$/.exec(text)
  if (!match) return null
  const command = commands.find(candidate => candidate.name === match[1])
  if (!command) return null
  return { pluginId: command.pluginId, name: command.name, args: (match[2] ?? '').trim() }
}

/** What the menu lists: only while the first word is still being typed, matched by prefix. */
export function slashCommandMenu(text: string, commands: readonly SlashCommandEntry[]): SlashCommandEntry[] {
  const prefix = /^\/(\S*)$/.exec(text)?.[1]
  if (prefix === undefined) return []
  return commands.filter(command => command.name.startsWith(prefix))
}
