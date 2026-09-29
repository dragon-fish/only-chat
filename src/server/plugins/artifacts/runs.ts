import type { Context } from 'cordis'
import { and, eq } from 'drizzle-orm'
import type { CreateImageRunInput, CreateImageRunResponse, ImageGenerationParams } from '@/shared/artifacts'
import type { ModelRef } from '@/shared/model-ref'
import type { DB } from '@/server/db/client'
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

/** The provider, model and Images-capable interface a run would use, or the reason it cannot. */
async function resolveImageTarget(db: DB, userId: number, ref: ModelRef, referenceIds: readonly number[]) {
  const provider = await getProvider(db, ref.provider_id, userId)
  const model = provider ? await getModel(db, provider.id, ref.model_id, userId) : undefined
  if (!provider || !provider.enabled || !model || !model.enabled) throw new ArtifactRunInputError('image model not found', 404)
  if (!model.supports_image_output) throw new ArtifactRunInputError('model does not support image output')
  if (referenceIds.length && !model.supports_image_input) throw new ArtifactRunInputError('model does not support image input')
  const interfaceId = model.interface_id ?? provider.default_interface_id
  const selected = interfaceId === null ? undefined : await getProviderInterface(db, interfaceId, userId)
  if (!selected || selected.provider_id !== provider.id || !IMAGE_PROTOCOLS.has(selected.protocol)) {
    throw new ArtifactRunInputError('model interface does not support the Images API')
  }
  return { provider, model, selected }
}

