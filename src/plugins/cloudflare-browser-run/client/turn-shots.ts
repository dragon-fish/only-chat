import type { Part } from '@/shared/parts'
import { BROWSER_USE_TOOL_ID } from '@/shared/plugins'
import { BrowserUseErrorSchema, BrowserUseOutputSchema } from '../shared'

/** One picture the turn took, and which call it came from. */
export interface TurnShot {
  attachmentId: number
  name: string
}

/**
 * Every screenshot a finished turn produced, in the order they were taken.
 *
 * The cards above already show each call's own pictures, and they stay there — this is not a move.
 * What it adds is the whole turn in one strip: a run that drove the browser five times scatters its
 * pictures across five cards, several of them folded, and the one worth looking at is usually the
 * last. A failed call counts too; its error screenshot is often the only evidence of what went
 * wrong.
 */
export function shotsInTurn(parts: readonly Part[]): TurnShot[] {
  const shots: TurnShot[] = []
  const seen = new Set<number>()

  for (const part of parts) {
    if (part.type !== 'tool_result' || part.name !== BROWSER_USE_TOOL_ID) continue
    const refs = BrowserUseOutputSchema.safeParse(part.content).data?.screenshots
      ?? BrowserUseErrorSchema.safeParse(part.content).data?.screenshots
      ?? []
    for (const ref of refs) {
      // A retried call can hand back the same attachment; the strip should show it once.
      if (seen.has(ref.attachment_id)) continue
      seen.add(ref.attachment_id)
      shots.push({ attachmentId: ref.attachment_id, name: ref.name })
    }
  }
  return shots
}
