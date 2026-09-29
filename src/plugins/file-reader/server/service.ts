import { Context, Service } from 'cordis'
import { and, eq, gte, lt } from 'drizzle-orm'
import { attachments, type AttachmentRow } from '@/server/db/schema'
import { textFile, type FileLabeler } from '@/server/plugins/llm/messages'
import type { GenerationTurn } from '@/server/plugins/hub/generation-turn'
import { ASSET_REF_LENGTH, assetPrefix, assetRef } from '@/shared/asset-ref'
import { isTextMime } from '@/shared/file-media'
import type { FilePart, ImagePart } from '@/shared/parts'
import { TOOL_ATTACHMENTS_KEY } from '@/shared/parts'
import { readLines } from '@/shared/text-lines'
import type { ReadAssetTextOutput } from '../shared'
import { parseFileRef, prefixUpperBound, refFailure, type FileResult } from './refs'
import type { VisibleAssets } from './visible'

declare module 'cordis' {
  interface Context {
    fileReader: FileReader
  }
}

/** What this plugin knows about one generation. Lives in `GenerationTurn.state`, i.e. `ToolContext.turn`. */
export interface FileTurn extends Omit<GenerationTurn, 'labeler'> {
  visible: VisibleAssets
}

/** A file the model is shown whole. `ref` is always the `asset:` form; `sha256` never leaves the server. */
export interface ResolvedBinary {
  kind: 'binary'
  attachmentId: number
  sha256: string
  ref: string
  mime: string
  size: number
  width: number | null
  height: number | null
  filename: string | null
}

/**
 * A file read as numbered lines. Its provider decides what a page carries besides the lines — a
 * workspace file adds its version — so `read` returns the tool's whole output.
 */
export interface ResolvedText {
  kind: 'text'
  ref: string
  mime: string
  size: number
  filename: string | null
  /** Present when the text is one stored attachment, so a copy can point at the same bytes. */
  attachmentId?: number
  read(range: { offset?: number, limit?: number }): Promise<FileResult<object>>
}

export type ResolvedFile = ResolvedBinary | ResolvedText

/**
 * Resolves what another plugin registered for. Returns `undefined` when it does not serve this turn —
 * the reference then reads as an unsupported scheme — and a result, success or failure, otherwise.
 * It authorizes its own references: the reader trusts whatever it returns.
 */
export type SchemeResolver = (turn: FileTurn, body: string, cited: string) => Promise<FileResult<ResolvedFile> | undefined>

/** A sentence telling the model where else a file it cannot read could go, or nothing. */
export type UnreadableHint = (turn: FileTurn, mime: string, cited: string) => string | undefined

/** The receipt `read_file` returns for a file it hands over; the reserved key never persists. */
export interface DeliveredFile {
  file: string
  /** What the person called the file, for a card to show; null for one that was never named (a pasted or generated image). */
  name: string | null
  mime: string
  message: string
  [TOOL_ATTACHMENTS_KEY]: number[]
}

const TURN_KEY = 'file_reader:turn'

/**
 * A text upload up to this size is inlined, as if pasted; a larger one is only named, and read_file
 * pages through it. The core inlines every text file — this limit exists only because a tool to read
 * the rest is on hand.
 */
export const INLINE_TEXT_BYTES = 32 * 1024

export function binaryFromAttachment(
  row: Pick<AttachmentRow, 'id' | 'sha256' | 'mime' | 'size' | 'width' | 'height'>,
  filename: string | null,
): ResolvedBinary {
  return {
    kind: 'binary', attachmentId: row.id, sha256: row.sha256, ref: assetRef(row.sha256),
    mime: row.mime, size: row.size, width: row.width, height: row.height, filename,
  }
}

/** The shortest prefix length, past what was asked, that tells every match apart. */
function distinguishingLength(digests: readonly string[], asked: number): number {
  for (let length = Math.max(asked + 1, ASSET_REF_LENGTH + 1); length < 64; length++) {
    if (new Set(digests.map(digest => digest.slice(0, length))).size === digests.length) return length
  }
  return 64
}

