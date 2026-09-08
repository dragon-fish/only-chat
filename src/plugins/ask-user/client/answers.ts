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
      if (question.type !== 'multiple') return { id: question.id, value }
      const custom = otherValues[question.id]?.trim()
      return { id: question.id, value: [...new Set([...(Array.isArray(value) ? value : []), ...(custom ? [custom] : [])])] }
    }),
  })
  return validateAskUserResult(input, result)
}
