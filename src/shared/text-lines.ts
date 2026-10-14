/**
 * How any text file is read to a model, a page at a time: `cat -n` numbering, 1-based offsets.
 * Workspace files and text assets go through this one function, so a model never has to learn two
 * formats for the same act.
 *
 * The prefix is a right-aligned number and one tab — the format agent models read files in most.
 * Keep the separator a tab: a space-based one such as `1 | ` runs into the line's own indentation.
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
    const rendered = `${String(index + 1).padStart(6)}\t${lines[index]}`
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

/**
 * A page as a reader wants it: the number apart from the text, so it can sit in a gutter that a copy
 * never picks up. Only the first tab separates them. A line without that prefix — a result stored
 * before the format was `cat -n` — is kept whole with no number.
 */
export function splitNumberedLines(content: string): Array<{ number: number | null, text: string }> {
  return content.split('\n').map((line) => {
    const match = /^ *(\d+)\t/.exec(line)
    return match ? { number: Number(match[1]), text: line.slice(match[0].length) } : { number: null, text: line }
  })
}