/**
 * The file half of a generation (spec §4.4): references in, files out. Other plugins reach files
 * only through this service, so a scheme one of them registers is usable by every tool at once.
 */
export class FileReader extends Service {
  static readonly provide = 'fileReader'
  static readonly inject = ['db', 'assets']

  private readonly schemes = new Map<string, SchemeResolver>()
  private barePaths: SchemeResolver | undefined
  private readonly hints = new Set<UnreadableHint>()

  constructor(ctx: Context) {
    super(ctx, 'fileReader')
  }

  /** Belongs to the caller's lifecycle: disposing the registering plugin removes its scheme. */
  registerScheme(scheme: string, resolver: SchemeResolver, options: { barePaths?: boolean } = {}): () => void {
    if (this.schemes.has(scheme)) throw new Error(`file scheme already registered: ${scheme}`)
    if (options.barePaths && this.barePaths) throw new Error('bare paths are already claimed')
    return this.ctx.effect(() => {
      this.schemes.set(scheme, resolver)
      if (options.barePaths) this.barePaths = resolver
      return () => {
        if (this.schemes.get(scheme) === resolver) this.schemes.delete(scheme)
        if (this.barePaths === resolver) this.barePaths = undefined
      }
    }, `fileReader.registerScheme(${scheme})`) as () => void
  }

  registerHint(hint: UnreadableHint): () => void {
    return this.ctx.effect(() => {
      this.hints.add(hint)
      return () => { this.hints.delete(hint) }
    }, 'fileReader.registerHint') as () => void
  }

  /** Records the turn; `generation/prepare` calls this once `read_file` is on. */
  begin(turn: FileTurn): void {
    turn.state.set(TURN_KEY, turn)
  }

  /**
   * The turn a tool runs in, from its `ToolContext.turn`. Every plugin that reaches files requires
   * this one, and the server adds `read_file` to any turn that offers them, so a missing turn is a
   * broken invariant rather than a state to handle.
   */
  turnOf(state: Map<string, unknown>): FileTurn {
    const turn = state.get(TURN_KEY) as FileTurn | undefined
    if (!turn) throw new Error('file reader is not active in this generation')
    return turn
  }

  async resolve(turn: FileTurn, ref: string): Promise<FileResult<ResolvedFile>> {
    const parsed = parseFileRef(ref)
    if (!parsed.ok) return parsed
    const value = parsed.value
    if (value.kind === 'path') {
      const claimed = this.barePaths ? await this.barePaths(turn, value.path, ref) : undefined
      return claimed ?? refFailure('INVALID_FILE_REF', `"${ref}" is a path, and nothing enabled in this turn serves paths. Use the asset:<hex> a file is labelled with.`)
    }
    if (value.kind === 'scheme') {
      const resolver = this.schemes.get(value.scheme)
      const claimed = resolver ? await resolver(turn, value.body, ref) : undefined
      return claimed ?? refFailure('UNSUPPORTED_SCHEME', `Nothing enabled in this turn can open ${value.scheme}: references.`)
    }

    // Every row of this user under the prefix — a handful at most, found through the index — then
    // only the visible ones. Unlimited on purpose, and not `inArray(visible ids)`: a limit applied
    // first could cut away the visible row, and D1 binds at most 100 parameters.
    const upper = prefixUpperBound(value.prefix)
    const rows = await this.ctx.db.orm.select().from(attachments).where(and(
      eq(attachments.user_id, turn.userId),
      gte(attachments.sha256, value.prefix),
      ...(upper === null ? [] : [lt(attachments.sha256, upper)]),
    ))
    const matches = rows.filter(row => turn.visible.has(row.id))
    if (matches.length === 0) {
      return refFailure('FILE_NOT_FOUND', `No file ${ref} in this conversation. Use a reference it showed you, such as the asset: in a file label.`)
    }
    if (matches.length > 1) {
      const length = distinguishingLength(matches.map(row => row.sha256), value.prefix.length)
      const refs = matches.map(row => `asset:${row.sha256.slice(0, length)}`).join(', ')
      return refFailure('AMBIGUOUS_ASSET', `${ref} matches more than one file: ${refs}. Pass the one you mean.`)
    }
    const row = matches[0]!
    const filename = turn.visible.get(row.id)?.filename ?? null
    if (!isTextMime(row.mime)) return { ok: true, value: binaryFromAttachment(row, filename) }
    const asset = assetRef(row.sha256)
    return {
      ok: true,
      value: {
        kind: 'text', ref: asset, mime: row.mime, size: row.size, filename, attachmentId: row.id,
        read: async (range) => {
          const stored = await this.ctx.assets.getBytes(row.r2_key)
          if (!stored) return refFailure('FILE_NOT_FOUND', `${asset} is no longer stored.`)
          const lines = readLines(new TextDecoder().decode(stored.bytes), range)
          if (!lines) return refFailure('READ_RANGE_TOO_LARGE', 'That range is past the end of the file, or too large to return. Use a smaller offset and limit.')
          return { ok: true, value: { file: asset, name: filename, ...lines } satisfies ReadAssetTextOutput }
        },
      },
    }
  }

