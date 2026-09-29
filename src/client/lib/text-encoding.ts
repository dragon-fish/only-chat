import { isUtf8Text } from '@/shared/file-media'

/** Below this `chardet` confidence the guess is refused: a wrong encoding is garbage, not a file. */
const MIN_CONFIDENCE = 50
/** The detector sees at most this much; East Asian encodings settle within the first few KiB. */
const SAMPLE_BYTES = 64 * 1024

export const UNKNOWN_ENCODING = '无法识别文件编码，请转换为 UTF-8 后再上传'

export interface Utf8Text {
  bytes: Uint8Array<ArrayBuffer>
  /** The encoding it was converted from, or null when it already was UTF-8. */
  from: string | null
}

/**
 * A text file as UTF-8, which is all the server stores. Anything else is converted here, in the
 * browser, so the upload protocol — hashed and checked bytes — is unchanged, and the person sees
 * the conversion before sending. `chardet` is loaded only for a file that needs it.
 */
export async function toUtf8(bytes: Uint8Array<ArrayBuffer>): Promise<Utf8Text> {
  if (isUtf8Text(bytes)) return { bytes, from: null }
  const { analyse } = await import('chardet')
  const [best] = analyse(bytes.subarray(0, SAMPLE_BYTES))
  if (!best || best.confidence < MIN_CONFIDENCE) throw new Error(UNKNOWN_ENCODING)
  let text: string
  try {
    text = new TextDecoder(best.name, { fatal: true }).decode(bytes)
  } catch {
    // An encoding the browser cannot decode, or bytes that are not valid in the one guessed.
    throw new Error(UNKNOWN_ENCODING)
  }
  const converted = new TextEncoder().encode(text)
  // A NUL survives decoding only from binary bytes that happened to pass as text.
  if (!isUtf8Text(converted)) throw new Error(UNKNOWN_ENCODING)
  return { bytes: converted, from: best.name }
}
