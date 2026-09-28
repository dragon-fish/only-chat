import type { Context } from 'cordis'
import { tool } from 'ai'
import { fileToolError, withoutToolAttachments } from '@/server/plugins/file-refs/deliver'
import {
  AnalyzeFileInputSchema, ANALYZE_FILE_TOOL_ID, FILE_UNDERSTANDING_PLUGIN_ID, VIEW_FILE_TOOL_ID, ViewFileInputSchema,
  type AnalyzeFileOutput, type FileToolError, type ViewFileOutput,
} from '../shared'

const VIEW_DESCRIPTION = [
  'Look at a file yourself: an image, PDF, audio or video named by a file reference such as asset:3f9a2c1e.',
  'The result is a short receipt; the file follows in a user message inside <tool_attachment>.',
  'If you cannot read that kind of file, the error says so and, when it would help, suggests analyze_file.',
].join(' ')

const ANALYZE_DESCRIPTION = [
  'Ask the configured file understanding model to describe an image, PDF, audio or video in detail, named by a file reference such as asset:3f9a2c1e.',
  'Pass question to ask something specific; omit it for a complete description. The answer comes back as text.',
  'Use it for files you cannot read yourself, or when a careful second reading helps. For workspace text files use read_file.',
].join(' ')

/**
 * `view_file` and `analyze_file`. Both take any file reference through the runtime resolver, so they
 * work on whatever schemes the enabled plugins provide without depending on any of them.
 */
export const FileUnderstandingServerPlugin = {
  name: 'file-understanding',
  inject: ['tools'] as const,
  apply(ctx: Context) {
    ctx.tools.register(FILE_UNDERSTANDING_PLUGIN_ID, VIEW_FILE_TOOL_ID, runtime => tool({
      description: VIEW_DESCRIPTION,
      inputSchema: ViewFileInputSchema,
      // The model reads the receipt without the reserved key; the file arrives in the message after it.
      toModelOutput: withoutToolAttachments,
      async execute({ file }): Promise<ViewFileOutput | FileToolError> {
        const resolved = await runtime.files.resolve(file)
        if (!resolved.ok) return fileToolError(resolved)
        const delivered = runtime.files.deliver(resolved.value, file)
        return delivered.ok ? delivered.value : fileToolError(delivered)
      },
    }))

    ctx.tools.register(FILE_UNDERSTANDING_PLUGIN_ID, ANALYZE_FILE_TOOL_ID, runtime => tool({
      description: ANALYZE_DESCRIPTION,
      inputSchema: AnalyzeFileInputSchema,
      async execute({ file, question }): Promise<AnalyzeFileOutput | FileToolError> {
        const resolved = await runtime.files.resolve(file)
        if (!resolved.ok) return fileToolError(resolved)
        const { ref, mime } = resolved.value
        const understanding = runtime.files.understanding
        if (!understanding) {
          return { error: 'SERVICE_UNAVAILABLE', message: 'No file understanding model is available. Ask the user to choose one in Settings → Service models.' }
        }
        if (!understanding.canRead(mime)) {
          return { error: 'UNSUPPORTED_FILE', message: `The file understanding model or its interface cannot read ${mime}.` }
        }
        try {
          const result = await understanding.analyze(resolved.value, question, runtime.signal)
          return { file: ref, mime, ...result }
        } catch (error) {
          // Stopping the generation stops the analysis with it; that is not a failed analysis.
          if (runtime.signal.aborted) throw error
          return { error: 'ANALYSIS_FAILED', message: error instanceof Error ? error.message : String(error) }
        }
      },
    }))
  },
}
