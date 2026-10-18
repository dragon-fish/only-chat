import { toast } from 'vue-sonner'

/**
 * Tells a page it outlived a deploy. After one, the old bundle's lazy chunks no longer exist, and
 * every click that needs one fails to load and looks like a hang. This module is imported
 * statically on purpose: a lazily loaded check would be the first thing to fail that way.
 */

const CLIENT_BUILD = import.meta.env.BUILD_VERSION ?? 'dev'

let shown = false

function promptReload(): void {
  if (shown) return
  shown = true
  toast.warning('网页已更新到新版本', {
    description: '刷新后再继续，否则部分功能可能加载失败。',
    duration: Infinity,
    action: { label: '刷新', onClick: () => location.reload() },
  })
}

/** Compares the Worker's build, sent with every snapshot, to this page's. 'dev' never compares. */
export function noticeServerBuild(server: string | undefined): void {
  if (!server || server === 'dev' || CLIENT_BUILD === 'dev' || server === CLIENT_BUILD) return
  promptReload()
}

// Vite fires this when a lazy chunk fails to load, which is how a stale page usually finds out
// before its socket reconnects.
if (typeof window !== 'undefined') {
  // Not preventDefault(): that would swallow the error and hand the importer undefined instead.
  window.addEventListener('vite:preloadError', promptReload)
}
