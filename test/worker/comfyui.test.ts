import { env } from 'cloudflare:workers'
import { and, eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '@/server/app'
import { createDb } from '@/server/db/client'
import { artifactRuns, artifacts } from '@/server/db/schema'
import { createConversation, insertMessage, listMessages, toMessage, updateConversation } from '@/server/plugins/hub/conversations'
import { notifyToolRun } from '@/server/plugins/artifacts/notify'
import { executeImageRun } from '@/server/plugins/artifacts/workflow'
import type { ToolContext } from '@/server/plugins/tools'
import { ComfyuiClient } from '@/plugins/comfyui/server/client'
import { runGenerate } from '@/plugins/comfyui/server/generate'
import { COMFYUI_CONFIG_SCHEMA, ComfyuiGenerateInputSchema } from '@/plugins/comfyui/shared'
import { registerAndLogin } from './auth-helper'

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])

const TEMPLATE = {
  1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'base.safetensors' } },
  2: { class_type: 'CLIPTextEncode', inputs: { text: 'masterpiece', clip: ['1', 1] }, _meta: { title: 'Positive' } },
  3: { class_type: 'CLIPTextEncode', inputs: { text: 'lowres', clip: ['1', 1] }, _meta: { title: 'Negative' } },
  4: { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
  5: { class_type: 'KSampler', inputs: {
    seed: 1, steps: 20, cfg: 5, sampler_name: 'euler', scheduler: 'normal', denoise: 1,
    model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0],
  } },
  6: { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
  7: { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: 'out' } },
}

interface Server {
  submitted: Array<Record<string, Record<string, { inputs: Record<string, unknown> }>>>
  history: Record<string, unknown>
  reject?: Record<string, unknown>
}

/** Answers the endpoints the plugin uses, the way ComfyUI does. */
function stubComfyui(server: Server) {
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const url = new URL(input)
    if (url.pathname === '/api/userdata/api-workflows%2Fbase.json') return Response.json(TEMPLATE)
    if (url.pathname === '/api/prompt' && init?.method === 'POST') {
      if (server.reject) return Response.json(server.reject, { status: 400 })
      server.submitted.push((JSON.parse(String(init.body)) as { prompt: Server['submitted'][number] }).prompt)
      return Response.json({ prompt_id: `p-${server.submitted.length}`, number: 1, node_errors: {} })
    }
    if (url.pathname.startsWith('/api/history/')) return Response.json(server.history)
    if (url.pathname === '/api/view') return new Response(png, { headers: { 'Content-Type': 'image/png' } })
    return new Response('404: Not Found', { status: 404 })
  })
}

async function setup(email: string) {
  const client = await registerAndLogin({ name: 'Painter', email, password: 'a-long-test-password' })
  const userId = Number(((await (await client.request('/api/auth/get-session')).json()) as { user: { id: string } }).user.id)
  const db = createDb(env.DB)
  const conversation = await createConversation(db, { user_id: userId, title: 'chat', provider_id: null, model_id: null })
  // No model on the reply, so delivering the notification writes it without starting a turn.
  const reply = await insertMessage(db, userId, {
    conversation_id: conversation.id, parent_id: null, seq: 1, role: 'assistant',
    parts: [{ type: 'tool_call', id: 'call_1', name: 'comfyui_generate', args: {} }],
    provider_id: null, model_id: null, usage: null, status: 'done', error: null, created_at: 0,
  })
  await updateConversation(db, conversation.id, userId, { head_message_id: reply.id })
  const app = await createApp({
    env: { ...env, ARTIFACT_WORKFLOW: { create: async ({ id }: { id: string }) => ({ id, dispose() {} }) } } as unknown as Env,
    side: 'worker',
  })
  await app.pluginConfig.write(userId, 'comfyui', { base_url: 'https://comfy.example', workflows_dir: 'api-workflows' })
  const config = COMFYUI_CONFIG_SCHEMA.parse(await app.pluginConfig.read(userId, 'comfyui'))
  const toolCtx = { db, userId, conversationId: conversation.id, assistantMessageId: reply.id } as ToolContext
  const generate = (input: unknown, toolCallId = 'call_1') =>
    runGenerate(app, toolCtx, new ComfyuiClient(config), config, ComfyuiGenerateInputSchema.parse(input), toolCallId)
  return { db, userId, conversation, generate }
}

