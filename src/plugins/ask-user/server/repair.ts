import { generateText, type LanguageModel, type ToolCallRepairFunction, type ToolSet } from 'ai'
import { ASK_USER_TOOL_ID } from '@/shared/plugins'
import { AskUserInputSchema } from '../shared'

const MAX_REPAIR_ATTEMPTS = 3

interface RepairInputOptions {
  input: string
  error: string
  schema: unknown
  generate: (prompt: string) => Promise<string>
}

function jsonCandidate(text: string): string {
  const trimmed = text.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return fenced?.[1]?.trim() ?? trimmed
}

function validatedInput(text: string): string | null {
  try {
    const parsed = AskUserInputSchema.safeParse(JSON.parse(jsonCandidate(text)))
    return parsed.success ? JSON.stringify(parsed.data) : null
  } catch {
    return null
  }
}

export async function repairAskUserInput(options: RepairInputOptions): Promise<string | null> {
  let candidate = options.input
  let validationError = options.error
  for (let attempt = 0; attempt < MAX_REPAIR_ATTEMPTS; attempt++) {
    const output = await options.generate([
      'Repair the JSON arguments for the ask_user tool.',
      'Preserve the intended questions and choices. Change only what is needed to satisfy the schema.',
      'Return one JSON object with no markdown or explanation.',
      `Schema: ${JSON.stringify(options.schema)}`,
      `Invalid arguments: ${candidate}`,
      `Validation error: ${validationError}`,
    ].join('\n'))
    const valid = validatedInput(output)
    if (valid !== null) return valid
    candidate = jsonCandidate(output)
    validationError = 'The previous repair was not valid ask_user input.'
  }
  return null
}

export function createAskUserToolCallRepair<TOOLS extends ToolSet>(
  model: LanguageModel,
  abortSignal: AbortSignal,
): ToolCallRepairFunction<TOOLS> {
  return async ({ toolCall, inputSchema, error }) => {
    if (toolCall.toolName !== ASK_USER_TOOL_ID) return null
    const schema = await inputSchema({ toolName: toolCall.toolName })
    const input = await repairAskUserInput({
      input: toolCall.input,
      error: error.message,
      schema,
      generate: async prompt => (await generateText({ model, prompt, abortSignal })).text,
    })
    return input === null ? null : { ...toolCall, input }
  }
}
