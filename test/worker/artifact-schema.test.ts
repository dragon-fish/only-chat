import { env } from 'cloudflare:workers'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { createDb } from '@/server/db/client'
import {
  artifactLinks, artifactRunInputs, artifactRuns, artifacts, attachments, conversations, messages, users,
} from '@/server/db/schema'
import { deleteConversation } from '@/server/plugins/hub/conversations'

describe('Artifact schema', () => {
  it('keeps generated Artifacts when their source Conversation is deleted', async () => {
    const db = createDb(env.DB)
    const [user] = await db.insert(users).values({
      name: 'Artist', email: `${crypto.randomUUID()}@example.com`, settings: { plugins: {} },
      createdAt: new Date(0), updatedAt: new Date(0),
    }).returning()
    const [conversation] = await db.insert(conversations).values({
      user_id: user!.id, kind: 'image', title: 'Otter', image_provider_id: null, image_model_id: null,
      provider_id: null, model_id: null, created_at: 1, updated_at: 1,
    }).returning()
    const [message] = await db.insert(messages).values({
      conversation_id: conversation!.id, parent_id: null, seq: 1, role: 'assistant', parts: [],
      provider_id: null, model_id: null, usage: null, status: 'done', error: null, created_at: 2,
    }).returning()
    const [attachment] = await db.insert(attachments).values({
      user_id: user!.id, sha256: crypto.randomUUID(), mime: 'image/png', size: 4,
      width: 1024, height: 1024, r2_key: `${user!.id}/fixture`, origin: 'generated', created_at: 3,
    }).returning()
    const [run] = await db.insert(artifactRuns).values({
      user_id: user!.id, client_request_id: crypto.randomUUID(), kind: 'image_generation', source: 'studio',
      operation: 'generate', status: 'completed', conversation_id: conversation!.id, message_id: message!.id,
      provider_name: 'Fixture', interface_protocol: 'responses', credential_version: 1,
      model_id: 'image-model', model_name: 'Image Model', prompt: 'A sea otter', params: { count: 1, size: null },
      workflow_instance_id: crypto.randomUUID(), created_at: 3, completed_at: 4,
    }).returning()
    await db.insert(artifactRunInputs).values({ run_id: run!.id, attachment_id: attachment!.id, position: 0 })
    const [artifact] = await db.insert(artifacts).values({
      user_id: user!.id, run_id: run!.id, kind: 'image', attachment_id: attachment!.id,
      output_index: 0, width: 1024, height: 1024, mime: 'image/png', created_at: 4,
    }).returning()
    await db.insert(artifactLinks).values({
      artifact_id: artifact!.id, conversation_id: conversation!.id, message_id: message!.id, purpose: 'output',
    })

    await db.delete(conversations).where(eq(conversations.id, conversation!.id))

    expect(await db.select().from(artifacts).where(eq(artifacts.id, artifact!.id))).toHaveLength(1)
    expect(await db.select().from(artifactLinks).where(eq(artifactLinks.artifact_id, artifact!.id))).toEqual([])
    expect(await db.select({ conversation_id: artifactRuns.conversation_id, message_id: artifactRuns.message_id })
      .from(artifactRuns).where(eq(artifactRuns.id, run!.id))).toEqual([{ conversation_id: null, message_id: null }])
  })

  it('deduplicates client submissions and run output positions per user', async () => {
    const db = createDb(env.DB)
    const user = (await db.select().from(users))[0]!
    const requestId = crypto.randomUUID()
    const values = {
      user_id: user.id, client_request_id: requestId, kind: 'image_generation' as const, source: 'studio' as const,
      operation: 'generate' as const, status: 'queued' as const, provider_name: 'Fixture',
      interface_protocol: 'responses' as const, credential_version: 1, model_id: 'image-model',
      model_name: 'Image Model', prompt: 'A sea otter', params: { count: 1, size: null },
      workflow_instance_id: crypto.randomUUID(), created_at: 1,
    }
    await db.insert(artifactRuns).values(values)
    await expect(db.insert(artifactRuns).values({ ...values, workflow_instance_id: crypto.randomUUID() })).rejects.toThrow()
  })

  it('soft-deletes an exclusively linked Artifact when requested with its Conversation', async () => {
    const db = createDb(env.DB)
    const [user] = await db.insert(users).values({
      name: 'Cleaner', email: `${crypto.randomUUID()}@example.com`, settings: { plugins: {} },
      createdAt: new Date(0), updatedAt: new Date(0),
    }).returning()
    const [conversation] = await db.insert(conversations).values({ user_id: user!.id, title: 'Delete', kind: 'chat', created_at: 1, updated_at: 1 }).returning()
    const [message] = await db.insert(messages).values({
      conversation_id: conversation!.id, parent_id: null, seq: 1, role: 'assistant', parts: [],
      provider_id: null, model_id: null, usage: null, status: 'done', error: null, created_at: 1,
    }).returning()
    const [attachment] = await db.insert(attachments).values({
      user_id: user!.id, sha256: crypto.randomUUID(), mime: 'image/png', size: 1,
      r2_key: `${user!.id}/delete`, origin: 'generated', created_at: 1,
    }).returning()
    const [run] = await db.insert(artifactRuns).values({
      user_id: user!.id, client_request_id: crypto.randomUUID(), kind: 'image_generation', source: 'tool',
      operation: 'generate', status: 'completed', conversation_id: conversation!.id, message_id: message!.id,
      provider_name: 'P', interface_protocol: 'responses', credential_version: 1, model_id: 'm', model_name: 'M',
      prompt: 'p', params: { count: 1, size: null }, workflow_instance_id: crypto.randomUUID(), created_at: 1,
    }).returning()
    const [artifact] = await db.insert(artifacts).values({
      user_id: user!.id, run_id: run!.id, kind: 'image', attachment_id: attachment!.id,
      output_index: 0, mime: 'image/png', created_at: 1,
    }).returning()
    await db.insert(artifactLinks).values({ artifact_id: artifact!.id, conversation_id: conversation!.id, message_id: message!.id, purpose: 'output' })

    await deleteConversation(db, conversation!.id, user!.id)

    // An Artifact outlives the conversation that produced it: the Gallery is where images are
    // kept and where they are deleted, and a conversation is not a folder they live in.
    expect(await db.query.artifacts.findFirst({ where: eq(artifacts.id, artifact!.id) })).toMatchObject({ deleted_at: null })
  })
})