describe('comfyui_generate', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('returns ComfyUI\'s validation report without starting a run', async () => {
    const { db, userId, generate } = await setup('comfyui-reject@example.com')
    const nodeErrors = { 7: { errors: [{ message: 'Return type mismatch' }], class_type: 'SaveImage' } }
    stubComfyui({ submitted: [], history: {}, reject: { error: { message: 'Prompt outputs failed validation' }, node_errors: nodeErrors } })
    const result = await generate({ workflow: TEMPLATE })
    expect(result).toMatchObject({ error_type: 'validation', node_errors: nodeErrors })
    expect(await db.select().from(artifactRuns).where(eq(artifactRuns.user_id, userId))).toEqual([])
  })

  it('submits a template once, then publishes its images and tells the Agent the seed', async () => {
    const { db, userId, conversation, generate } = await setup('comfyui-template@example.com')
    const server: Server = { submitted: [], history: {} }
    stubComfyui(server)
    const input = { template: 'base', prompt: 'masterpiece, a fox', aspect_ratio: 'portrait', seed: 42 }
    const started = await generate(input)
    expect(started).toMatchObject({ status: 'started', prompt_id: 'p-1', template: 'base', seed: 42 })
    // A replayed tool call answers from the run it already made.
    expect(await generate(input)).toEqual(started)
    expect(server.submitted).toHaveLength(1)
    expect(server.submitted[0]!['2']!.inputs).toMatchObject({ text: 'masterpiece, a fox' })
    expect(server.submitted[0]!['4']!.inputs).toMatchObject({ width: 832, height: 1216 })

    const runId = Number((started as { task_id: string }).task_id.split(':')[1])
    expect(await db.query.artifactRuns.findFirst({ where: eq(artifactRuns.id, runId) })).toMatchObject({
      interface_protocol: 'comfyui', provider_id: null, model_id: 'base', params: { count: 1, size: { width: 832, height: 1216 } },
      backend_state: { prompt_id: 'p-1', template: 'base', seed: 42 },
    })

    server.history = { 'p-1': {
      outputs: { 7: { images: [{ filename: 'out_00001_.png', subfolder: '', type: 'output' }] } },
      status: { status_str: 'success', completed: true, messages: [['execution_start', { timestamp: 0 }], ['execution_success', { timestamp: 4200 }]] },
    } }
    const workflowApp = await createApp({ env, side: 'workflow' })
    await executeImageRun(workflowApp, userId, runId)
    expect(await db.query.artifactRuns.findFirst({ where: eq(artifactRuns.id, runId) }))
      .toMatchObject({ status: 'completed', backend_state: { duration_ms: 4200 } })
    expect(await db.select().from(artifacts).where(and(eq(artifacts.run_id, runId), eq(artifacts.user_id, userId)))).toHaveLength(1)

    await notifyToolRun(workflowApp, userId, runId)
    const notices = (await listMessages(db, conversation.id, userId)).flatMap(row => toMessage(row).parts)
      .filter(part => part.type === 'task_notification')
    expect(notices).toEqual([expect.objectContaining({
      task_id: `image_run:${runId}`, plugin_id: 'comfyui', status: 'completed', text: expect.stringContaining('seed 42'),
    })])
  })

  it('fails the run with the exception ComfyUI reports', async () => {
    const { db, userId, generate } = await setup('comfyui-failure@example.com')
    const server: Server = { submitted: [], history: {} }
    stubComfyui(server)
    const started = await generate({ workflow: TEMPLATE })
    const runId = Number((started as { task_id: string }).task_id.split(':')[1])
    server.history = { 'p-1': { outputs: {}, status: { status_str: 'error', completed: false, messages: [
      ['execution_error', { node_id: '5', node_type: 'KSampler', exception_message: 'CUDA out of memory' }],
    ] } } }
    await executeImageRun(await createApp({ env, side: 'workflow' }), userId, runId)
    expect(await db.query.artifactRuns.findFirst({ where: eq(artifactRuns.id, runId) }))
      .toMatchObject({ status: 'failed', error: 'CUDA out of memory (KSampler #5)' })
  })
})
