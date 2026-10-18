import { toast } from 'vue-sonner'
import { BUILD_HEADER } from '@/shared/build'

/**
 * Tells a page it outlived a deploy. An old bundle talks to a newer API, and once its lazy chunks
 * are gone every click that needs one fails to load and looks like a hang. The server's build
 * arrives on every API response (`BUILD_HEADER`) and every socket snapshot. This module is imported
 * statically on purpose: a lazily loaded check would be the first thing to fail that way.
 */

const CLIENT_BUILD = import.meta.env.BUILD_VERSION ?? 'dev'

let shown = false

function promptReload(): void {
  if (shown) return
  shown = true
  toast.warning('有新版本啦', {
    description: '点击刷新按钮，立即体验最新功能',
    duration: Infinity,
    action: { label: '刷新', onClick: () => location.reload() },
  })
}

/** Compares the Worker's build to this page's. 'dev' never compares. */
export function noticeServerBuild(server: string | undefined): void {
  if (!server || server === 'dev' || CLIENT_BUILD === 'dev' || server === CLIENT_BUILD) return
  promptReload()
}

/**
 * A lazy chunk that failed to load is a deploy only if the server says so: a dropped connection
 * fails the same way, and must not be announced as an update. Asked only after such a failure.
 */
export async function verifyAfterChunkFailure(): Promise<void> {
  try {
    const res = await fetch('/api/health', { cache: 'no-store' })
    noticeServerBuild(res.headers.get(BUILD_HEADER) ?? undefined)
  } catch { /* Offline: not a version problem, and the failed import reports itself. */ }
}

// Not preventDefault(): that would swallow the error and hand the importer undefined instead.
if (typeof window !== 'undefined') window.addEventListener('vite:preloadError', () => void verifyAfterChunkFailure())
