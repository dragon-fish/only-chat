import type { FileRecord } from '@/shared/workspace-files'

export type { FileRecord }

/**
 * Bytes as a reader wants them. The unit is picked so the number stays short — a file panel is
 * scanned, not audited, and the exact byte count is in the preview.
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kib = bytes / 1024
  if (kib < 1024) return `${kib < 10 ? kib.toFixed(1) : Math.round(kib)} KB`
  return `${(kib / 1024).toFixed(1)} MB`
}

/** The one line under a file's path. */
export function fileMetaLine(record: FileRecord): string {
  return [
    formatFileSize(record.fileSize),
    `${record.totalLines} 行`,
    `v${record.version}`,
    new Date(record.updatedAt).toLocaleString(),
  ].join(' · ')
}
