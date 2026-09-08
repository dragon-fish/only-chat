import type { AskUserInput, AskUserResult } from '../shared'
import { AskUserResultSchema, validateAskUserResult } from '../shared'

export type AskUserDraftAnswers = Record<string, string | string[]>

export function initialAnswers(input: AskUserInput): AskUserDraftAnswers {
  return Object.fromEntries(input.questions.map(question => [question.id, question.type === 'multiple' ? [] : '']))
}

export function buildAnsweredResult(
  input: AskUserInput,
  values: AskUserDraftAnswers,
  otherValues: Readonly<Record<string, string>> = {},
): AskUserResult {
  const result = AskUserResultSchema.parse({
    status: 'answered',
    answers: input.questions.map((question) => {
      const value = values[question.id] ?? ''
      if (question.type !== 'multiple') {
        if (Array.isArray(value)) return { id: question.id, value }
        return { id: question.id, value: value.trim() !== '' ? value : null }
      }
      if (!Array.isArray(value)) return { id: question.id, value }
      const custom = otherValues[question.id]?.trim()
      const selected = [...new Set([...value, ...(custom ? [custom] : [])])]
      return { id: question.id, value: selected.length ? selected : null }
    }),
  })
  return validateAskUserResult(input, result)
}
