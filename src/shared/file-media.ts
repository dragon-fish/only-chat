import type { ModelMetadata } from './model-metadata'
import type { InterfaceProtocol } from './models'

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

export const FILE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
  'application/pdf': 'pdf', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg',
  'audio/flac': 'flac', 'audio/mp4': 'm4a', 'audio/webm': 'webm',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
}

/**
 * Extension-only fallback, for a file the browser gave no type. `.webm` names both an audio and a
 * video container; it resolves to `video/webm`, which also plays audio-only streams — never let
 * the first `FILE_EXTENSIONS` entry decide it.
 */
export function mimeFromExtension(extension: string): string | undefined {
  if (extension === 'webm') return 'video/webm'
  return Object.entries(FILE_EXTENSIONS).find(([, ext]) => ext === extension)?.[0]
}

export function fileModality(mime: string): 'image' | 'pdf' | 'audio' | 'video' | null {
  if (!FILE_EXTENSIONS[mime]) return null
  return mime === 'application/pdf' ? 'pdf' : mime.split('/')[0] as 'image' | 'audio' | 'video'
}

/** Model metadata alone cannot make an adapter encode an unsupported input. */
export function canReadFile(metadata: ModelMetadata, protocol: InterfaceProtocol, mime: string): boolean {
  const modality = fileModality(mime)
  if (!modality || !metadata.modalities?.input.includes(modality)) return false
  if (protocol === 'anthropic' || protocol === 'responses') return modality === 'image' || modality === 'pdf'
  if (protocol === 'chat-completions' && modality === 'audio') return mime === 'audio/wav' || mime === 'audio/mpeg'
  return true
}

/**
 * An MPEG audio frame header without an ID3 tag. Byte 0 plus the top three bits of byte 1 are the
 * 11-bit frame sync; `& 0xe6 === 0xe2` also requires layer bits `01` (Layer III). Version `01`,
 * bitrate index `1111` and sample-rate index `11` are reserved values, so a header carrying them is
 * not MP3.
 */
function isMp3Frame(bytes: Uint8Array): boolean {
  const [b0 = 0, b1 = 0, b2 = 0] = bytes
  return b0 === 0xff && (b1 & 0xe6) === 0xe2 && (b1 & 0x18) !== 0x08 && (b2 & 0xf0) !== 0xf0 && (b2 & 0x0c) !== 0x0c
}

/** Check container signatures before accepting a caller-supplied MIME. This is not a decoder. */
export function matchesFileSignature(mime: string, bytes: Uint8Array): boolean {
  const ascii = (offset: number, text: string) => [...text].every((c, i) => bytes[offset + i] === c.charCodeAt(0))
  if (mime === 'image/png') return [137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n)
  if (mime === 'image/jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
  if (mime === 'image/gif') return ascii(0, 'GIF87a') || ascii(0, 'GIF89a')
  if (mime === 'image/webp') return ascii(0, 'RIFF') && ascii(8, 'WEBP')
  if (mime === 'application/pdf') return ascii(0, '%PDF-')
  if (mime === 'audio/wav') return ascii(0, 'RIFF') && ascii(8, 'WAVE')
  if (mime === 'audio/mpeg') return ascii(0, 'ID3') || isMp3Frame(bytes)
  if (mime === 'audio/flac') return ascii(0, 'fLaC')
  if (mime === 'audio/ogg') return ascii(0, 'OggS')
  if (mime === 'audio/webm' || mime === 'video/webm') return [26, 69, 223, 163].every((n, i) => bytes[i] === n)
  if (mime === 'audio/mp4' || mime === 'video/mp4' || mime === 'video/quicktime') return ascii(4, 'ftyp')
  return false
}

/**
 * The name a file travels upstream under. Providers show it to the model (Anthropic uses it as the
 * document title), so it is built from the asset prefix the model already knows — never the
 * attachment id, which the model must not see, and never the person's own filename. Inline PDF
 * parsers also need the extension.
 */
export function assetFilename(prefix: string, mime: string): string {
  return `asset-${prefix}.${FILE_EXTENSIONS[mime] ?? 'bin'}`
}
