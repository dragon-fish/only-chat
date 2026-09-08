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
  required: z.boolean().default(false).describe('Whether this question must be answered. Defaults to false.'),
}

export const AskUserQuestionSchema = z.strictObject({
  ...QuestionBase,
  type: z.enum(['single', 'multiple', 'text']),
  options: ChoiceOptionsSchema.optional().describe('Required for single and multiple choice questions.'),
  allowOther: z.boolean().default(true).describe('Whether the user may enter one custom option. Defaults to true.'),
  placeholder: z.string().max(500).optional(),
}).superRefine((question, ctx) => {
  if (question.type !== 'text' && question.options === undefined) {
    ctx.addIssue({ code: 'custom', path: ['options'], message: 'choice questions require options' })
  }
})
export type AskUserQuestion = z.infer<typeof AskUserQuestionSchema>

export const AskUserInputSchema = z.strictObject({
  questions: z.array(AskUserQuestionSchema).min(1).max(3).describe(
    'Ask 1-3 questions together. Do not use ask_user for a single open-ended text question; ask it normally in chat. Text questions are useful when batching multiple questions.',
  ),
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
  value: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).nullable(),
})
export type AskUserAnswer = z.infer<typeof AskUserAnswerSchema>

export const AskUserResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('answered'), answers: z.array(AskUserAnswerSchema).min(1).max(3) }),
  z.strictObject({ status: z.literal('cancelled'), message: z.string().trim().min(1).max(2_000) }),
])
export type AskUserResult = z.infer<typeof AskUserResultSchema>

/**
 * Answer shape is intentionally separate from the result envelope: matching IDs and value types
 * requires the original, persisted tool-call arguments. Choice labels are guidance, not a whitelist.
 */
export function validateAskUserResult(input: AskUserInput, result: AskUserResult): AskUserResult {
  if (result.status === 'cancelled') return result
  if (result.answers.length !== input.questions.length) throw new Error('every question must have one answer entry')
  for (const [index, answer] of result.answers.entries()) {
    const question = input.questions[index]!
    if (answer.id !== question.id) throw new Error(`answer ${answer.id} does not match question ${question.id}`)
    if (answer.value === null) {
      if (question.required) throw new Error(`required question ${question.id} must be answered`)
      continue
    }
    if (question.type === 'multiple') {
      if (!Array.isArray(answer.value)) throw new Error(`question ${answer.id} requires multiple values`)
      continue
    }
    if (Array.isArray(answer.value)) throw new Error(`question ${answer.id} requires one value`)
  }
  return result
}
