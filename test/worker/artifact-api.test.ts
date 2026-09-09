import { env } from 'cloudflare:workers'
import { eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { createApp } from '@/server/app'
import { createDb } from '@/server/db/client'
import { artifactRuns, attachments, models, providerInterfaces, providers } from '@/server/db/schema'
import { encryptSecret } from '@/server/plugins/llm/crypto'
import { authenticatedRequest, registerAndLogin, signupBody } from './auth-helper'

async function seedImageModel(userId: number) {
  const db = createDb(env.DB)
  const [provider] = await db.insert(providers).values({
    user_id: userId, name: 'Images', api_key: await encryptSecret(env.KEY_ENCRYPTION_SECRET, 'image-key'), created_at: 0,
  }).returning()
  const [selected] = await db.insert(providerInterfaces).values({
    provider_id: provider!.id, protocol: 'responses', base_url: 'https://images.example/v1', created_at: 0,
  }).returning()
  await db.update(providers).set({ default_interface_id: selected!.id }).where(eq(providers.id, provider!.id))
  await db.insert(models).values({
    provider_id: provider!.id, model_id: 'image-model', enabled: true, supports_image_input: true,
    supports_image_output: true, metadata_resolved: { name: 'Image Model', modalities: { input: ['text', 'image'], output: ['image'] } },
  })
  return provider!.id
}

describe('Artifact API', () => {
  it('durably hands off one idempotent Studio run and creates its image Conversation', async () => {
    const client = await registerAndLogin()
    const identity = await (await client.request('/api/auth/get-session')).json() as { user: { id: string } }
    const userId = Number(identity.user.id)
    const providerId = await seedImageModel(userId)
    const create = vi.fn(async ({ id }: { id: string }) => ({ id, dispose() {} }))
    const app = await createApp({ env: { ...env, ARTIFACT_WORKFLOW: { create } } as unknown as Env, side: 'worker' })
    const body = {
      client_request_id: crypto.randomUUID(), model: { provider_id: providerId, model_id: 'image-model' },
      prompt: 'A sea otter', reference_attachment_ids: [], params: { count: 1, size: null },
    }

    const first = await authenticatedRequest(app.api, '/api/artifact-runs/image', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    expect(first.status).toBe(202)
    const created = await first.json() as { run_id: number; conversation_id: number; message_id: number }
    const retry = await authenticatedRequest(app.api, '/api/artifact-runs/image', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    expect(await retry.json()).toEqual(created)
    expect(create).toHaveBeenCalledOnce()
    expect(await createDb(env.DB).query.artifactRuns.findFirst({ where: eq(artifactRuns.id, created.run_id) }))
      .toMatchObject({ user_id: userId, status: 'queued', operation: 'generate', conversation_id: created.conversation_id, message_id: created.message_id })
    expect(await createDb(env.DB).query.conversations.findFirst({ where: (row, { eq }) => eq(row.id, created.conversation_id) }))
      .toMatchObject({ user_id: userId, kind: 'image', image_provider_id: providerId, image_model_id: 'image-model' })
  })

  it('rejects another user\'s reference before starting a Workflow', async () => {
    const alice = await registerAndLogin({ name: 'Alice', email: 'artifact-alice@example.com', password: 'a-long-test-password' })
    const bob = await registerAndLogin({ name: 'Bob', email: 'artifact-bob@example.com', password: 'a-long-test-password' })
    const aliceId = Number(((await (await alice.request('/api/auth/get-session')).json()) as { user: { id: string } }).user.id)
    const bobId = Number(((await (await bob.request('/api/auth/get-session')).json()) as { user: { id: string } }).user.id)
    const providerId = await seedImageModel(aliceId)
    const [foreign] = await createDb(env.DB).insert(attachments).values({
      user_id: bobId, sha256: crypto.randomUUID(), mime: 'image/png', size: 4, r2_key: `${bobId}/foreign`, origin: 'upload', created_at: 0,
    }).returning()
    const create = vi.fn()
    const app = await createApp({ env: { ...env, ARTIFACT_WORKFLOW: { create } } as unknown as Env, side: 'worker' })
    const response = await app.api.request('/api/artifact-runs/image', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: alice.cookie }, body: JSON.stringify({
        client_request_id: crypto.randomUUID(), model: { provider_id: providerId, model_id: 'image-model' },
        prompt: 'Edit it', reference_attachment_ids: [foreign!.id], params: { count: 1, size: null },
      }),
    })
    expect(response.status).toBe(404)
    expect(create).not.toHaveBeenCalled()
  })
})
