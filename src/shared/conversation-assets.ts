/**
 * One file of a conversation (spec §4.7): every asset the model can name, so any image it shows in
 * a reply resolves. The file panel lists only `upload` and `generated`.
 */
export interface ConversationAsset {
  attachmentId: number
  /** The 8-hex sha256 prefix, without the scheme: the model calls this file `asset:<ref>`. */
  ref: string
  /** `tool`: handed to the model by a tool (a file read, a screenshot), usually a copy of a file listed elsewhere. */
  source: 'upload' | 'generated' | 'tool'
  mime: string
  size: number
  width: number | null
  height: number | null
  /** The uploaded file's own name; null for pasted and generated images. */
  filename: string | null
  /** When it first appeared in the conversation. */
  createdAt: number
}
