/**
 * How any text file is read to a model, a page at a time: `cat -n` numbering, 1-based offsets.
 * Workspace files and text assets go through this one function, so a model never has to learn two
 * formats for the same act.
 */

export const DEFAULT_READ_LINES = 2000
export const MAX_RESULT_BYTES = 100 * 1024

export interface LinesRead {
  content: string
  startLine: number
  returnedLines: number
  totalLines: number
  truncated: boolean
  nextOffset: number | null
  /** Distinguishes an empty file from one holding a single newline. */
  empty: boolean
}

/** A page of `content`, or null when the range starts past the end or nothing fits the budget. */
export function readLines(content: string, range: { offset?: number, limit?: number }): LinesRead | null {
  if (content === '') {
    return { content: '', startLine: 0, returnedLines: 0, totalLines: 0, truncated: false, nextOffset: null, empty: true }
  }
  const lines = content.split('\n')
  const offset = Math.max(1, range.offset ?? 1)
  if (offset > lines.length) return null
  const limit = Math.max(1, range.limit ?? DEFAULT_READ_LINES)

  const selected: string[] = []
  let usedBytes = 0
  for (let index = offset - 1; index < Math.min(lines.length, offset - 1 + limit); index++) {
    const rendered = `${index + 1} | ${lines[index]}`
    // Never silently drop content: stop at the budget and report the range that did fit.
    if (usedBytes + rendered.length > MAX_RESULT_BYTES && selected.length > 0) break
    selected.push(rendered)
    usedBytes += rendered.length + 1
  }
  if (selected.length === 0) return null

  const endLine = offset + selected.length - 1
  const truncated = endLine < lines.length
  return {
    content: selected.join('\n'),
    startLine: offset,
    returnedLines: selected.length,
    totalLines: lines.length,
    truncated,
    nextOffset: truncated ? endLine + 1 : null,
    empty: false,
  }
}
