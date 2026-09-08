import { describe, expect, it } from 'vitest'
import { decryptJson, decryptSecret, encryptJson, encryptSecret } from '@/server/plugins/llm/crypto'
import type { CodexTokenBundle } from '@/server/plugins/codex/types'

describe('secret crypto', () => {
  it('encrypts JSON without exposing tokens and preserves the complete bundle', async () => {
    const bundle: CodexTokenBundle = {
      idToken: 'private-id-token', accessToken: 'private-access-token', refreshToken: 'private-refresh-token',
      tokenType: 'Bearer', accountId: 'account-1', email: 'user@example.com', expiresAt: 123456789,
    }
    const encrypted = await encryptJson('master', bundle)
    for (const token of [bundle.idToken, bundle.accessToken, bundle.refreshToken]) expect(encrypted).not.toContain(token)
    expect(await decryptJson<CodexTokenBundle>('master', encrypted)).toEqual(bundle)
    await expect(decryptJson('other', encrypted)).rejects.toThrow()
  })

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
