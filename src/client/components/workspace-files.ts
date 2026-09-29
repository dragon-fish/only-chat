import { getLanguageIcon } from 'markstream-vue'
import type { ConversationAsset } from '@/shared/conversation-assets'
import { fileModality, isTextMime } from '@/shared/file-media'
import type { FileRecord } from '@/shared/workspace-files'

export type { ConversationAsset, FileRecord }

/**
 * What a file is shown as, decided by its stored type and never by its name: a binary file copied
 * into the workspace keeps whatever name the model gave it.
 */
export type MediaKind = 'image' | 'pdf' | 'audio' | 'video' | 'text' | 'binary'

export function mediaKind(mime: string): MediaKind {
  if (isTextMime(mime)) return 'text'
  return fileModality(mime) ?? 'binary'
}

/** What a preview is opened on: a workspace file by id, or a conversation asset by attachment. */
export type PreviewTarget =
  | { kind: 'file', id: number }
  /** `url` overrides the attachment route, for a viewer that reaches files another way (the audit). */
  | { kind: 'asset', attachmentId: number, mime: string, name: string, url?: string }

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
  return mediaKind(record.mime) === 'text'
    ? `${formatFileSize(record.fileSize)} · ${record.totalLines} 行`
    : formatFileSize(record.fileSize)
}

const KIND_LABELS: Record<MediaKind, string> = { image: '图片', pdf: 'PDF', audio: '音频', video: '视频', text: '文件', binary: '文件' }

/** The name a person gave the file; a pasted or generated one is named by what it is and when it came. */
export function assetName(asset: ConversationAsset): string {
  if (asset.filename) return asset.filename
  const time = new Date(asset.createdAt).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  return `${KIND_LABELS[mediaKind(asset.mime)]} · ${time}`
}

export function assetRowMeta(asset: ConversationAsset): string {
  const size = formatFileSize(asset.size)
  return asset.width && asset.height ? `${size} · ${asset.width}×${asset.height}` : size
}

/**
 * What a tool card calls a file, or null when nothing names it. Never the reference itself:
 * `asset:3f9a2c1e` is how the model names a file, not how a person does. The name a result carries
 * wins; a path gives its last segment.
 */
function namedFile(ref: string | undefined, name?: string | null): string | null {
  if (name) return name
  const path = ref?.startsWith('vfs:') ? ref.slice(4) : ref
  if (!path?.startsWith('/')) return null
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed
}

/** A file nobody named is called by what it is. */
export function fileLabel(ref: string | undefined, name?: string | null, mime?: string): string {
  return namedFile(ref, name) ?? (mime?.startsWith('image/') ? '图片' : '文件')
}

/** `读取 cars.csv` for a named file, `读取文件` for one that is only a kind: no space before a generic noun. */
export function fileAction(verb: string, ref: string | undefined, name?: string | null, mime?: string): string {
  const named = namedFile(ref, name)
  return named === null ? `${verb}${fileLabel(ref, name, mime)}` : `${verb} ${named}`
}
