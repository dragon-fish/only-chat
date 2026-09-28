import { describe, expect, it } from 'vitest'
import {
  cascadePluginSwitches, effectivePluginSwitches, withoutDependentTools, withRequiredTools, type PluginManifest,
} from '@/shared/plugins'

const manifest = (id: string, tools: string[], requires?: string[]): PluginManifest => ({
  id, name: id, description: '', tools: tools.map(tool => ({ id: tool, name: tool, description: '' })), ...(requires ? { requires } : {}),
})

// reader ← files ← sync, and reader ← vision: a chain and a sibling.
const manifests = [
  manifest('reader', ['read']),
  manifest('files', ['write', 'list'], ['reader']),
  manifest('sync', ['push'], ['files']),
  manifest('vision', ['analyze'], ['reader']),
  manifest('clock', ['now']),
]

describe('plugin switches', () => {
  it('turn on what a plugin requires, transitively', () => {
    expect(cascadePluginSwitches(manifests, { sync: true })).toEqual({ sync: true, files: true, reader: true })
  })

  it('turn off what requires a plugin, transitively, and nothing else', () => {
    expect(cascadePluginSwitches(manifests, { reader: false })).toEqual({ reader: false, files: false, sync: false, vision: false })
    expect(cascadePluginSwitches(manifests, { files: false })).toEqual({ files: false, sync: false })
  })

  it('count a requirement as on for settings saved before it existed', () => {
    expect(effectivePluginSwitches(manifests, { files: true, clock: false })).toEqual({ files: true, reader: true, clock: false })
  })
})

describe('tool selection', () => {
  it('brings every tool of the plugins a selected one requires', () => {
    expect(withRequiredTools(manifests, ['push']).sort()).toEqual(['list', 'push', 'read', 'write'])
  })

  it('takes dependents along only when a required plugin loses its last selected tool', () => {
    const selected = ['read', 'write', 'list', 'analyze', 'now']
    expect(withoutDependentTools(manifests, selected, ['read']).sort()).toEqual(['now'])
    // `files` keeps `list`, so nothing that requires it goes.
    expect(withoutDependentTools(manifests, [...selected, 'push'], ['write']).sort()).toEqual(['analyze', 'list', 'now', 'push', 'read'])
  })
})
