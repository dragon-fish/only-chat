import type { Message } from '@/shared/models'
import {
  COPY_FILE_TOOL_ID, DELETE_FILE_TOOL_ID, EDIT_FILE_TOOL_ID, MEMORY_SAVE_TOOL_ID, READ_FILE_TOOL_ID, RENAME_FILE_TOOL_ID,
  RESTORE_FILE_TOOL_ID, WRITE_FILE_TOOL_ID,
} from '@/shared/plugins'
import type { CompactionData } from '../shared'

export type FileLists = CompactionData['files']

/** Tools whose result's `path` is a file they wrote. */
const WRITING_TOOLS: readonly string[] = [WRITE_FILE_TOOL_ID, EDIT_FILE_TOOL_ID, MEMORY_SAVE_TOOL_ID, RESTORE_FILE_TOOL_ID, COPY_FILE_TOOL_ID]

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [])

/** A result that answered: neither marked as a thrown error nor a refusal the tool returned. */
function successful(content: unknown): Record<string, unknown> | null {
  if (typeof content !== 'object' || content === null || Array.isArray(content)) return null
  const record = content as Record<string, unknown>
  return record.error === undefined ? record : null
}

/**
 * The workspace files the messages' successful tool calls read and changed (spec §3.6), by canonical
 * path as the results report them. A file both read and changed counts as changed. Merged onto
 * `previous`, the lists the last checkpoint recorded.
 */
export function touchedFiles(messages: readonly Message[], previous?: FileLists | null): FileLists {
  const read = new Set(previous?.read ?? [])
  const modified = new Set(previous?.modified ?? [])
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== 'tool_result' || part.is_error) continue
      const result = successful(part.content)
      if (!result) continue
      const path = typeof result.path === 'string' ? result.path : null
      if (WRITING_TOOLS.includes(part.name)) {
        if (path) modified.add(path)
      } else if (part.name === RENAME_FILE_TOOL_ID) {
        const fromPath = typeof result.fromPath === 'string' ? result.fromPath : null
        const moved = strings(result.moved)
        // `moved` lists destinations; each source is the same file under the old directory.
        for (const to of moved.length > 0 ? moved : path ? [path] : []) {
          modified.add(to)
          if (fromPath && path && to.startsWith(path)) modified.add(`${fromPath}${to.slice(path.length)}`)
        }
        if (fromPath && moved.length === 0) modified.add(fromPath)
      } else if (part.name === DELETE_FILE_TOOL_ID) {
        const deleted = strings(result.deleted)
        for (const gone of deleted.length > 0 ? deleted : path ? [path] : []) modified.add(gone)
      } else if (part.name === READ_FILE_TOOL_ID) {
        // An `asset:` read reports `file`, not `path`: it is not a workspace file.
        if (path) read.add(path)
      }
    }
  }
  for (const path of modified) read.delete(path)
  return { read: [...read], modified: [...modified] }
}

/** The file lists a checkpoint's `data` holds, if this plugin wrote it. */
export function previousFiles(data: unknown): FileLists | null {
  if (typeof data !== 'object' || data === null) return null
  const files = (data as Partial<CompactionData>).files
  if (typeof files !== 'object' || files === null) return null
  return { read: strings(files.read), modified: strings(files.modified) }
}
