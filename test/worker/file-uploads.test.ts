import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { authenticatedFetch, ensureTestUser, registerAndLogin } from './auth-helper'
import { connect } from './ws-helper'
import { createDb } from '@/server/db/client'
import { attachments, conversations, users } from '@/server/db/schema'
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

describe('attachment downloads', () => {
  it('answers single byte ranges with 206 and refuses unsatisfiable ones', async () => {
    const bytes = new TextEncoder().encode('%PDF-1.7\nrange fixture')
    const { attachment_id } = await (await upload('application/pdf', bytes)).json() as { attachment_id: number }
    const get = (range?: string) => authenticatedFetch(new Request(`https://x/api/attachments/${attachment_id}`, { headers: range ? { range } : {} }))

    const whole = await get()
    expect(whole.status).toBe(200)
    expect(whole.headers.get('accept-ranges')).toBe('bytes')
    await whole.arrayBuffer()

    const middle = await get('bytes=2-5')
    expect(middle.status).toBe(206)
    expect(middle.headers.get('content-range')).toBe(`bytes 2-5/${bytes.byteLength}`)
    expect(new Uint8Array(await middle.arrayBuffer())).toEqual(bytes.slice(2, 6))

    const open = await get('bytes=4-')
    expect(open.headers.get('content-range')).toBe(`bytes 4-${bytes.byteLength - 1}/${bytes.byteLength}`)
    expect(new Uint8Array(await open.arrayBuffer())).toEqual(bytes.slice(4))

    const suffix = await get('bytes=-3')
    expect(suffix.status).toBe(206)
    expect(new Uint8Array(await suffix.arrayBuffer())).toEqual(bytes.slice(-3))

    const beyond = await get(`bytes=${bytes.byteLength}-`)
    expect(beyond.status).toBe(416)
    expect(beyond.headers.get('content-range')).toBe(`bytes */${bytes.byteLength}`)
  })
})

describe('sending attachment parts', () => {
  it('rejects a file part whose MIME differs from the stored row, and another account\'s attachment', async () => {
    const db = createDb(env.DB)
    const owner = await ensureTestUser()
    const pdf = await (await upload('application/pdf', new TextEncoder().encode('%PDF-1.7\nsend check'))).json() as { attachment_id: number }

    const strangerEmail = 'stranger@example.com'
    if (!(await db.query.users.findFirst({ where: eq(users.email, strangerEmail) }))) {
      await registerAndLogin({ name: 'stranger', email: strangerEmail, password: 'a-long-test-password' })
    }
    const stranger = (await db.query.users.findFirst({ where: eq(users.email, strangerEmail) }))!
    const [foreign] = await db.insert(attachments).values({
      user_id: stranger.id, sha256: 'f'.repeat(64), mime: 'image/png', size: 1, r2_key: 'foreign', origin: 'upload', created_at: 0,
    }).returning()

    const ownerRow = (await db.query.users.findFirst({ where: eq(users.email, 'owner@example.com') }))!
    const before = (await db.select().from(conversations).where(eq(conversations.user_id, ownerRow.id))).length
    const c = await connect({ cookie: owner.cookie })
    const send = (request_id: string, parts: unknown[]) => c.ws.send(JSON.stringify({
      type: 'send', request_id, conversation_id: null, parent_id: null, parts, provider_id: 1, model_id: 'any',
    }))

    send('mismatch', [{ type: 'file', attachment_id: pdf.attachment_id, mime: 'audio/mpeg' }])
    expect(await c.nextAfter('error', 1)).toMatchObject({ request_id: 'mismatch', message: expect.stringContaining('does not match') })
    send('foreign', [{ type: 'image', attachment_id: foreign!.id }])
    expect(await c.nextAfter('error', 2)).toMatchObject({ request_id: 'foreign', message: expect.stringContaining('not found') })
    c.ws.close()

    expect((await db.select().from(conversations).where(eq(conversations.user_id, ownerRow.id))).length).toBe(before)
  })
})
