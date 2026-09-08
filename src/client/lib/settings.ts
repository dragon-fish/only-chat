import type { ModelWriteInput } from '@/shared/api'
import type { ModelWithMetadata } from '@/shared/models'

export function isChatHistoryRoute(path: unknown): boolean {
  if (typeof path !== 'string') return false
  const pathname = path.split(/[?#]/)[0]
  return pathname === '/chats' || pathname === '/new' || pathname === '/projects'
    || /^\/c\/[^/]+$/.test(pathname ?? '')
    || /^\/project\/[^/]+(?:\/(?:new|c\/[^/]+))?$/.test(pathname ?? '')
}

/** Keep server replacements in click order and never publish a read overtaken by another edit. */
export function createModelWriteQueue(options: {
  write: (id: number, patch: Partial<ModelWriteInput>) => Promise<unknown>
  read: () => Promise<ModelWithMetadata[] | null>
  apply: (models: ModelWithMetadata[]) => void
  onError: (error: unknown) => void
}) {
  let writes: Promise<unknown> = Promise.resolve()
  let writeSeq = 0
  return (id: number, patch: Partial<ModelWriteInput>): Promise<boolean> => {
    const seq = ++writeSeq
    const operation = writes.then(async () => {
      let saved = true
      try { await options.write(id, patch) }
      catch (error) { saved = false; options.onError(error) }
      if (seq !== writeSeq) return saved
      try {
        const models = await options.read()
        if (seq === writeSeq && models !== null) options.apply(models)
      }
      catch (error) { options.onError(error) }
      return saved
    })
    writes = operation
    return operation
  }
}
/** Settings broadcasts contain the whole record and may acknowledge only part of local intent. */
export function acknowledgedPlugins(pending: ReadonlyMap<string, boolean>, plugins: Record<string, boolean>): string[] {
  return [...pending].filter(([key, value]) => plugins[key] === value).map(([key]) => key)
}
