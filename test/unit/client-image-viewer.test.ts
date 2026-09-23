import { describe, expect, it } from 'vitest'
import type { RouteLocationNormalizedLoaded } from 'vue-router'
import { viewerArtifactId, withoutViewer, withViewer } from '@/client/lib/image-viewer'

const route = (query: Record<string, string>) => ({ path: '/c/29', hash: '', query }) as unknown as RouteLocationNormalizedLoaded

describe('image viewer query', () => {
  it('opens and closes without disturbing the rest of the query', () => {
    expect(withViewer(route({ tab: 'files' }), 33)).toEqual({ path: '/c/29', hash: '', query: { tab: 'files', image: '33' } })
    expect(withoutViewer(route({ tab: 'files', image: '33' }))).toEqual({ path: '/c/29', hash: '', query: { tab: 'files' } })
  })

  it('reads only a positive integer id', () => {
    expect(viewerArtifactId({ image: '33' })).toBe(33)
    expect(viewerArtifactId({ image: 'abc' })).toBeNull()
    expect(viewerArtifactId({ image: '-1' })).toBeNull()
    expect(viewerArtifactId({})).toBeNull()
  })
})
