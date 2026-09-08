import { z } from 'zod'

const QuestionIdSchema = z.string().trim().min(1).max(100)
const OptionSchema = z.strictObject({
  label: z.string().trim().min(1).max(500),
  description: z.string().trim().min(1).max(2_000).optional(),
})
const ChoiceOptionsSchema = z.array(OptionSchema).min(2).max(9).superRefine((options, ctx) => {
  const seen = new Set<string>()
  for (const [index, option] of options.entries()) {
    if (seen.has(option.label)) {
      ctx.addIssue({ code: 'custom', path: [index, 'label'], message: 'option labels must be unique' })
    }
    seen.add(option.label)
  }
})

const QuestionBase = {
  id: QuestionIdSchema,
  header: z.string().trim().min(1).max(200),
  question: z.string().trim().min(1).max(4_000),
  description: z.string().trim().min(1).max(2_000).optional(),
}

export const AskUserQuestionSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...QuestionBase, type: z.literal('single'), options: ChoiceOptionsSchema }),
  z.strictObject({ ...QuestionBase, type: z.literal('multiple'), options: ChoiceOptionsSchema }),
  z.strictObject({ ...QuestionBase, type: z.literal('text'), placeholder: z.string().max(500).optional() }),
])
export type AskUserQuestion = z.infer<typeof AskUserQuestionSchema>

export const AskUserInputSchema = z.strictObject({
  questions: z.array(AskUserQuestionSchema).min(1).max(3),
}).superRefine(({ questions }, ctx) => {
  const seen = new Set<string>()
  for (const [index, question] of questions.entries()) {
    if (seen.has(question.id)) {
      ctx.addIssue({ code: 'custom', path: ['questions', index, 'id'], message: 'question IDs must be unique' })
    }
    seen.add(question.id)
  }
})
export type AskUserInput = z.infer<typeof AskUserInputSchema>

export const AskUserAnswerSchema = z.strictObject({
  id: QuestionIdSchema,
  value: z.union([z.string().min(1), z.array(z.string().min(1)).min(1).max(9)]),
})
export type AskUserAnswer = z.infer<typeof AskUserAnswerSchema>

export const AskUserResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('answered'), answers: z.array(AskUserAnswerSchema).min(1).max(3) }),
  z.strictObject({ status: z.literal('cancelled'), message: z.string().trim().min(1).max(2_000) }),
])
export type AskUserResult = z.infer<typeof AskUserResultSchema>

/**
 * Answer shape is intentionally separate from the result envelope: matching values to question
 * types and choice labels requires the original, persisted tool-call arguments.
 */
export function validateAskUserResult(input: AskUserInput, result: AskUserResult): AskUserResult {
  if (result.status === 'cancelled') return result
  const questions = new Map(input.questions.map(question => [question.id, question]))
  if (result.answers.length !== input.questions.length) throw new Error('every question must be answered exactly once')
  const seen = new Set<string>()
  for (const answer of result.answers) {
    const question = questions.get(answer.id)
    if (!question) throw new Error(`unknown question ID: ${answer.id}`)
    if (seen.has(answer.id)) throw new Error('answer IDs must be unique')
    seen.add(answer.id)
    if (question.type === 'multiple') {
      if (!Array.isArray(answer.value)) throw new Error(`question ${answer.id} requires multiple values`)
      if (new Set(answer.value).size !== answer.value.length) throw new Error(`question ${answer.id} has duplicate values`)
      if (answer.value.some(value => !question.options.some(option => option.label === value))) throw new Error(`question ${answer.id} has an invalid option`)
      continue
    }
    if (Array.isArray(answer.value)) throw new Error(`question ${answer.id} requires one value`)
    if (question.type === 'single' && !question.options.some(option => option.label === answer.value)) {
      throw new Error(`question ${answer.id} has an invalid option`)
    }
  }
  return result
}
