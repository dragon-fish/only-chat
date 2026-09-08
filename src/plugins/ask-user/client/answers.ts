import type { AskUserInput, AskUserResult } from '../shared'
import { AskUserResultSchema, validateAskUserResult } from '../shared'

export type AskUserDraftAnswers = Record<string, string | string[]>

export function initialAnswers(input: AskUserInput): AskUserDraftAnswers {
  return Object.fromEntries(input.questions.map(question => [question.id, question.type === 'multiple' ? [] : '']))
}

export function buildAnsweredResult(input: AskUserInput, values: AskUserDraftAnswers): AskUserResult {
  const result = AskUserResultSchema.parse({
    status: 'answered',
    answers: input.questions.map(question => ({ id: question.id, value: values[question.id] ?? '' })),
  })
  return validateAskUserResult(input, result)
}
