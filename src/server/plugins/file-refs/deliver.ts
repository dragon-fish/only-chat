import type { Context } from 'cordis'
import type { Tool } from 'ai'
import { ANALYZE_FILE_TOOL_ID } from '@/shared/plugins'
import { stripToolAttachments, TOOL_ATTACHMENTS_KEY } from '@/shared/parts'
import type { DB } from '../../db/client'
import type { FileUnderstanding } from '../hub/file-understanding'
import { refFailure, type FileRefFailure, type FileResult } from './ref'
import { resolveFileRef, type FileRefTurn, type ResolvedFile } from './resolve'

/**
 * The receipt a tool returns for a file it hands the model. The file itself follows as a user
 * message (spec §7.2); the reserved key carries its attachment id there and never persists.
 */
export interface DeliveredFile {
  file: string
  mime: string
  message: string
  [TOOL_ATTACHMENTS_KEY]: number[]
}

/** What the generating model can take, fixed when the generation starts. */
export interface FileReader {
  canRead(mime: string): boolean
  /** Present only when this turn offers `analyze_file` and a file understanding model resolved. */
  understanding?: FileUnderstanding
}

/**
 * Whether to point at `analyze_file` for a file this model cannot read: only when the tool is on in
 * this turn and its model can take the MIME. Suggesting a tool that would refuse is worse than silence.
 */
export function suggestsAnalyze(toolIds: readonly string[], reader: FileReader, mime: string): boolean {
  return toolIds.includes(ANALYZE_FILE_TOOL_ID) && reader.understanding?.canRead(mime) === true
}

/** Spec §3.3. `cited` is the reference the caller used, repeated in any suggestion. */
export function deliverFile(turn: FileRefTurn, reader: FileReader, file: ResolvedFile, cited: string): FileResult<DeliveredFile> {
  if (!reader.canRead(file.mime)) {
    const hint = suggestsAnalyze(turn.toolIds, reader, file.mime)
      ? ` Call analyze_file with file ${cited} and an optional question instead.`
      : ''
    return refFailure('UNSUPPORTED_FILE', `The current model cannot read ${file.mime}.${hint}`)
  }
  const prefix = file.ref.slice(file.ref.indexOf(':') + 1)
  turn.visible.add(file.attachmentId, { prefix, filename: file.filename })
  return {
    ok: true,
    value: {
      file: file.ref,
      mime: file.mime,
      message: `The file follows in a user message, inside <tool_attachment asset="${prefix}">.`,
      [TOOL_ATTACHMENTS_KEY]: [file.attachmentId],
    },
  }
}

/** How a tool reports a reference failure: the same `{ error, message }` shape every tool uses. */
export function fileToolError(failure: FileRefFailure): { error: string, message: string } {
  return { error: failure.error, message: failure.message }
}

/**
 * `toModelOutput` for a tool that may deliver a file. The SDK builds the in-turn tool message from
 * the raw output, while the rebuilt history reads the stored part, which never has the reserved
 * key; without this the two would differ and the prompt prefix would stop matching.
 */
export const withoutToolAttachments: NonNullable<Tool['toModelOutput']> = ({ output }) =>
  ({ type: 'json', value: stripToolAttachments(output) as never })

/** The file half of a tool's runtime: references in, files out, without importing any provider. */
export interface ToolFiles {
  resolve(ref: string): Promise<FileResult<ResolvedFile>>
  deliver(file: ResolvedFile, cited: string): FileResult<DeliveredFile>
  canRead(mime: string): boolean
  understanding?: FileUnderstanding
}

export function createToolFiles(ctx: Context, db: DB, turn: FileRefTurn, reader: FileReader): ToolFiles {
  return {
    resolve: ref => resolveFileRef(ctx, db, turn, ref),
    deliver: (file, cited) => deliverFile(turn, reader, file, cited),
    canRead: mime => reader.canRead(mime),
    ...(reader.understanding ? { understanding: reader.understanding } : {}),
  }
}
