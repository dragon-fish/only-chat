import type { Part } from './parts'

/**
 * Fold new parts into what is already waiting.
 *
 * Adjacent text is joined with a blank line rather than kept as separate parts: someone typing
 * three sentences while they wait is composing one remark, and delivering it as three would read
 * to the model as being interrupted three times. Images keep their own parts, in the order sent.
 */
export function joinStash(held: readonly Part[], added: readonly Part[]): Part[] {
  const out = [...held]
  for (const part of added) {
    const last = out.at(-1)
    if (part.type === 'text' && last?.type === 'text') out[out.length - 1] = { ...last, text: `${last.text}\n${part.text}` }
    else out.push(part)
  }
  return out
}

