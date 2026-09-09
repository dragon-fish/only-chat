import type { Context } from 'cordis'
import { and, eq } from 'drizzle-orm'
import type { CreateImageRunInput, CreateImageRunResponse } from '@/shared/artifacts'
import type { Part } from '@/shared/parts'
import { artifactRunInputs, artifactRuns, conversations } from '@/server/db/schema'
import { disposeRpcStub } from '@/server/rpc'
import {
  compareAndSwapConversationHead, createConversation, getAttachment, getConversation, getModel, getProvider,
  getProviderInterface, insertMessage, maxSeq,
} from '../hub/conversations'

const IMAGE_PROTOCOLS = new Set(['responses', 'chat-completions'])

export class ArtifactRunInputError extends Error {
  constructor(message: string, readonly status: 404 | 409 | 422 = 422) { super(message) }
}

export async function createImageRun(ctx: Context, userId: number, input: CreateImageRunInput): Promise<CreateImageRunResponse> {
  const db = ctx.db.orm
  const existing = await db.query.artifactRuns.findFirst({
    where: and(eq(artifactRuns.user_id, userId), eq(artifactRuns.client_request_id, input.client_request_id)),
  })
  if (existing?.conversation_id && existing.message_id) {
    return { run_id: existing.id, conversation_id: existing.conversation_id, message_id: existing.message_id }
  }

  const provider = await getProvider(db, input.model.provider_id, userId)
  const model = provider ? await getModel(db, provider.id, input.model.model_id, userId) : undefined
  if (!provider || !provider.enabled || !model || !model.enabled) throw new ArtifactRunInputError('image model not found', 404)
  if (!model.supports_image_output) throw new ArtifactRunInputError('model does not support image output')
  if (input.reference_attachment_ids.length && !model.supports_image_input) throw new ArtifactRunInputError('model does not support image input')
  const interfaceId = model.interface_id ?? provider.default_interface_id
  const selected = interfaceId === null ? undefined : await getProviderInterface(db, interfaceId, userId)
  if (!selected || selected.provider_id !== provider.id || !IMAGE_PROTOCOLS.has(selected.protocol)) {
    throw new ArtifactRunInputError('model interface does not support the Images API')
  }
  const references = await Promise.all(input.reference_attachment_ids.map(id => getAttachment(db, id, userId)))
  if (references.some(value => value === undefined)) throw new ArtifactRunInputError('reference attachment not found', 404)

  let conversation = input.conversation_id === undefined
    ? await createConversation(db, {
        user_id: userId, title: input.prompt.trim().slice(0, 80), kind: 'image',
        provider_id: null, model_id: null, image_provider_id: provider.id, image_model_id: model.model_id,
      })
    : await getConversation(db, input.conversation_id, userId)
  if (!conversation || conversation.kind !== 'image') throw new ArtifactRunInputError('image conversation not found', 404)
  const expectedHead = conversation.head_message_id
  const seq = await maxSeq(db, conversation.id, userId)
  const referenceParts: Part[] = input.reference_attachment_ids.map(attachment_id => ({ type: 'image', attachment_id }))
  const promptMessage = await insertMessage(db, userId, {
    conversation_id: conversation.id, parent_id: expectedHead, seq: seq + 1, role: 'user',
    parts: [...referenceParts, { type: 'text', text: input.prompt }], provider_id: null, model_id: null,
    usage: null, status: 'done', error: null, created_at: Date.now(),
  })
  const outputMessage = await insertMessage(db, userId, {
    conversation_id: conversation.id, parent_id: promptMessage.id, seq: seq + 2, role: 'assistant', parts: [],
    provider_id: provider.id, model_id: model.model_id, usage: null, status: 'done', error: null, created_at: Date.now(),
  })
  const advanced = await compareAndSwapConversationHead(db, conversation.id, userId, expectedHead, outputMessage.id)
  if (!advanced) throw new ArtifactRunInputError('image conversation changed concurrently', 409)
  conversation = advanced

  const workflowId = `artifact-${userId}-${input.client_request_id}`
  const [run] = await db.insert(artifactRuns).values({
    user_id: userId, client_request_id: input.client_request_id, kind: 'image_generation', source: 'studio',
    operation: input.reference_attachment_ids.length ? 'edit' : 'generate', status: 'queued',
    conversation_id: conversation.id, message_id: outputMessage.id, provider_id: provider.id,
    provider_name: provider.name, interface_id: selected.id, interface_protocol: selected.protocol,
    credential_version: provider.credential_version, model_id: model.model_id,
    model_name: model.metadata_resolved.name ?? model.model_id, prompt: input.prompt, params: input.params,
    workflow_instance_id: workflowId, created_at: Date.now(),
  }).returning()
  if (input.reference_attachment_ids.length) await db.insert(artifactRunInputs).values(
    input.reference_attachment_ids.map((attachment_id, position) => ({ run_id: run!.id, attachment_id, position })),
  )
  try {
    const instance = await ctx.env.ARTIFACT_WORKFLOW.create({ id: workflowId, params: { userId, runId: run!.id } })
    disposeRpcStub(instance)
  } catch {
    await db.update(artifactRuns).set({ status: 'failed', error: 'Could not start image generation', completed_at: Date.now() })
      .where(and(eq(artifactRuns.id, run!.id), eq(artifactRuns.user_id, userId)))
    throw new Error('Could not start image generation')
  }
  return { run_id: run!.id, conversation_id: conversation.id, message_id: outputMessage.id }
}
