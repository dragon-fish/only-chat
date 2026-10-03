import type { Part } from '@/shared/parts'
import { MEMORY_SAVE_TOOL_ID } from '@/shared/plugins'
import { EDIT_FILE_TOOL_ID, RESTORE_FILE_TOOL_ID, WRITE_FILE_TOOL_ID } from '../shared'
import type { RestoreFileOutput, WriteFileOutput } from '../shared'

/** What one turn left behind, as the message footer lists it. */
export interface TurnFile {
  path: string
  version: number
  fileSize: number
  totalLines: number
  /** The turn brought this file into existence, rather than changing one that was already there. */
  created: boolean
}

function isFailure(content: unknown): boolean {
  return typeof content === 'object' && content !== null && 'error' in content
}

/**
 * The files a finished turn wrote, newest state per file, in the order they first appeared. A turn
 * that rewrites one file four times produced one file, not four; the tool cards above already show
 * every call for anyone who wants the sequence.
 */
export function filesWrittenInTurn(parts: readonly Part[]): TurnFile[] {
  const byPath = new Map<string, TurnFile>()
  for (const part of parts) {
    if (part.type !== 'tool_result' || isFailure(part.content)) continue

    let file: TurnFile | undefined
    // An edit leaves behind a version like any other write, and its output is a write's output. So
    // does a memory save that carried content; one that only described a file has no version.
    if (part.name === WRITE_FILE_TOOL_ID || part.name === EDIT_FILE_TOOL_ID || part.name === MEMORY_SAVE_TOOL_ID) {
      const output = part.content as WriteFileOutput
      if (typeof output?.path !== 'string' || typeof output.version !== 'number') continue
      file = {
        path: output.path,
        version: output.version,
        fileSize: output.fileSize,
        totalLines: output.totalLines,
        created: output.operation === 'created',
      }
    }
    else if (part.name === RESTORE_FILE_TOOL_ID) {
      const output = part.content as RestoreFileOutput
      if (typeof output?.path !== 'string') continue
      // Restoring always lands on a name that was free, so it is always a new file.
      file = { path: output.path, version: output.version, fileSize: output.fileSize, totalLines: output.totalLines, created: true }
    }
    if (!file) continue

    const seen = byPath.get(file.path)
    // A file created and then rewritten in the same turn is still new to the reader.
    byPath.set(file.path, seen ? { ...file, created: seen.created } : file)
  }
  return [...byPath.values()]
}
