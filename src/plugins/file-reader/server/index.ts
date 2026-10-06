import type { Context } from 'cordis'
import { tool, type Tool } from 'ai'
import { FILE_READER_PLUGIN_ID, READ_FILE_TOOL_ID } from '@/shared/plugins'
import { stripToolAttachments } from '@/shared/parts'
import { ReadFileInputSchema, type FileToolError, type ReadDeliveredOutput } from '../shared'
import { fileToolError } from './refs'
import { FileReader, type FileTurn } from './service'
import { addVisibleAssets, loadVisibleAssets } from './visible'
import { whileOffered } from '@/server/plugins/prompt-sections'
import manifest from '../manifest'

/** How files are named, for every tool that takes one. read_file's own text is how to read one. */
const GUIDANCE = [
  'A file in this conversation is labelled with an asset:<hex> reference, and that reference is how you name it to any tool that takes a file.',
  'An image in this conversation can be shown to the user in your reply as ![short description](asset:<hex>).',
].join(' ')

/**
 * `toModelOutput` for a tool that may hand over a file. The SDK builds the in-turn tool message from
 * the raw output, while the rebuilt history reads the stored part, which never has the reserved key;
 * without this the two would differ and the prompt prefix would stop matching.
 */
export const withoutToolAttachments: NonNullable<Tool['toModelOutput']> = ({ output }) =>
  ({ type: 'json', value: stripToolAttachments(output) as never })

export const FileReaderServerPlugin = {
  name: 'file-reader',
  inject: ['tools', 'db', 'assets', 'promptSections'] as const,
  async apply(ctx: Context) {
    await ctx.plugin(FileReader)
    ctx.promptSections.register(FILE_READER_PLUGIN_ID, whileOffered(manifest, GUIDANCE))

    ctx.inject(['fileReader'], (ctx) => {
      // Only a turn that offers read_file names files at all: without it the model has no use for a
      // reference, and the core keeps tool context out of the conversation.
      ctx.on('generation/prepare', async (turn) => {
        if (!turn.toolIds.includes(READ_FILE_TOOL_ID)) return
        const fileTurn: FileTurn = {
          userId: turn.userId, conversationId: turn.conversationId, projectId: turn.projectId,
          toolIds: turn.toolIds, path: turn.visible, state: turn.state, canReadFile: turn.canReadFile,
          // Authorization stays on the structural path (spec §1.3); see `FileTurn`.
          visible: await loadVisibleAssets(ctx.db.orm, turn.userId, turn.path),
        }
        ctx.fileReader.begin(fileTurn)
        turn.labeler = ctx.fileReader.labeler(fileTurn)
      })

      ctx.on('generation/interjected', async (turn, messages) => {
        if (!turn.toolIds.includes(READ_FILE_TOOL_ID)) return
        await addVisibleAssets(ctx.db.orm, turn.userId, messages, ctx.fileReader.turnOf(turn.state).visible)
      })

      ctx.tools.register(FILE_READER_PLUGIN_ID, READ_FILE_TOOL_ID, runtime => tool({
        description: [
          'Read a file. `file` is a file reference, such as the asset:<hex> a file in this conversation is labelled with.',
          'Text comes back numbered in cat -n format, starting at line 1, so you can cite positions — strip that prefix before quoting text elsewhere. 2,000 lines per call by default and up to 5,000 with limit, never more than 100 KiB; pass offset and limit when you know which part you need, and follow nextOffset when the result is truncated. Nothing is dropped silently.',
          'An image, PDF, audio or video file is shown to you whole instead: the result is a short receipt and the file follows in a user message inside <tool_attachment>. offset and limit do not apply. If you cannot read that kind of file, the error says so and may say where else it can go.',
        ].join(' '),
        inputSchema: ReadFileInputSchema,
        // The model reads the receipt without the reserved key; the file arrives in the message after it.
        toModelOutput: withoutToolAttachments,
        async execute(input): Promise<object | ReadDeliveredOutput | FileToolError> {
          const turn = ctx.fileReader.turnOf(runtime.turn)
          const resolved = await ctx.fileReader.resolve(turn, input.file)
          if (!resolved.ok) return fileToolError(resolved)
          if (resolved.value.kind === 'text') {
            const page = await resolved.value.read({ offset: input.offset, limit: input.limit })
            return page.ok ? page.value : fileToolError(page)
          }
          const delivered = ctx.fileReader.deliver(turn, resolved.value, input.file)
          return delivered.ok ? delivered.value : fileToolError(delivered)
        },
      }))
    })
  },
}
