/** A `Storage` that lives and dies with the page. */
export class MemoryStorage implements Storage {
  private readonly items = new Map<string, string>()

  constructor(initial: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(initial)) this.items.set(key, value)
  }

  get length(): number { return this.items.size }
  clear(): void { this.items.clear() }
  getItem(key: string): string | null { return this.items.get(key) ?? null }
  key(index: number): string | null { return [...this.items.keys()][index] ?? null }
  removeItem(key: string): void { this.items.delete(key) }
  setItem(key: string, value: string): void { this.items.set(key, String(value)) }
}

/**
 * The demo shares an origin with the real app, so it must never write the real app's keys (the
 * chosen model, drafts, panel sizes). Only the theme is carried over, read once, so the demo opens
 * in the visitor's own light or dark mode.
 */
export function installMemoryStorage(seed: Record<string, string>): void {
  let theme: string | null = null
  try { theme = window.localStorage.getItem('oc.theme') } catch {}
  const local = new MemoryStorage({ ...(theme ? { 'oc.theme': theme } : {}), ...seed })
  Object.defineProperty(window, 'localStorage', { value: local, configurable: true })
  Object.defineProperty(window, 'sessionStorage', { value: new MemoryStorage(), configurable: true })
}
