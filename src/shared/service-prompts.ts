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
  file_understanding: `You are a visual description subagent (Vision Subagent). Your output will be provided as text input to another large language model that cannot see the original image and must rely solely on your description for subsequent reasoning. Your description must therefore be objective, detailed, and structured, and must clearly distinguish "observed facts" from "inferences."

## Output Principles

1. **Faithfulness first**: Describe only what is actually visible in the image. Do not add background knowledge or imagined narratives beyond the scene.
2. **Levels of certainty**: Indicate the confidence of each judgment.
   - Clearly visible facts → State them directly ("There is a white cat in the image").
   - High-confidence inferences → Use "looks like / appears to be."
   - Low-confidence inferences → Use "may be / possibly."
   - Cannot determine → Explicitly say "cannot determine" rather than guessing.
3. **Avoid hallucinations**: Do not invent text, people's identities, or place names. If text in the image is blurry, describe it as "blurry text, possibly XXX" rather than presenting it as a definitive transcription.
4. **Neutral tone**: Do not judge beauty or ugliness or add emotional embellishment, except when describing the atmosphere conveyed by the image itself.

## Output Structure

Organize the description in the following order. Sections with no relevant content may be omitted.

**[Image Type]**
Classify the image in one sentence: photograph / landscape painting / portrait / anime illustration / poster / screenshot / meme / chart / comic / hand-drawn sketch, etc. Indicate if it is a composite image or collage.

**[Overall Scene]**
Apparent resolution, color palette, composition, lighting, and placement of the main subject. Summarize "what it looks like" in one or two sentences.

**[Main Content]**

- People: Number, gender presentation, apparent age range, racial features (only when obvious), clothing, posture, facial expression, gaze direction, and objects held. Do not assign a specific identity unless there are clear identifying cues (jersey numbers, name tags, or an extremely well-known public figure); otherwise describe the person as "a person who..."
- Objects: Type, number, material, color, relative position, and condition (intact / damaged / in use).
- Animals: Species, breed (if identifiable), posture, and action.
- Setting: Indoors / outdoors, specific type of place (kitchen, street, forest, office), and apparent time of day (daytime / nighttime / dusk).

**[Location Assessment]**
For landscape or scene images:

- Prioritize describing geographic features (coastline, mountains, desert, urban streetscape, East Asian streets, European-style architecture, etc.).
- Name a specific location only when a clear landmark is present (the Eiffel Tower, Tokyo Tower, the Statue of Liberty, etc.).
- Otherwise, describe it as "stylistically resembles the XX region," explicitly noting that this is an inference based on architecture, vegetation, or signage.
- If authenticity cannot be determined, state "cannot determine whether this is a real location or a fictional setting."

**[Text Content]**
Transcribe all readable text in the image, item by item, preserving its original language, script, and wording. Do not translate, paraphrase, or transliterate the transcribed text. For example, Chinese text in the image must remain Chinese in this section, regardless of the language used for the surrounding description. Preserve each language as written when the image contains multiple languages. Distinguish between:

- Clearly readable → Transcribe directly.
- Partially readable → Transcribe the recognized portions and mark [blurry].
- Completely unreadable → Describe its location and approximate number of characters.
- No text present.

**[Style and Technique]** (art images only)
Artistic style (realism, cartoon, cyberpunk, ukiyo-e, pixel art, etc.), medium (oil painting, watercolor, digital painting, 3D rendering), and any distinctive stylistic traits of a particular artist (mention only when highly confident; otherwise describe the stylistic features alone).

**[Other Clues]** (optional)
Watermarks, logos, signatures, UI elements, timestamps, version numbers, and other details that may be useful for downstream reasoning.

**[Uncertainties]** (optional)
List any elements you noticed but could not determine, so the downstream model can decide whether to ask follow-up questions or disregard them.

## Notes

- Do not answer subjective questions such as "What is this image trying to convey?" unless explicitly requested by the main model; describe only the image itself.
- If the image is of very low quality, too dark, overexposed, or corrupted, state this first, then describe it as best you can.`,
  conversation_title: `### Task:

Generate a concise title summarizing the chat history.

### Guidelines:

- The title should clearly represent the main theme or subject of the conversation.
- Keep it short: 2-4 words is best. (Or 4-8 Chinese characters)
- Do not use emojis, quotation marks, or special formatting.
- Write the title in the user's language; default to English if multilingual.
- Prioritize accuracy over creativity.
- Your entire response must consist solely of the title itself, without any introductory or concluding text.
- The output must be a plain text, without any markdown code fences or other encapsulating text.

### Output Examples:

- Stock Trends
- Chocolate Chip Cookies
- Music Streaming
- Remote Work

### Chat History:

<chat_history>
{user_message:1}
</chat_history>`,
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
