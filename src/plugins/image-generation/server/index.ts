import type { Context } from 'cordis'
import { tool } from 'ai'
import { resolveImageModel } from '@/server/plugins/artifacts/image-model'
import { createToolImageRun } from '@/server/plugins/artifacts/runs'
import { getConversation, getUser } from '@/server/plugins/hub/conversations'
import { GENERATE_IMAGE_TOOL_ID, IMAGE_GENERATION_PLUGIN_ID } from '@/shared/plugins'
import { whileOffered } from '@/server/plugins/prompt-sections'
import manifest from '../manifest'
import { GenerateImageInputSchema, type GenerateImageOutput } from '../shared'

const DESCRIPTION = [
  'Generate or edit images in the background with the image model the user configured.',
  'To edit, or to draw from existing images, pass reference_images as file references: the asset: in [image asset:…] labels of images the user sent, in [generated image asset:…] labels, or in task notifications.',
  'Returns immediately with a task_id; the images arrive later as a <task-notification> message listing them as asset: references.',
].join('\n')

/** What to do while an image is on its way, and once it arrives. */
const GUIDANCE = [
  'generate_image works in the background: do not wait, poll, or call it again for the same request. Tell the user it is on its way, or carry on with other work.',
  'When the task notification arrives the user already sees the new images; do not show them again unless pointing at particular ones. If it says generation failed, read the provider\'s reason, adjust the prompt if that helps, and try again at most once.',
].join(' ')

export const NO_IMAGE_MODEL = 'No image model is configured. Ask the user to choose one in Settings → Service models or in Image Studio.'

export const ImageGenerationServerPlugin = {
  name: 'image-generation',
  inject: ['tools', 'fileReader', 'db', 'env', 'promptSections'] as const,
  apply(ctx: Context) {
    ctx.promptSections.register(IMAGE_GENERATION_PLUGIN_ID, whileOffered(manifest, GUIDANCE))
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
