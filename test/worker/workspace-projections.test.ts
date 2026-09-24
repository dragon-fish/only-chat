import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { createDb, type DB } from '@/server/db/client'
import { artifactRuns, artifacts, attachments, conversations } from '@/server/db/schema'
import { insertMessage } from '@/server/plugins/hub/conversations'
import { resolveProjected } from '@/server/plugins/workspace-files/projections'
import { WorkspaceFiles, type WorkspaceStorage } from '@/server/plugins/workspace-files/service'
import { ensureTestUser, registerAndLogin } from './auth-helper'
import type { Part } from '@/shared/parts'

const storage: WorkspaceStorage = { put: async () => {}, delete: async () => {}, getBytes: async () => null }

let seq = 0
async function image(db: DB, userId: number, mime = 'image/png'): Promise<number> {
  const sha256 = `projection-${Date.now()}-${++seq}`.padEnd(64, '0')
  const [row] = await db.insert(attachments).values({
    user_id: userId, sha256, mime, size: 100 + seq, width: 64, height: 32, r2_key: `k/${sha256}`, origin: 'upload', created_at: 0,
  }).returning()
  return row!.id
}

async function conversation(db: DB, userId: number): Promise<number> {
  const [row] = await db.insert(conversations).values({
    user_id: userId, project_id: null, title: 'c', head_message_id: null, provider_id: null,
    model_id: null, system_prompt: null, params: null, tools: [], created_at: 0, updated_at: 0,
  }).returning()
  return row!.id
}

async function message(db: DB, userId: number, conversationId: number, role: 'user' | 'assistant', parts: Part[]) {
  return insertMessage(db, userId, {
    conversation_id: conversationId, parent_id: null, seq: ++seq, role, parts,
    provider_id: null, model_id: null, usage: null, status: 'done', error: null, created_at: seq,
  })
}

async function run(db: DB, userId: number, conversationId: number, outputs: Array<{ attachmentId: number, deleted?: boolean }>) {
  const [row] = await db.insert(artifactRuns).values({
    user_id: userId, client_request_id: `projection-run-${++seq}`, kind: 'image_generation', source: 'tool', operation: 'generate',
    status: 'completed', conversation_id: conversationId, provider_name: 'p', interface_protocol: 'responses', credential_version: 1,
    model_id: 'm', model_name: 'm', prompt: 'x', params: { count: outputs.length, size: null }, workflow_instance_id: `projection-wf-${seq}`, created_at: 0,
  }).returning()
  const ids: number[] = []
  for (const [index, output] of outputs.entries()) {
    const [artifact] = await db.insert(artifacts).values({
      user_id: userId, run_id: row!.id, kind: 'image', attachment_id: output.attachmentId, output_index: index,
      width: 64, height: 32, mime: 'image/png', created_at: 0, deleted_at: output.deleted ? 1 : null,
    }).returning()
    ids.push(artifact!.id)
  }
  return ids
}

describe('projected image mounts', () => {
  it('lists the images a conversation holds and keeps them read-only', async () => {
    const db = createDb(env.DB)
    await ensureTestUser(db)
    const conversationId = await conversation(db, 1)
    const uploaded = await image(db, 1)
    const inline = await image(db, 1, 'image/webp')
    const [kept, deleted] = await run(db, 1, conversationId, [{ attachmentId: await image(db, 1) }, { attachmentId: await image(db, 1), deleted: true }])
    await message(db, 1, conversationId, 'user', [{ type: 'image', attachment_id: uploaded }, { type: 'text', text: 'hi' }])
    await message(db, 1, conversationId, 'assistant', [{ type: 'image', attachment_id: inline }])
    const files = new WorkspaceFiles(db, storage, 1)
    const scope = { conversationId, projectId: null }

    const root = await files.list({ ...scope, path: '/' })
    expect(root.ok && root.value.entries).toEqual(expect.arrayContaining([
      { path: '/artifacts', type: 'mount', status: 'ready' },
      { path: '/uploads', type: 'mount', status: 'ready' },
    ]))
    const generated = await files.list({ ...scope, path: '/artifacts' })
    expect(generated.ok && generated.value.entries.map(entry => entry.path)).toEqual([`/artifacts/${kept}.png`, `/artifacts/msg-${inline}.webp`])
    expect(generated.ok && generated.value.entries.map(entry => entry.path)).not.toContain(`/artifacts/${deleted}.png`)
    const uploads = await files.list({ ...scope, path: '/uploads' })
    expect(uploads.ok && uploads.value.entries).toEqual([expect.objectContaining({ path: `/uploads/${uploaded}.png`, type: 'file' })])

    expect(await resolveProjected(db, 1, conversationId, `/uploads/${uploaded}.png`)).toMatchObject({ attachmentId: uploaded, mime: 'image/png', width: 64 })
    expect(await resolveProjected(db, 1, conversationId, `/artifacts/${deleted}.png`)).toBeNull()
    expect(await resolveProjected(db, 1, conversationId, `/uploads/${uploaded}.jpg`)).toBeNull()

    expect(await files.write({ ...scope, path: `/artifacts/${kept}.png`, content: 'x' })).toEqual({ ok: false, error: 'READ_ONLY' })
    expect(await files.write({ ...scope, path: '/uploads/new.md', content: 'x' })).toEqual({ ok: false, error: 'READ_ONLY' })
  })

  it('never resolves an image from another conversation or another user', async () => {
    const db = createDb(env.DB)
    await ensureTestUser(db)
    const other = await registerAndLogin({ name: 'Other', email: 'projection-other@example.com', password: 'a-long-test-password' })
    const otherId = Number(((await (await other.request('/api/auth/get-session')).json()) as { user: { id: string } }).user.id)
    const mine = await conversation(db, 1)
    const elsewhere = await conversation(db, 1)
    const theirs = await conversation(db, otherId)
    const elsewhereImage = await image(db, 1)
    const theirImage = await image(db, otherId)
    await message(db, 1, elsewhere, 'user', [{ type: 'image', attachment_id: elsewhereImage }])
    await message(db, otherId, theirs, 'user', [{ type: 'image', attachment_id: theirImage }])

    expect(await resolveProjected(db, 1, mine, `/uploads/${elsewhereImage}.png`)).toBeNull()
    expect(await resolveProjected(db, 1, theirs, `/uploads/${theirImage}.png`)).toBeNull()
    expect(await resolveProjected(db, 1, mine, `/uploads/${theirImage}.png`)).toBeNull()
    const listed = await new WorkspaceFiles(db, storage, 1).list({ conversationId: theirs, projectId: null, path: '/uploads' })
    expect(listed.ok && listed.value.entries).toEqual([])
  })
})
