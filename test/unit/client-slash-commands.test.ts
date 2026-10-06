import { describe, expect, it } from 'vitest'
import { pluginManifests } from '@/shared/plugin-manifests'
import { slashCommandOwners, type PluginManifest } from '@/shared/plugins'
import { availableSlashCommands, parseSlashCommand, slashCommandMenu, type SlashCommandEntry } from '@/client/lib/slash-commands'

const manifest = (id: string, commands: PluginManifest['slashCommands'], requires?: string[]): PluginManifest => ({
  id, name: id, description: '', tools: [], slashCommands: commands, ...(requires ? { requires } : {}),
})

describe('slash command declarations', () => {
  it('are unique and well-formed across the real manifests', () => {
    expect(() => slashCommandOwners(pluginManifests)).not.toThrow()
  })

  it('reject a name two plugins declare', () => {
    expect(() => slashCommandOwners([
      manifest('a', [{ name: 'compress', description: '' }]),
      manifest('b', [{ name: 'compress', description: '' }]),
    ])).toThrow(/compress/)
  })

  it('reject names that are not lowercase letters, digits and dashes', () => {
    for (const name of ['Compress', 'com press', '', 'a/b', '-x', 'x-']) {
      expect(() => slashCommandOwners([manifest('a', [{ name, description: '' }])]), name).toThrow()
    }
    expect(slashCommandOwners([manifest('a', [{ name: 'save-2', description: '' }])]).get('save-2')).toBe('a')
  })
})

describe('available slash commands', () => {
  const manifests = [
    manifest('base', [{ name: 'base-cmd', description: 'b' }]),
    manifest('dep', [{ name: 'dep-cmd', description: 'd', argsHint: '[x]' }], ['base']),
    manifest('off', [{ name: 'off-cmd', description: 'o' }]),
  ]

  it('lists only enabled plugins, counting requirements as enabled', () => {
    expect(availableSlashCommands(manifests, { dep: true, off: false })).toEqual([
      { pluginId: 'base', name: 'base-cmd', description: 'b' },
      { pluginId: 'dep', name: 'dep-cmd', description: 'd', argsHint: '[x]' },
    ])
  })
})

const commands: SlashCommandEntry[] = [
  { pluginId: 'context_compaction', name: 'compress', description: 'Compress' },
  { pluginId: 'other', name: 'count', description: 'Count' },
]

describe('parseSlashCommand', () => {
  it('recognises a registered command with trimmed arguments', () => {
    expect(parseSlashCommand('/compress   keep the API notes  ', commands))
      .toEqual({ pluginId: 'context_compaction', name: 'compress', args: 'keep the API notes' })
    expect(parseSlashCommand('/compress\nline one\nline two', commands))
      .toEqual({ pluginId: 'context_compaction', name: 'compress', args: 'line one\nline two' })
  })

  it('takes a bare command as empty arguments', () => {
    expect(parseSlashCommand('/compress', commands)).toEqual({ pluginId: 'context_compaction', name: 'compress', args: '' })
    expect(parseSlashCommand('/compress  ', commands)).toEqual({ pluginId: 'context_compaction', name: 'compress', args: '' })
  })

  it('leaves paths, unknown commands, prefixes and case variants as ordinary text', () => {
    for (const text of ['/project/a.md please read', '/unknown', '/comp', '/Compress', '/compressx', 'compress', ' /compress', '/']) {
      expect(parseSlashCommand(text, commands), text).toBeNull()
    }
  })
})

describe('slashCommandMenu', () => {
  it('filters by prefix while the first word is still being typed', () => {
    expect(slashCommandMenu('/', commands).map(c => c.name)).toEqual(['compress', 'count'])
    expect(slashCommandMenu('/com', commands).map(c => c.name)).toEqual(['compress'])
    expect(slashCommandMenu('/compress', commands).map(c => c.name)).toEqual(['compress'])
  })

  it('closes once whitespace appears or the input is not a command', () => {
    expect(slashCommandMenu('/compress ', commands)).toEqual([])
    expect(slashCommandMenu('/project/a.md', commands)).toEqual([])
    expect(slashCommandMenu('hello', commands)).toEqual([])
    expect(slashCommandMenu('', commands)).toEqual([])
  })
})
