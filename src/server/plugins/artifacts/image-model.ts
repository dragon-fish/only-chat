import type { DB } from '@/server/db/client'
import type { ConversationRow } from '@/server/db/schema'
import type { ModelRef } from '@/shared/model-ref'
import type { UserSettings } from '@/shared/models'
import { getModel, getProvider } from '../hub/conversations'

/** The conversation's own image model, else the user's global image slot; null when neither is usable. */
export async function resolveImageModel(
  db: DB,
  userId: number,
  conversation: Pick<ConversationRow, 'image_provider_id' | 'image_model_id'>,
  settings: UserSettings,
): Promise<ModelRef | null> {
  const candidates: ModelRef[] = []
  if (conversation.image_provider_id !== null && conversation.image_model_id !== null) {
    candidates.push({ provider_id: conversation.image_provider_id, model_id: conversation.image_model_id })
  }
  if (settings.service_models?.image) candidates.push(settings.service_models.image)
  for (const ref of candidates) {
    const provider = await getProvider(db, ref.provider_id, userId)
    const model = provider ? await getModel(db, provider.id, ref.model_id, userId) : undefined
    if (provider?.enabled && model?.enabled && model.supports_image_output) return ref
  }
  return null
}
