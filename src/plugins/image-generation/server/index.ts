import type { Context } from 'cordis'
import { tool } from 'ai'
import { resolveImageModel } from '@/server/plugins/artifacts/image-model'
import { createToolImageRun } from '@/server/plugins/artifacts/runs'
import { getConversation, getUser } from '@/server/plugins/hub/conversations'
import { GENERATE_IMAGE_TOOL_ID, IMAGE_GENERATION_PLUGIN_ID } from '@/shared/plugins'
import { GenerateImageInputSchema, type GenerateImageOutput } from '../shared'

const DESCRIPTION = [
  'Generate or edit images in the background with the image model the user configured.',
  'To edit, or to draw from existing images, pass reference_images as file references: the asset: in [image asset:…] labels of images the user sent, in [generated image asset:…] labels, or in task notifications.',
  'Returns immediately with a task_id. The result arrives later as a <task-notification> message listing the new images as asset: references;',
  'do not wait, poll, or call again for the same request. Tell the user it is on its way, or continue with other work.',
  'If the notification says generation failed, read the provider\'s reason, adjust the prompt if that helps, and try again at most once.',
  'The user already sees the new images with the notification; do not embed them again. To point at particular ones in your reply, for example to compare two, write ![short description](asset:<hex>).',
].join('\n')

export const NO_IMAGE_MODEL = 'No image model is configured. Ask the user to choose one in Settings → Service models or in Image Studio.'

export const ImageGenerationServerPlugin = {
  name: 'image-generation',
  inject: ['tools', 'fileReader', 'db', 'env'] as const,
  apply(ctx: Context) {
    ctx.tools.register(IMAGE_GENERATION_PLUGIN_ID, GENERATE_IMAGE_TOOL_ID, toolCtx => tool({
      description: DESCRIPTION,
      inputSchema: GenerateImageInputSchema,
      execute: async (input, { toolCallId }): Promise<GenerateImageOutput> => {
        const [conversation, user] = await Promise.all([
          getConversation(toolCtx.db, toolCtx.conversationId, toolCtx.userId),
          getUser(toolCtx.db, toolCtx.userId),
        ])
        if (!conversation || !user) return { error: 'Conversation not found.' }
        const model = await resolveImageModel(toolCtx.db, toolCtx.userId, conversation, user.settings)
        if (!model) return { error: NO_IMAGE_MODEL }
        // Through the file reader, so any scheme an enabled plugin provides works here too.
        const references: number[] = []
        for (const ref of input.reference_images ?? []) {
          const resolved = await ctx.fileReader.resolve(ctx.fileReader.turnOf(toolCtx.turn), ref)
          if (!resolved.ok) return { error: resolved.message, code: resolved.error }
          if (resolved.value.kind !== 'binary' || !resolved.value.mime.startsWith('image/')) {
            return { error: `${ref} is ${resolved.value.mime}, not an image. reference_images takes images only.`, code: 'UNSUPPORTED_FILE' }
          }
          references.push(resolved.value.attachmentId)
        }
        const count = input.count ?? 1
        try {
          const { run_id } = await createToolImageRun(ctx, toolCtx.userId, {
            conversationId: conversation.id, messageId: toolCtx.assistantMessageId, toolCallId, model,
            prompt: input.prompt, params: { count, size: input.size ?? null }, references,
          })
          return { task_id: `image_run:${run_id}`, status: 'started', count, model: model.model_id }
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) }
        }
      },
    }))
  },
}
