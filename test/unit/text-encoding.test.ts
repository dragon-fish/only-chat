import { describe, expect, it } from 'vitest'
import { toUtf8, UNKNOWN_ENCODING } from '@/client/lib/text-encoding'

const SENTENCE = '北京的天气晴朗。明天会下雨。今天非常热。我们去吃牛肉面吧。这是简体中文的测试文字。'.repeat(4)

describe('text uploads in another encoding', () => {
  it('pass UTF-8 through untouched', async () => {
    const bytes = new TextEncoder().encode(SENTENCE)
    expect(await toUtf8(bytes)).toEqual({ bytes, from: null })
  })

  it('convert GBK to UTF-8 and say what they were', async () => {
    // What a Chinese Windows Excel writes for a CSV: GBK, no BOM.
    const gbk = new Uint8Array(gbkBytes(SENTENCE))
    const result = await toUtf8(gbk)
    expect(result.from).toBe('GB18030')
    expect(new TextDecoder().decode(result.bytes)).toBe(SENTENCE)
  })

  it('refuse bytes no encoding explains', async () => {
    const noise = Uint8Array.from({ length: 256 }, (_, i) => (i * 97 + 13) % 256)
    await expect(toUtf8(noise)).rejects.toThrow(UNKNOWN_ENCODING)
  })
})

/** GBK bytes without an encoder: every character above maps through the decoder's own table. */
function gbkBytes(text: string): number[] {
  const decoder = new TextDecoder('gbk')
  const table = new Map<string, number[]>()
  for (let lead = 0x81; lead <= 0xfe; lead++) {
    for (let trail = 0x40; trail <= 0xfe; trail++) {
      const char = decoder.decode(new Uint8Array([lead, trail]))
      if (char.length === 1 && !table.has(char)) table.set(char, [lead, trail])
    }
  }
  return [...text].flatMap(char => char.charCodeAt(0) < 0x80 ? [char.charCodeAt(0)] : table.get(char)!)
}
