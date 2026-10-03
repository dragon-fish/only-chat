import { describe, expect, it } from 'vitest'
import { notesByMessage } from '@/server/plugins/hub/generation'
import { pluginManifests } from '@/shared/plugin-manifests'

describe('notesByMessage', () => {
  it('orders notes by the plugin list, not by when each plugin finished preparing', () => {
    const [first, second] = pluginManifests.map(manifest => manifest.id)
    const grouped = notesByMessage([
      { pluginId: second!, messageId: 7, text: 'late plugin, first to finish' },
      { pluginId: first!, messageId: 7, text: 'early plugin, a' },
      { pluginId: first!, messageId: 7, text: 'early plugin, b' },
      { pluginId: first!, messageId: 9, text: 'other message' },
    ])
    expect(grouped.get(7)).toEqual(['early plugin, a', 'early plugin, b', 'late plugin, first to finish'])
    expect(grouped.get(9)).toEqual(['other message'])
  })
})
