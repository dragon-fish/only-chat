import type { Context } from 'cordis'
import { tool } from 'ai'
import { getUser } from '@/server/plugins/hub/conversations'
import { fileToolError } from '@/plugins/file-reader/server/refs'
import { AnalyzeFileInputSchema, ANALYZE_FILE_TOOL_ID, FILE_UNDERSTANDING_PLUGIN_ID, type AnalyzeFileOutput, type FileToolError } from '../shared'
import { resolveFileUnderstanding, type FileUnderstanding } from './service'

const DESCRIPTION = [
  'Ask the configured file understanding model to describe an image, PDF, audio or video in detail.',
  '`file` is the asset:<hex> a file is labelled with, or a workspace path when workspace files are on.',
  'Pass question to ask something specific; omit it for a complete description. The answer comes back as text.',
  'Use it for files you cannot read yourself, or when a careful second reading helps. Text files are read with read_file.',
].join(' ')

const SERVICE_KEY = 'file_understanding:service'

/**
 * `analyze_file`, and the hint that points `read_file` at it. The service model is resolved once per
 * turn, and only for a turn that offers the tool; a settings edit mid-turn applies to the next one.
 */
export const FileUnderstandingServerPlugin = {
  name: 'file-understanding',
  inject: ['tools', 'fileReader', 'db', 'assets', 'llm'] as const,
  apply(ctx: Context) {
    ctx.on('generation/prepare', async (turn) => {
      if (!turn.toolIds.includes(ANALYZE_FILE_TOOL_ID)) return
      const user = await getUser(ctx.db.orm, turn.userId)
      if (!user) return
      const service = await resolveFileUnderstanding({ db: ctx.db.orm, userId: turn.userId, assets: ctx.assets, llm: ctx.llm }, user.settings)
      if (service) turn.state.set(SERVICE_KEY, service)
    })

    const serviceOf = (state: Map<string, unknown>) => state.get(SERVICE_KEY) as FileUnderstanding | undefined

    // Suggesting a tool that would refuse is worse than silence: only when it is on and can read this.
    ctx.fileReader.registerHint((turn, mime, cited) => (
      turn.toolIds.includes(ANALYZE_FILE_TOOL_ID) && serviceOf(turn.state)?.canRead(mime)
        ? `Call analyze_file with file ${cited} and an optional question instead.`
        : undefined
    ))

    ctx.tools.register(FILE_UNDERSTANDING_PLUGIN_ID, ANALYZE_FILE_TOOL_ID, runtime => tool({
      description: DESCRIPTION,
      inputSchema: AnalyzeFileInputSchema,
      async execute({ file, question }): Promise<AnalyzeFileOutput | FileToolError> {
        const turn = ctx.fileReader.turnOf(runtime.turn)
        const resolved = await ctx.fileReader.resolve(turn, file)
        if (!resolved.ok) return fileToolError(resolved)
        if (resolved.value.kind === 'text') {
          return { error: 'UNSUPPORTED_FILE', message: `${file} is a text file. Read it with read_file.` }
        }
        const { attachmentId, ref, mime } = resolved.value
        const service = serviceOf(runtime.turn)
        if (!service) {
          return { error: 'SERVICE_UNAVAILABLE', message: 'No file understanding model is available. Ask the user to choose one in Settings → Service models.' }
        }
        if (!service.canRead(mime)) {
          return { error: 'UNSUPPORTED_FILE', message: `The file understanding model or its interface cannot read ${mime}.` }
        }
        try {
          const result = await service.analyze(attachmentId, question, runtime.signal)
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
