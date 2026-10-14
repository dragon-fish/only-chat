import { describe, expect, it } from 'vitest'
import { readLines, splitNumberedLines } from '@/shared/text-lines'

describe('readLines', () => {
  it('numbers lines cat -n style, so a tab-indented line keeps its own tab after the prefix', () => {
    expect(readLines('a\n\tb\n  c', {})?.content).toBe('     1\ta\n     2\t\tb\n     3\t  c')
  })
})

describe('splitNumberedLines', () => {
  it('splits only at the first tab, keeping indentation in the text', () => {
    expect(splitNumberedLines(readLines('a\n\tb', { offset: 1 })!.content)).toEqual([
      { number: 1, text: 'a' },
      { number: 2, text: '\tb' },
    ])
  })

  it('shows a line it cannot split whole, without a number', () => {
    expect(splitNumberedLines('1 | old')).toEqual([{ number: null, text: '1 | old' }])
  })
})