  hint(turn: FileTurn, mime: string, cited: string): string {
    for (const hint of this.hints) {
      const said = hint(turn, mime, cited)
      if (said) return ` ${said}`
    }
    return ''
  }

  /** Spec §4.6. `cited` is the reference the caller used, repeated in any suggestion. */
  deliver(turn: FileTurn, file: ResolvedBinary, cited: string): FileResult<DeliveredFile> {
    if (!turn.canReadFile(file.mime)) {
      return refFailure('UNSUPPORTED_FILE', `The current model cannot read ${file.mime}.${this.hint(turn, file.mime, cited)}`)
    }
    const prefix = assetPrefix(file.sha256)
    turn.visible.add(file.attachmentId, { prefix, filename: file.filename })
    return {
      ok: true,
      value: {
        file: file.ref,
        name: file.filename,
        mime: file.mime,
        message: `The file follows in a user message, inside <tool_attachment asset="${prefix}">.`,
        [TOOL_ATTACHMENTS_KEY]: [file.attachmentId],
      },
    }
  }

  labeler(turn: FileTurn): FileLabeler {
    return fileLabeler(turn.visible, (mime, cited) => this.hint(turn, mime, cited))
  }
}

/**
 * Spec §4.5. Pure over what the turn has seen, so a rebuilt history reads as the request did.
 * `hint` finishes the sentence saying a file cannot be read, given the reference it is named by.
 */
export function fileLabeler(visible: VisibleAssets, hint: (mime: string, cited: string) => string): FileLabeler {
  const prefixOf = (attachmentId: number) => {
    const seen = visible.get(attachmentId)
    if (!seen) throw new Error(`attachment ${attachmentId} is not visible to this turn`)
    return seen.prefix
  }
  return {
    userFile: (part: ImagePart | FilePart, mime: string) => {
      const name = part.filename ? ` ${JSON.stringify(part.filename)}` : ''
      const prefix = prefixOf(part.attachment_id)
      return part.type === 'image' ? `[image asset:${prefix}${name}]` : `[file asset:${prefix}${name} ${mime}]`
    },
    userText: (part: FilePart, text: string) => {
      const prefix = prefixOf(part.attachment_id)
      if (new TextEncoder().encode(text).byteLength <= INLINE_TEXT_BYTES) return textFile(part, text, ` asset="${prefix}"`)
      const name = part.filename ? ` ${JSON.stringify(part.filename)}` : ''
      return `[file asset:${prefix}${name} ${part.mime}, ${text.split('\n').length} lines — read it with read_file]`
    },
    generatedImage: part => `[generated image asset:${prefixOf(part.attachment_id)}]`,
    toolAttachment: attachmentId => visible.get(attachmentId)?.prefix,
    unreadableHint: (mime, attachmentId) => hint(mime, `asset:${prefixOf(attachmentId)}`),
  }
}
