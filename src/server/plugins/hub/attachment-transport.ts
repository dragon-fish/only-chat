import type { SharedV4ProviderReference } from '@ai-sdk/provider'
import { APICallError } from '@ai-sdk/provider'
import type { DB } from '../../db/client'
import type { AttachmentRow, ProviderInterfaceRow, ProviderRow } from '../../db/schema'
import type { Assets } from '../assets'
import type { Llm } from '../llm'
import { GONE, type AttachmentInput } from '../llm/messages'
import { inlineFilename, isTextMime } from '@/shared/file-media'
import { PROVIDER_FILE_TTL_SECONDS, type ScopedFilesClient } from '../llm/files/types'
import { findReusableProviderFile, getAttachment, insertProviderFile } from './conversations'

/** Spec §5.7: uploads ask the provider to expire the file after seven days. */
const PROVIDER_FILE_TTL_MS = PROVIDER_FILE_TTL_SECONDS * 1000

/**
 * Both OpenAI protocols share their Files family's option namespace. Anthropic's Files client
 * sets its expiry independently and ignores these OpenAI-specific options.
 */
const UPLOAD_OPTIONS = { openai: { purpose: 'user_data', expiresAfter: PROVIDER_FILE_TTL_SECONDS } } as const
const UNSUPPORTED_FILES_STATUSES = new Set([400, 404, 405, 501])

/** Audio and video are always sent inline (spec §6.3): never reuse or create a Files pointer for them. */
function inlineOnly(mime: string): boolean {
  return mime.startsWith('audio/') || mime.startsWith('video/')
}

export interface TransportDeps {
  db: DB
  userId: number
  assets: Assets
  llm: Llm
  signal?: AbortSignal
}

/**
 * A stored `provider_reference` is opaque provider JSON we write and read but never author, so this
 * is the one place it is given the SDK's reference type.
 */
function toReference(stored: Record<string, string>): SharedV4ProviderReference {
  return stored as SharedV4ProviderReference
}

/** OpenAI's multipart part carries no type hint of its own without a filename. */
/** The model can read a Files API name back; see `inlineFilename`. */
function filenameFor(attachment: AttachmentRow): string {
  return inlineFilename(attachment.mime)
}

/**
 * Decides how each referenced attachment reaches the model (spec §5.6). With the provider's Files
 * API enabled an unexpired pointer is reused as-is, otherwise the bytes are read from R2 once and
 * uploaded, and the resulting scoped pointer is appended to the upload history. Every other
 * case inlines the bytes.
 *
 * Upload failures propagate: an auth, rate-limit or server error is a failed turn, never a silent
 * downgrade to inline bytes (spec §4.8).
 */
export async function resolveAttachmentInputs(
  deps: TransportDeps,
  provider: ProviderRow,
  providerInterface: ProviderInterfaceRow,
  attachmentIds: Iterable<number>,
  /** Absent, every file is sent; otherwise a file this says no to is `unreadable`, and nothing is fetched for it. */
  canRead?: (mime: string) => boolean,
  /** Tool-delivered ids, the only ones allowed to have lost their row; see `toolAttachmentsMessage`. */
  mayBeGone?: ReadonlySet<number>,
): Promise<Map<number, AttachmentInput>> {
  const out = new Map<number, AttachmentInput>()
  const useFiles = deps.llm.hasFiles(providerInterface)
  // Resolve the actual Files scope once per turn, before either pointer reuse or upload.
  let client: ScopedFilesClient | undefined

  for (const id of attachmentIds) {
    deps.signal?.throwIfAborted()
    if (out.has(id)) continue
    const attachment = await getAttachment(deps.db, id, deps.userId)
    if (!attachment) {
      // Anything else missing is another user's id or a broken invariant, and must stay loud.
      if (!mayBeGone?.has(id)) throw new Error(`attachment ${id} missing`)
      out.set(id, GONE)
      continue
    }

    if (canRead && !canRead(attachment.mime)) {
      out.set(id, { mime: attachment.mime, unavailable: 'unreadable' })
      continue
    }

    // Text is sent as text, never through a Files API: every model reads it, and a pointer to it
    // would only make the provider decode what is already decoded here.
    if (isTextMime(attachment.mime)) {
      const stored = await deps.assets.getBytes(attachment.r2_key)
      if (!stored) throw new Error(`attachment ${id} bytes missing`)
      out.set(id, { mime: attachment.mime, text: new TextDecoder().decode(stored.bytes) })
      continue
    }

    if (useFiles && !inlineOnly(attachment.mime)) {
      client ??= await deps.llm.createFiles(provider, providerInterface)
      const pointer = await findReusableProviderFile(deps.db, { ...client, providerId: provider.id }, id, Date.now(), deps.userId)
      if (pointer) {
        out.set(id, { mime: attachment.mime, data: { type: 'reference', reference: toReference(pointer.provider_reference) } })
        continue
      }
    }

    const stored = await deps.assets.getBytes(attachment.r2_key)
    if (!stored) throw new Error(`attachment ${id} bytes missing`)

    if (!client || inlineOnly(attachment.mime)) {
      out.set(id, { mime: attachment.mime, data: { type: 'data', data: stored.bytes } })
      continue
    }

    let result
    try {
      result = await client.files.uploadFile({
        data: { type: 'data', data: stored.bytes },
        mediaType: attachment.mime,
        filename: filenameFor(attachment),
        providerOptions: UPLOAD_OPTIONS,
        abortSignal: deps.signal,
      })
    } catch (error) {
      // A compatible gateway may expose chat while omitting the OpenAI Files contract, or reject
      // its purpose/expiry fields with a generic 400. Inline the same bytes for this turn; auth,
      // throttling and transient failures still surface so a broken provider is never disguised.
      if (APICallError.isInstance(error) && error.statusCode !== undefined && UNSUPPORTED_FILES_STATUSES.has(error.statusCode)) {
        out.set(id, { mime: attachment.mime, data: { type: 'data', data: stored.bytes } })
        continue
      }
      throw error
    }
    const createdAt = Date.now()
    // Anthropic's SDK may omit expiresAt even though its adapter requests the TTL on upload.
    const expiresAt = result.expiresAt?.getTime() ?? createdAt + PROVIDER_FILE_TTL_MS
    await insertProviderFile(deps.db, {
      attachment_id: attachment.id,
      provider_id: provider.id,
      credential_version: client.credentialVersion,
      file_family: client.family,
      base_url: client.baseURL,
      provider_reference: result.providerReference,
      expires_at: expiresAt,
      cleanup_after: expiresAt,
      created_at: createdAt,
    }, deps.userId)
    out.set(id, { mime: attachment.mime, data: { type: 'reference', reference: result.providerReference } })
  }

  return out
}
