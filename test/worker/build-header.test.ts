import { describe, expect, it } from 'vitest'
import { BUILD_HEADER } from '@/shared/build'
import { workerFetch } from './auth-helper'

describe('build header', () => {
  it('names the build on API responses, the auth handler\'s included', async () => {
    const health = await workerFetch('/api/health')
    const session = await workerFetch('/api/auth/get-session')
    expect([health.headers.get(BUILD_HEADER), session.headers.get(BUILD_HEADER)]).toEqual(['dev', 'dev'])
  })
})
