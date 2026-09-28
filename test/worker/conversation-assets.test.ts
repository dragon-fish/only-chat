import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { createDb } from '@/server/db/client'
import { artifactRuns, artifacts, attachments } from '@/server/db/schema'
import { createConversation, insertMessage } from '@/server/plugins/hub/conversations'
import { listConversationAssets } from '@/server/plugins/file-refs/list'
import type { Part } from '@/shared/parts'
import { ensureTestUser } from './auth-helper'

const db = createDb(env.DB)

async function attachment(mime = 'image/png') {
  const sha256 = (crypto.randomUUID() + crypto.randomUUID()).replaceAll('-', '').slice(0, 64)
  const [row] = await db.insert(attachments).values({
    user_id: 1, sha256, mime, size: 3, width: mime.startsWith('image/') ? 4 : null, height: mime.startsWith('image/') ? 5 : null,
    r2_key: `assets/${sha256}`, origin: 'upload', created_at: 0,
  }).returning()
  return row!
}

async function message(conversationId: number, parentId: number | null, role: 'user' | 'assistant', parts: Part[], createdAt: number) {
  return insertMessage(db, 1, {
    conversation_id: conversationId, parent_id: parentId, seq: createdAt, role, parts,
    provider_id: null, model_id: null, usage: null, status: 'done', error: null, created_at: createdAt,
  })
}

async function run(conversationId: number, attachmentId: number, deleted: boolean) {
  const [row] = await db.insert(artifactRuns).values({
    user_id: 1, client_request_id: crypto.randomUUID(), kind: 'image_generation', source: 'tool', operation: 'generate',
    status: 'completed', conversation_id: conversationId, provider_name: 'P', interface_protocol: 'responses',
    credential_version: 1, model_id: 'm', model_name: 'M', prompt: 'p', params: { count: 1, size: null },
    workflow_instance_id: crypto.randomUUID(), created_at: 50,
  }).returning()
  await db.insert(artifacts).values({
    user_id: 1, run_id: row!.id, kind: 'image', attachment_id: attachmentId, output_index: 0, mime: 'image/png',
    created_at: 50, deleted_at: deleted ? 60 : null,
  })
}

describe('listConversationAssets', () => {
  it('lists uploads and generated images across every branch, once each, and nothing else', async () => {
    await ensureTestUser(db)
    const conversation = await createConversation(db, { user_id: 1, title: 'assets', provider_id: null, model_id: null })
    const other = await createConversation(db, { user_id: 1, title: 'other', provider_id: null, model_id: null })
    const [photo, report, inline, runOutput, deletedOutput, studio, delivered, foreign] = await Promise.all([
      attachment(), attachment('application/pdf'), attachment(), attachment(), attachment(), attachment(), attachment(), attachment(),
    ])
    const root = await message(conversation.id, null, 'user', [
      { type: 'image', attachment_id: photo.id, filename: 'cat.png' }, { type: 'text', text: 'hi' },
    ], 10)
    // Two branches under the same question: an asset lives on whichever one produced it.
    await message(conversation.id, root.id, 'assistant', [
      { type: 'image', attachment_id: inline.id },
      { type: 'image', attachment_id: studio.id, artifact_id: 1 },
      { type: 'tool_result', call_id: 'c', name: 'read_file', content: {}, attachments: [delivered.id] },
    ], 20)
    const branch = await message(conversation.id, root.id, 'assistant', [{ type: 'text', text: 'other branch' }], 30)
    await message(conversation.id, branch.id, 'user', [
      { type: 'file', attachment_id: report.id, mime: 'application/pdf', filename: 'report.pdf' },
      { type: 'image', attachment_id: photo.id },
    ], 40)
    await run(conversation.id, runOutput.id, false)
    await run(conversation.id, deletedOutput.id, true)
    await message(other.id, null, 'user', [{ type: 'image', attachment_id: foreign.id }], 10)

    expect(await listConversationAssets(db, 1, conversation.id)).toEqual([
      { attachmentId: photo.id, ref: photo.sha256.slice(0, 8), source: 'upload', mime: 'image/png', size: 3, width: 4, height: 5, filename: 'cat.png', createdAt: 10 },
      { attachmentId: inline.id, ref: inline.sha256.slice(0, 8), source: 'generated', mime: 'image/png', size: 3, width: 4, height: 5, filename: null, createdAt: 20 },
      { attachmentId: report.id, ref: report.sha256.slice(0, 8), source: 'upload', mime: 'application/pdf', size: 3, width: null, height: null, filename: 'report.pdf', createdAt: 40 },
      { attachmentId: runOutput.id, ref: runOutput.sha256.slice(0, 8), source: 'generated', mime: 'image/png', size: 3, width: 4, height: 5, filename: null, createdAt: 50 },
    ])
    expect(await listConversationAssets(db, 2, conversation.id)).toEqual([])
  })
})
