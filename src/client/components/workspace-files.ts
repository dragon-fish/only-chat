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

/** Extension → Shiki language. Unknown extensions are shown as plain text rather than guessed at. */
const LANGUAGES: Record<string, string> = {
  md: 'markdown', markdown: 'markdown', html: 'html', htm: 'html', css: 'css', scss: 'scss',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', tsx: 'tsx', jsx: 'jsx',
  json: 'json', yml: 'yaml', yaml: 'yaml', toml: 'toml', xml: 'xml', svg: 'xml', sql: 'sql',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', c: 'c', h: 'c', cpp: 'cpp',
  sh: 'bash', bash: 'bash', zsh: 'bash', vue: 'vue', csv: 'csv',
}

export function extensionOf(relativePath: string): string {
  const name = relativePath.slice(relativePath.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

export function languageOf(relativePath: string): string {
  return LANGUAGES[extensionOf(relativePath)] ?? 'text'
}

/** Only a page can be rendered; everything else is read as source. */
export function isRenderable(relativePath: string): boolean {
  const extension = extensionOf(relativePath)
  return extension === 'html' || extension === 'htm'
}
