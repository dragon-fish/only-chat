import { describe, expect, it } from 'vitest'
import { decryptSecret, encryptSecret } from '@/server/plugins/llm/crypto'

describe('secret crypto', () => {
  it('round-trips and never repeats ciphertext', async () => {
    const a = await encryptSecret('master', 'sk-123')
    const b = await encryptSecret('master', 'sk-123')
    expect(a).not.toBe(b)
    expect(await decryptSecret('master', a)).toBe('sk-123')
  })

  it('fails with the wrong master secret', async () => {
    const ct = await encryptSecret('master', 'sk-123')
    await expect(decryptSecret('other', ct)).rejects.toThrow()
  })
})
