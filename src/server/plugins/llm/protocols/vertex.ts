import type { Context } from 'cordis'
import { createGoogleVertex } from '@ai-sdk/google-vertex/edge'
import { z } from 'zod'

const ServiceAccountSchema = z.object({
  client_email: z.string(),
  private_key: z.string(),
  private_key_id: z.string().optional(),
})
const ExtraSchema = z.object({ project: z.string(), location: z.string() })

export const vertexProtocol = {
  name: 'llm-vertex',
  inject: ['llm'],
  apply(ctx: Context) {
    ctx.llm.register('vertex', {
      createModel(provider, model, apiKey) {
        const sa = ServiceAccountSchema.parse(JSON.parse(apiKey))
        const extra = ExtraSchema.parse(provider.extra ?? {})
        const p = createGoogleVertex({
          project: extra.project,
          location: extra.location,
          googleCredentials: { clientEmail: sa.client_email, privateKey: sa.private_key, privateKeyId: sa.private_key_id },
        })
        return p(model.model_id)
      },
    })
  },
}