export async function createImageRun(ctx: Context, userId: number, input: CreateImageRunInput): Promise<CreateImageRunResponse> {
  const db = ctx.db.orm
  const existing = await db.query.artifactRuns.findFirst({
    where: and(eq(artifactRuns.user_id, userId), eq(artifactRuns.client_request_id, input.client_request_id)),
  })
  if (existing?.conversation_id && existing.message_id) {
    return { run_id: existing.id, conversation_id: existing.conversation_id, message_id: existing.message_id }
  }

  const { provider, model, selected } = await resolveImageTarget(db, userId, input.model, input.reference_attachment_ids)
  const references = await Promise.all(input.reference_attachment_ids.map(id => getAttachment(db, id, userId)))
  if (references.some(value => value === undefined)) throw new ArtifactRunInputError('reference attachment not found', 404)

  if (references.some(value => !value!.mime.startsWith('image/'))) throw new ArtifactRunInputError('reference must be an image')

  const createdConversation = input.conversation_id === undefined
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
  const hub = ctx.env.USER_HUB.getByName(String(userId))
  try {
    await hub.publishConversation(userId, conversation, createdConversation)
  } catch {
    // Realtime navigation is an acceleration path; the durable Conversation and REST snapshot remain authoritative.
    console.warn('Could not broadcast image conversation update')
  } finally {
    disposeRpcStub(hub)
  }
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

export interface ToolImageRunInput {
  conversationId: number
  /** The assistant message holding the tool call. */
  messageId: number
  toolCallId: string
  model: ModelRef
  prompt: string
  params: ImageGenerationParams
  /** Attachment ids of the images to edit; empty for a plain generation. */
  references: readonly number[]
}

/**
 * A run started by the Agent inside a chat. Unlike Studio it writes no messages and never moves
 * the head: the assistant message holding the call stays exactly as the turn left it, and the
 * outcome returns through a task notification.
 */
export async function createToolImageRun(ctx: Context, userId: number, input: ToolImageRunInput): Promise<{ run_id: number }> {
  const db = ctx.db.orm
  const clientRequestId = toolClientRequestId(input.messageId, input.toolCallId)
  const existing = await findToolRun(db, userId, input.messageId, input.toolCallId)
  if (existing) return { run_id: existing.id }
  const { provider, model, selected } = await resolveImageTarget(db, userId, input.model, input.references)
  const workflowId = toolWorkflowId(userId, input.messageId, input.toolCallId)
  const [run] = await db.insert(artifactRuns).values({
    user_id: userId, client_request_id: clientRequestId, kind: 'image_generation', source: 'tool', operation: input.references.length ? 'edit' : 'generate',
    status: 'queued', conversation_id: input.conversationId, message_id: input.messageId, tool_call_id: input.toolCallId,
    provider_id: provider.id, provider_name: provider.name, interface_id: selected.id, interface_protocol: selected.protocol,
    credential_version: provider.credential_version, model_id: model.model_id, model_name: model.metadata_resolved.name ?? model.model_id,
    prompt: input.prompt, params: input.params, workflow_instance_id: workflowId, created_at: Date.now(),
  }).returning()
  if (input.references.length) await db.insert(artifactRunInputs).values(
    input.references.map((attachment_id, position) => ({ run_id: run!.id, attachment_id, position })),
  )
  await startRunWorkflow(ctx, userId, run!.id, workflowId)
  return { run_id: run!.id }
}

export interface BackendToolRunInput {
  conversationId: number
  /** The assistant message holding the tool call. */
  messageId: number
  toolCallId: string
  /** The protocol the backend is registered under in `imageBackends`. */
  protocol: string
  /** Shown where a provider's name would be. */
  sourceName: string
  modelId: string
  modelName: string
  prompt: string
  params: ImageGenerationParams
  state: Record<string, unknown>
}

/**
 * A tool run executed by an `imageBackends` entry instead of a provider model. The caller has
 * already done whatever the backend needs up front, and checks `findToolRun` first so a replayed
 * call does not repeat it.
 */
export async function createBackendToolRun(ctx: Context, userId: number, input: BackendToolRunInput): Promise<{ run_id: number }> {
  const workflowId = toolWorkflowId(userId, input.messageId, input.toolCallId)
  const [run] = await ctx.db.orm.insert(artifactRuns).values({
    user_id: userId, client_request_id: toolClientRequestId(input.messageId, input.toolCallId), kind: 'image_generation',
    source: 'tool', operation: 'generate', status: 'queued', conversation_id: input.conversationId, message_id: input.messageId,
    tool_call_id: input.toolCallId, provider_id: null, provider_name: input.sourceName, interface_id: null,
    interface_protocol: input.protocol, credential_version: 0, model_id: input.modelId, model_name: input.modelName,
    prompt: input.prompt, params: input.params, backend_state: input.state, workflow_instance_id: workflowId, created_at: Date.now(),
  }).returning()
  await startRunWorkflow(ctx, userId, run!.id, workflowId)
  return { run_id: run!.id }
}

export function findToolRun(db: DB, userId: number, messageId: number, toolCallId: string) {
  return db.query.artifactRuns.findFirst({
    where: and(eq(artifactRuns.user_id, userId), eq(artifactRuns.client_request_id, toolClientRequestId(messageId, toolCallId))),
  })
}

function toolClientRequestId(messageId: number, toolCallId: string): string {
  return `tool:${messageId}:${toolCallId}`
}

/** Workflow instance ids allow only letters, digits, `-` and `_`. */
function toolWorkflowId(userId: number, messageId: number, toolCallId: string): string {
  return `artifact-${userId}-tool-${messageId}-${toolCallId.replace(/[^A-Za-z0-9_-]/g, '_')}`.slice(0, 100)
}

async function startRunWorkflow(ctx: Context, userId: number, runId: number, workflowId: string): Promise<void> {
  try {
    disposeRpcStub(await ctx.env.ARTIFACT_WORKFLOW.create({ id: workflowId, params: { userId, runId } }))
  } catch {
    await ctx.db.orm.update(artifactRuns).set({ status: 'failed', error: 'Could not start image generation', completed_at: Date.now() })
      .where(and(eq(artifactRuns.id, runId), eq(artifactRuns.user_id, userId)))
    throw new Error('Could not start image generation')
  }
}
