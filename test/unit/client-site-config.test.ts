import { DEFAULT_UPLOAD_POLICY } from '@/shared/upload-policy'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { api } from '@/client/lib/api'
import { useAuthStore } from '@/client/stores/auth'
import { useSiteConfigStore } from '@/client/stores/site-config'

beforeEach(() => setActivePinia(createPinia()))
afterEach(() => vi.restoreAllMocks())

it('shares one request between every reader of the same session', async () => {
  const request = vi.spyOn(api, 'siteConfig').mockResolvedValue({ uploads: DEFAULT_UPLOAD_POLICY, allowRegister: false })
  const site = useSiteConfigStore()
  await Promise.all([site.load(), site.load(), site.load()])
  await site.load()
  expect(request).toHaveBeenCalledOnce()
})

it('asks again for a different session, and when told a setting changed', async () => {
  const request = vi.spyOn(api, 'siteConfig').mockResolvedValue({ uploads: DEFAULT_UPLOAD_POLICY, allowRegister: false })
  const site = useSiteConfigStore()
  await site.load()
  useAuthStore().generation++
  await site.load()
  expect(request).toHaveBeenCalledTimes(2)
  await site.load(true)
  expect(request).toHaveBeenCalledTimes(3)
})
