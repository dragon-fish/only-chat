/** One line per failing input, from ComfyUI's `node_errors`, whose shape is not guaranteed. */
export function nodeErrorLines(nodeErrors: Record<string, unknown> | undefined): string[] {
  const lines: string[] = []
  for (const [nodeId, value] of Object.entries(nodeErrors ?? {})) {
    const node = value as { class_type?: unknown, errors?: unknown }
    const label = typeof node?.class_type === 'string' ? `#${nodeId} ${node.class_type}` : `#${nodeId}`
    const errors = Array.isArray(node?.errors) ? node.errors as Array<{ message?: unknown, details?: unknown }> : []
    if (!errors.length) lines.push(label)
    for (const error of errors) {
      const text = [error?.message, error?.details].filter(part => typeof part === 'string' && part).join(': ')
      lines.push(text ? `${label}: ${text}` : label)
    }
  }
  return lines
}
