import type { ModelInput } from '@/shared/api'
import { ReasoningEffortSchema, type Model, type ModelCapabilities, type ReasoningEffort } from '@/shared/models'

export function isChatHistoryRoute(path: unknown): boolean {
  if (typeof path !== 'string') return false
  const pathname = path.split(/[?#]/)[0]
  return pathname === '/' || pathname === '/chats' || /^\/c\/[^/]+$/.test(pathname ?? '')
}

export function modelCapabilitiesWithEfforts(capabilities: ModelCapabilities, efforts: readonly ReasoningEffort[]): ModelCapabilities {
  const next = { ...capabilities }
  const ordered = ReasoningEffortSchema.options.filter(effort => efforts.includes(effort))
  // Absence is the canonical undeclared state; downstream treats an empty list as unrestricted.
  if (ordered.length) next.reasoning_efforts = ordered
  else delete next.reasoning_efforts
  return next
}

/** Keep server replacements in click order and never publish a read overtaken by another edit. */
export function createModelWriteQueue(options: {
  write: (id: number, patch: Partial<ModelInput>) => Promise<unknown>
  read: () => Promise<Model[]>
  apply: (models: Model[]) => void
  onError: (error: unknown) => void
}) {
  let writes: Promise<unknown> = Promise.resolve()
  let writeSeq = 0
  return (id: number, patch: Partial<ModelInput>): Promise<boolean> => {
    const seq = ++writeSeq
    const operation = writes.then(async () => {
      let saved = true
      try { await options.write(id, patch) }
      catch (error) { saved = false; options.onError(error) }
      if (seq !== writeSeq) return saved
      try {
        const models = await options.read()
        if (seq === writeSeq) options.apply(models)
      }
      catch (error) { options.onError(error) }
      return saved
    })
    writes = operation
    return operation
  }
}
