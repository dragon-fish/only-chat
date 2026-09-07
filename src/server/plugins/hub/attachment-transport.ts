import type { FilesV4, SharedV4ProviderReference } from '@ai-sdk/provider'
import type { DB } from '../../db/client'
import type { AttachmentRow, ProviderInterfaceRow, ProviderRow } from '../../db/schema'
import type { Assets } from '../assets'
import type { Llm } from '../llm'
import type { AttachmentInput } from '../llm/messages'
import { getAttachment, getProviderFile, upsertProviderFile } from './sessions'

/** Spec §5.7: uploads ask the provider to expire the file after seven days. */
const PROVIDER_FILE_TTL_SECONDS = 604_800
const PROVIDER_FILE_TTL_MS = PROVIDER_FILE_TTL_SECONDS * 1000

/**
 * Namespaced for the only protocol that currently offers a Files API. `uploadFile` reads the entry
 * under its own provider name and ignores the rest, so an adapter that does not know these keys is
 * unaffected by them.
 */
const UPLOAD_OPTIONS = { openai: { purpose: 'user_data', expiresAfter: PROVIDER_FILE_TTL_SECONDS } } as const

export interface TransportDeps {
  db: DB
  assets: Assets
  llm: Llm
}

/**
 * A stored `provider_reference` is opaque provider JSON we write and read but never author, so this
 * is the one place it is given the SDK's reference type.
 */
function toReference(stored: Record<string, string>): SharedV4ProviderReference {
  return stored as SharedV4ProviderReference
}

/** OpenAI's multipart part carries no type hint of its own without a filename. */
function filenameFor(attachment: AttachmentRow): string {
  const extension = attachment.mime.split('/')[1]?.split('+')[0] ?? 'bin'
  return `attachment-${attachment.id}.${extension}`
}

/**
 * Decides how each referenced attachment reaches the model (spec §5.6). With the provider's Files
 * API enabled an unexpired pointer is reused as-is, otherwise the bytes are read from R2 once and
 * uploaded, and the resulting pointer replaces whatever was stored for that provider. Every other
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
): Promise<Map<number, AttachmentInput>> {
  const out = new Map<number, AttachmentInput>()
  const useFiles = deps.llm.hasFiles(providerInterface)
  // One Files client serves the whole turn; building it is deferred until an upload is actually due.
  let files: FilesV4 | undefined

  for (const id of attachmentIds) {
    if (out.has(id)) continue
    const attachment = await getAttachment(deps.db, id)
    if (!attachment) throw new Error(`attachment ${id} missing`)

    if (useFiles) {
      const pointer = await getProviderFile(deps.db, id, provider.id)
      // An expired pointer never takes part in context assembly, cleanup job or not (spec §5.7).
      if (pointer && pointer.expires_at > Date.now()) {
        out.set(id, { mime: attachment.mime, data: { type: 'reference', reference: toReference(pointer.provider_reference) } })
        continue
      }
    }

    const stored = await deps.assets.getBytes(attachment.r2_key)
    if (!stored) throw new Error(`attachment ${id} bytes missing`)

    if (!useFiles) {
      out.set(id, { mime: attachment.mime, data: { type: 'data', data: stored.bytes } })
      continue
    }

    files ??= await deps.llm.createFiles(provider, providerInterface)
    const result = await files.uploadFile({
      data: { type: 'data', data: stored.bytes },
      mediaType: attachment.mime,
      filename: filenameFor(attachment),
      providerOptions: UPLOAD_OPTIONS,
    })
    await upsertProviderFile(deps.db, {
      attachment_id: attachment.id,
      provider_id: provider.id,
      provider_reference: result.providerReference,
      // The provider's own answer wins; without one the local pointer dies on the requested deadline.
      expires_at: result.expiresAt?.getTime() ?? Date.now() + PROVIDER_FILE_TTL_MS,
      created_at: Date.now(),
    })
    out.set(id, { mime: attachment.mime, data: { type: 'reference', reference: result.providerReference } })
  }

  return out
}
