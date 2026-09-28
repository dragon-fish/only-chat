import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { authenticatedFetch, ensureTestUser } from './auth-helper'
import { createDb } from '@/server/db/client'
import { attachments } from '@/server/db/schema'
import { eq } from 'drizzle-orm'

async function upload(mime: string, bytes: Uint8Array<ArrayBuffer>) {
  await ensureTestUser()
  const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('')
  return authenticatedFetch(new Request(`https://x/api/attachments/${sha}?w=99&h=99`, { method: 'PUT', headers: { 'content-type': mime }, body: bytes }))
}

describe('non-image uploads', () => {
  it.each([
    ['application/pdf', '%PDF-1.7\nfile'],
    ['audio/mpeg', 'ID3recording'],
    ['audio/wav', 'RIFF0000WAVEdata'],
    ['video/mp4', '0000ftypisom'],
  ])('stores and serves %s without image dimensions', async (mime, body) => {
    const bytes = new TextEncoder().encode(body)
    const response = await upload(mime!, bytes)
    expect(response.status).toBe(201)
    const { attachment_id } = await response.json() as { attachment_id: number }
    const row = await createDb(env.DB).query.attachments.findFirst({ where: eq(attachments.id, attachment_id) })
    expect(row).toMatchObject({ mime, width: null, height: null })
    const get = await authenticatedFetch(new Request(`https://x/api/attachments/${attachment_id}`))
    expect(get.headers.get('content-type')).toBe(mime)
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(bytes)
  })

  it('rejects MIME spoofing and empty files', async () => {
    expect((await upload('application/pdf', new TextEncoder().encode('not pdf'))).status).toBe(415)
    expect((await upload('audio/mpeg', new Uint8Array())).status).toBe(400)
  })
})

it('applies administrator upload limits without changing registration or old downloads', async () => {
  const owner = await ensureTestUser()
  const registration = (await (await owner.request('/api/site-config')).json() as { allowRegister: boolean }).allowRegister
  const bytes = new TextEncoder().encode('%PDF-1.7\npolicy fixture')
  const first = await upload('application/pdf', bytes)
  const { attachment_id } = await first.json() as { attachment_id: number }
  try {
    const changed = await owner.json('PUT', '/api/admin/settings', { uploads: { maxBytes: 8, allowedMimeTypes: ['application/pdf'] } })
    expect(changed.status).toBe(200)
    const config = await (await owner.request('/api/site-config')).json()
    expect(config).toMatchObject({ allowRegister: registration, uploads: { maxBytes: 8, allowedMimeTypes: ['application/pdf'] } })
    expect((await upload('application/pdf', bytes)).status).toBe(413)
    expect((await upload('audio/mpeg', new TextEncoder().encode('ID3test'))).status).toBe(415)
    expect((await owner.request(`/api/attachments/${attachment_id}`)).status).toBe(200)
    const restored = await owner.json('PUT', '/api/admin/settings', { uploads: null })
    expect(restored.status).toBe(200)
    expect((await upload('application/pdf', bytes)).status).toBe(201)
  } finally {
    await owner.json('PUT', '/api/admin/settings', { uploads: null })
  }
})

it('rejects unknown formats and nonpositive limits', async () => {
  const owner = await ensureTestUser()
  expect((await owner.json('PUT', '/api/admin/settings', { uploads: { maxBytes: 0, allowedMimeTypes: ['application/pdf'] } })).status).toBe(400)
  expect((await owner.json('PUT', '/api/admin/settings', { uploads: { maxBytes: 1024, allowedMimeTypes: ['application/x-executable'] } })).status).toBe(400)
})

it('does not reuse a disabled video attachment under an allowed audio MIME', async () => {
  const owner = await ensureTestUser()
  const bytes = new TextEncoder().encode('0000ftypisom-policy-dedupe')
  expect((await upload('video/mp4', bytes)).status).toBe(201)
  try {
    await owner.json('PUT', '/api/admin/settings', { uploads: { maxBytes: 1024, allowedMimeTypes: ['audio/mp4'] } })
    expect((await upload('audio/mp4', bytes)).status).toBe(415)
  } finally { await owner.json('PUT', '/api/admin/settings', { uploads: null }) }
})
