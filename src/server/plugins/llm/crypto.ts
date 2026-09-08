const enc = new TextEncoder()
const dec = new TextDecoder()

async function deriveKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(secret))
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

function fromBase64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

/** Returns "base64(iv).base64(ciphertext)". */
export async function encryptSecret(secret: string, plaintext: string): Promise<string> {
  const key = await deriveKey(secret)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext))
  return `${toBase64(iv)}.${toBase64(new Uint8Array(ct))}`
}

export async function decryptSecret(secret: string, ciphertext: string): Promise<string> {
  const [ivB64, ctB64] = ciphertext.split('.')
  if (!ivB64 || !ctB64) throw new Error('malformed ciphertext')
  const key = await deriveKey(secret)
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(ivB64) }, key, fromBase64(ctB64))
  return dec.decode(pt)
}

export async function encryptJson(valueSecret: string, value: unknown): Promise<string> {
  return encryptSecret(valueSecret, JSON.stringify(value))
}

export async function decryptJson<T>(valueSecret: string, ciphertext: string): Promise<T> {
  return JSON.parse(await decryptSecret(valueSecret, ciphertext)) as T
}
