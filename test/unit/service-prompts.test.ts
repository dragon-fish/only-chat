import { describe, expect, it } from 'vitest'
import {
  MAX_PLACEHOLDER_CHARS, missingRequiredPlaceholders, renderServicePrompt, titleFromModelOutput,
} from '@/shared/service-prompts'

const render = (template: string, userMessages: string[]) => renderServicePrompt(template, { userMessages })

describe('a service prompt template quotes the conversation', () => {
  it('puts the numbered user message where the placeholder was', () => {
    expect(render('给这段话起个标题：{user_message:1}', ['帮我写个解析 UTF-8 的正则']))
      .toBe('给这段话起个标题：帮我写个解析 UTF-8 的正则')
  })

  it('leaves a placeholder empty when that message does not exist', () => {
    expect(render('一：{user_message:1} 二：{user_message:2}', ['只有一条']))
      .toBe('一：只有一条 二：')
  })

  it('caps a quoted message so one long paste cannot fill the context', () => {
    const long = 'a'.repeat(MAX_PLACEHOLDER_CHARS + 500)
    const out = render('{user_message:1}', [long])
    expect(out).toHaveLength(MAX_PLACEHOLDER_CHARS)
  })

  it('cuts on a character rather than through one', () => {
    // The cap lands exactly on the emoji, which is two UTF-16 units and one character.
    const text = `${'a'.repeat(MAX_PLACEHOLDER_CHARS - 1)}😀tail`
    const out = render('{user_message:1}', [text])
    expect(out.endsWith('😀')).toBe(true)
    expect([...out]).toHaveLength(MAX_PLACEHOLDER_CHARS)
  })

  it('leaves something that is not a placeholder alone, typo included', () => {
    expect(render('{user_message:1} 和 {user_mesage:1} 和 {写作:1}', ['x']))
      .toBe('x 和 {user_mesage:1} 和 {写作:1}')
  })
})

describe('a title template has to quote the message it is naming', () => {
  it('accepts one that uses the first user message', () => {
    expect(missingRequiredPlaceholders('起个标题：{user_message:1}')).toEqual([])
  })

  it('names what is missing rather than just refusing', () => {
    expect(missingRequiredPlaceholders('起个标题')).toEqual(['{user_message:1}'])
    // A different index is not a substitute: naming runs when only the first message exists.
    expect(missingRequiredPlaceholders('起个标题：{user_message:2}')).toEqual(['{user_message:1}'])
  })
})

describe('what comes back from the model is not trusted to be a title', () => {
  const title = (raw: string) => titleFromModelOutput(raw)

  it('takes the words and drops the ceremony around them', () => {
    expect(title('  「解析 UTF-8 的正则」  ')).toBe('解析 UTF-8 的正则')
    expect(title('"Parsing UTF-8"')).toBe('Parsing UTF-8')
  })

  it('keeps the first line when the model explains itself afterwards', () => {
    expect(title('解析 UTF-8 的正则\n\n这个标题概括了用户的需求。')).toBe('解析 UTF-8 的正则')
  })

  it('rejects an answer with no title in it', () => {
    expect(title('')).toBeNull()
    expect(title('   \n  ')).toBeNull()
    expect(title('""')).toBeNull()
  })

  it('rejects prose, which is a model that ignored the instruction', () => {
    expect(title('好的！我很乐意帮你起标题。'.repeat(12))).toBeNull()
  })

  it('trims a title that is merely too long rather than discarding it', () => {
    const out = title('标题'.repeat(30))
    expect(out).not.toBeNull()
    expect([...out!]).toHaveLength(40)
  })
})
