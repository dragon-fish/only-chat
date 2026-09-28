/** One file of a conversation as the file panel lists it (spec §2.3). */
export interface ConversationAsset {
  attachmentId: number
  /** The 8-hex sha256 prefix, without the scheme: the model calls this file `asset:<ref>`. */
  ref: string
  source: 'upload' | 'generated'
  mime: string
  size: number
  width: number | null
  height: number | null
  /** The uploaded file's own name; null for pasted and generated images. */
  filename: string | null
  /** When it first appeared in the conversation. */
  createdAt: number
}
