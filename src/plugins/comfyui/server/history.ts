import type { HistoryEntry, OutputImage } from './client'

export const MAX_OUTPUT_IMAGES = 10

export type HistoryOutcome =
  | { state: 'pending' }
  | { state: 'error', message: string }
  | { state: 'success', images: OutputImage[], durationMs: number | null }

function timestampOf(entry: HistoryEntry, event: string): number | null {
  const found = entry.status?.messages?.find(([name]) => name === event)
  const value = found?.[1]?.timestamp
  return typeof value === 'number' ? value : null
}

/**
 * Reads a finished prompt. Images come in node-id order, then in each node's own order, so the
 * outputs of a workflow keep a stable index across runs.
 */
export function readHistory(entry: HistoryEntry | null): HistoryOutcome {
  if (!entry?.status) return { state: 'pending' }
  if (entry.status.status_str === 'error') {
    const failure = entry.status.messages?.find(([name]) => name === 'execution_error')?.[1]
    const where = typeof failure?.node_type === 'string' ? ` (${failure.node_type} #${String(failure.node_id)})` : ''
    const message = typeof failure?.exception_message === 'string'
      ? `${failure.exception_message.trim()}${where}`
      : entry.status.messages?.some(([name]) => name === 'execution_interrupted') ? 'Interrupted on the ComfyUI side' : 'ComfyUI reported an execution error'
    return { state: 'error', message }
  }
  if (!entry.status.completed) return { state: 'pending' }
  const images: OutputImage[] = []
  const nodeIds = Object.keys(entry.outputs ?? {}).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
  for (const nodeId of nodeIds) {
    for (const image of entry.outputs![nodeId]?.images ?? []) images.push(image)
  }
  const start = timestampOf(entry, 'execution_start')
  const end = timestampOf(entry, 'execution_success')
  return { state: 'success', images: images.slice(0, MAX_OUTPUT_IMAGES), durationMs: start !== null && end !== null ? end - start : null }
}
