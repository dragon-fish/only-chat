/**
 * Templates for the work the service model does.
 *
 * Shared rather than server-only so the settings form rejects a broken template before sending it,
 * and the server rejects the same one for the same reason — one implementation, two callers.
 */

/**
 * How much of a quoted message reaches the service model.
 *
 * A cap rather than a setting: it exists to bound the context and cost of a call the user never
 * asked for, which is a property of the system and not a preference. A pasted document must not
 * turn naming one conversation into the most expensive request of the session.
 */
export const MAX_PLACEHOLDER_CHARS = 1000

/** Only `user_message` resolves today; the index is what lets the set grow without new syntax. */
const PLACEHOLDER = /\{user_message:(\d+)\}/g

/**
 * Naming runs while the conversation holds exactly one user message, so a template that quotes only
 * a later one would send the model an empty prompt. Requiring the first is what makes that
 * impossible to configure.
 */
export const REQUIRED_TITLE_PLACEHOLDERS = ['{user_message:1}'] as const

export const SERVICE_PROMPT_DEFAULTS = {
  conversation_title: [
    '为下面这段对话的开场白起一个简短的标题，不超过 20 个字。',
    '直接输出标题本身，不要加引号、标点或任何解释。',
    '用与开场白相同的语言。',
    '',
    '{user_message:1}',
  ].join('\n'),
} as const

export interface ServicePromptContext {
  /** Oldest first. `{user_message:1}` is the first element. */
  userMessages: readonly string[]
}

/** Cuts on a character boundary: slicing UTF-16 units would leave half of an emoji behind. */
function cap(text: string): string {
  const characters = [...text]
  return characters.length <= MAX_PLACEHOLDER_CHARS ? text : characters.slice(0, MAX_PLACEHOLDER_CHARS).join('')
}

/**
 * Anything that is not a placeholder this understands is left exactly as written — a typo should be
 * visible in the result rather than silently deleted, which is the only way its author finds it.
 */
export function renderServicePrompt(template: string, context: ServicePromptContext): string {
  return template.replaceAll(PLACEHOLDER, (_match, index: string) => {
    const message = context.userMessages[Number(index) - 1]
    return message === undefined ? '' : cap(message)
  })
}

/** Empty when the template is usable. Returns what is missing so the form can say which. */
export function missingRequiredPlaceholders(template: string): string[] {
  return REQUIRED_TITLE_PLACEHOLDERS.filter(placeholder => !template.includes(placeholder))
}

/** What a conversation title may be, once a model has had its say. */
export const MAX_TITLE_CHARS = 40
/** Beyond this the answer is prose about a title rather than a title, and nothing can rescue it. */
const PROSE_THRESHOLD = 100

/** Quotes a model adds around an answer it was told to give bare. */
const WRAPPING_QUOTES = /^["'“”「」『』《》]+|["'“”「」『』《》]+$/g

/**
 * Turns a model's answer into a title, or refuses.
 *
 * Refusing matters more than cleaning: a conversation already has a usable name from its first
 * words, so anything doubtful is worse than what it would replace. `null` keeps the placeholder.
 */
export function titleFromModelOutput(raw: string): string | null {
  const firstLine = raw.split('\n').map(line => line.trim()).find(line => line.length > 0) ?? ''
  const bare = firstLine.replaceAll(WRAPPING_QUOTES, '').trim()
  if (bare.length === 0) return null
  const characters = [...bare]
  // Length is judged before trimming: a model that wrote a paragraph did not misjudge the limit,
  // it answered a different question, and its first 40 characters are not a title either.
  if (characters.length > PROSE_THRESHOLD) return null
  return characters.length <= MAX_TITLE_CHARS ? bare : characters.slice(0, MAX_TITLE_CHARS).join('')
}
