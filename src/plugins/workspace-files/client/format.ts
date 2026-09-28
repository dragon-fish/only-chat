/** Shared presentation helpers for the three workspace file cards. */

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** The last segment, which is what a reader looks for; the full path stays in the tooltip. */
export function basename(path: string): string {
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed
}

export const MOUNT_LABELS: Record<string, string> = {
  '/project': 'Project 共享',
  '/conversation': '本会话私有',
  '/artifacts': '本会话生成的图片',
  '/uploads': '本会话上传的文件',
}

export const MOUNT_STATUS_LABELS: Record<string, string> = {
  empty: '暂无文件',
  ready: '有文件',
  unavailable: '不可用',
}
