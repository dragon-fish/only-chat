import { getLanguageIcon } from 'markstream-vue'
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

/**
 * What a file can be shown as besides its source.
 *
 * `markdown` renders through the same renderer and the same `safe` HTML policy the chat already
 * applies to every reply, so it executes nothing and needs no opt-in. A `page` — HTML or SVG alike —
 * can execute, which is why it stays behind the plugin's own setting and inside a sandboxed frame.
 */
export type PreviewKind = 'markdown' | 'page' | null

/** SVG counts as a page: it can carry script and event handlers, so it belongs in the sandbox too. */
const PAGE_EXTENSIONS = new Set(['html', 'htm', 'svg'])

export function previewKind(relativePath: string): PreviewKind {
  const extension = extensionOf(relativePath)
  if (extension === 'md' || extension === 'markdown') return 'markdown'
  return PAGE_EXTENSIONS.has(extension) ? 'page' : null
}

/** One line of the file list: a folder to fold, or a file to act on. */
export type FileTreeRow =
  | { kind: 'dir', key: string, name: string, path: string, depth: number, count: number }
  | { kind: 'file', key: string, name: string, depth: number, record: FileRecord }

interface DirNode {
  files: FileRecord[]
  dirs: Map<string, DirNode>
}

function emptyDir(): DirNode {
  return { files: [], dirs: new Map() }
}

function insert(root: DirNode, record: FileRecord): void {
  const segments = record.relativePath.split('/')
  const name = segments.pop()!
  let node = root
  for (const segment of segments) {
    let child = node.dirs.get(segment)
    if (!child) {
      child = emptyDir()
      node.dirs.set(segment, child)
    }
    node = child
  }
  node.files.push({ ...record, relativePath: name })
}

function countFiles(node: DirNode): number {
  return node.files.length + [...node.dirs.values()].reduce((total, child) => total + countFiles(child), 0)
}

function walk(node: DirNode, prefix: string, depth: number, expanded: ReadonlySet<string>, out: FileTreeRow[]): void {
  for (const [name, child] of [...node.dirs].sort((a, b) => a[0].localeCompare(b[0]))) {
    const path = prefix === '' ? name : `${prefix}/${name}`
    out.push({ kind: 'dir', key: `dir:${path}`, name, path, depth, count: countFiles(child) })
    // A closed folder hides its whole subtree, which is the only reason to close one.
    if (expanded.has(path)) walk(child, path, depth + 1, expanded, out)
  }
  for (const record of [...node.files].sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
    out.push({ kind: 'file', key: `file:${record.id}`, name: record.relativePath, depth, record })
  }
}

/**
 * A flat list of paths stops being readable the moment a model writes a page as several files in
 * several folders, so the panel shows the shape it actually wrote: folders first, then files, each
 * named by its own last segment. Flattened rather than nested so one loop renders it.
 *
 * Folders start closed. A workspace is skimmed for the one thing that was just written, and a dozen
 * files spilled across three folders is the state this replaced.
 */
export function fileTreeRows(files: readonly FileRecord[], expanded: ReadonlySet<string> = new Set()): FileTreeRow[] {
  const root = emptyDir()
  for (const record of files) insert(root, record)
  const out: FileTreeRow[] = []
  walk(root, '', 0, expanded, out)
  return out
}

/** The same icon the chat's code blocks carry, so a file reads as the kind of file it is. */
export function fileIcon(relativePath: string): string {
  return getLanguageIcon(languageOf(relativePath))
}

/** What a row shows beside its name. Version and timestamp live in the preview, not in the list. */
export function fileRowMeta(record: FileRecord): string {
  return `${formatFileSize(record.fileSize)} · ${record.totalLines} 行`
}
