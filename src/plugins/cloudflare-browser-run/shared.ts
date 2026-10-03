import { z } from 'zod'

// ---- limits, stated once and read by the tool, the UI, and the harness alike

export const MAX_CODE_BYTES = 32 * 1024
export const DEFAULT_TIMEOUT_MS = 120_000
export const MAX_TIMEOUT_MS = 300_000
export const DEFAULT_KEEP_ALIVE_MS = 600_000
export const MAX_KEEP_ALIVE_MS = 600_000
/** What the model gets back; the panel's live stream is not capped. */
export const MAX_RESULT_LOG_BYTES = 16 * 1024
export const MAX_SCREENSHOTS_PER_RUN = 8
/** Live View links are minted for the maximum the platform allows, so refreshes stay rare. */
export const LIVE_VIEW_TTL_MS = 3_600_000
/** The client asks for a fresh link this long before the current one expires. */
export const LIVE_VIEW_REFRESH_MARGIN_MS = 300_000
/**
 * A mounted Live View frame is a connected client, and the platform never idles a session with a
 * client attached. The frame unmounts after this long without a person touching it, so the
 * platform's own idle timer (keep_alive, at most 10 minutes) can reclaim the browser.
 */
export const LIVE_VIEW_IDLE_MS = 600_000
/** For this long before pausing, an overlay on the frame catches any movement and resets the idle clock. */
export const LIVE_VIEW_IDLE_WARNING_MS = 60_000

// ---- plugin configuration

export const BROWSER_RUN_CONFIG_SCHEMA = z.object({
  keep_alive_ms: z.number().int().min(60_000).max(MAX_KEEP_ALIVE_MS).default(DEFAULT_KEEP_ALIVE_MS),
  default_timeout_ms: z.number().int().min(10_000).max(MAX_TIMEOUT_MS).default(DEFAULT_TIMEOUT_MS),
})
export type BrowserRunConfig = z.infer<typeof BROWSER_RUN_CONFIG_SCHEMA>

/** Where a conversation's browser keeps its logins between browsers. */
export const BrowserProfileSchema = z.enum(['ephemeral', 'project', 'user'])
export type BrowserProfile = z.infer<typeof BrowserProfileSchema>

export const BROWSER_RUN_CONVERSATION_CONFIG_SCHEMA = z.object({
  browser_profile: BrowserProfileSchema.default('project'),
})
export type BrowserRunConversationConfig = z.infer<typeof BROWSER_RUN_CONVERSATION_CONFIG_SCHEMA>

// ---- tool contracts

export const BrowserUseInputSchema = z.object({
  code: z.string().min(1).max(MAX_CODE_BYTES).describe('An ES module exporting `run`. See the tool description for the contract.'),
  timeout_ms: z.number().int().min(1_000).max(MAX_TIMEOUT_MS).optional()
    .describe(`How long the code may run, in milliseconds. Default ${DEFAULT_TIMEOUT_MS}, at most ${MAX_TIMEOUT_MS}.`),
})
export type BrowserUseInput = z.infer<typeof BrowserUseInputSchema>

export const ScreenshotRefSchema = z.object({
  attachment_id: z.number().int(),
  name: z.string(),
})
export type ScreenshotRef = z.infer<typeof ScreenshotRefSchema>

export const BrowserUseOutputSchema = z.object({
  /** Whatever `run` returned, JSON-encoded when it was not already a string. */
  result: z.string(),
  logs: z.string(),
  logs_truncated: z.boolean(),
  screenshots: z.array(ScreenshotRefSchema),
  url: z.string().nullable(),
  title: z.string().nullable(),
})
export type BrowserUseOutput = z.infer<typeof BrowserUseOutputSchema>

/** The code ran and failed, or never got to run; the model can read this and try again. */
export const BrowserUseErrorSchema = z.object({
  error: z.string(),
  timed_out: z.boolean().optional(),
  logs: z.string().optional(),
  logs_truncated: z.boolean().optional(),
  screenshots: z.array(ScreenshotRefSchema).optional(),
  url: z.string().nullable().optional(),
})
export type BrowserUseError = z.infer<typeof BrowserUseErrorSchema>

/** The platform said no for now; nothing is wrong with the code. */
export const BrowserUseRefusalSchema = z.object({ refused: z.string(), retry_after_s: z.number().optional() })
export type BrowserUseRefusal = z.infer<typeof BrowserUseRefusalSchema>

export const BrowserHandoffInputSchema = z.strictObject({
  instructions: z.string().trim().min(1).max(2_000)
    .describe('What the person should do in the live browser, and what to leave for you afterwards.'),
})
export type BrowserHandoffInput = z.infer<typeof BrowserHandoffInputSchema>

export const BrowserHandoffResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('done'), note: z.string().trim().max(2_000).optional() }),
  z.strictObject({ status: z.literal('failed'), note: z.string().trim().max(2_000).optional() }),
  /** Recorded when the person sent a message instead of finishing; never chosen from the panel. */
  z.strictObject({ status: z.literal('skipped'), message: z.string() }),
])
export type BrowserHandoffResult = z.infer<typeof BrowserHandoffResultSchema>
export const HANDOFF_DONE_STATUSES = ['done', 'failed'] as const

// ---- the plugin's own realtime channel

export const BrowserSessionStateSchema = z.object({
  conversation_id: z.number().int(),
  status: z.enum(['active', 'closed']),
  live_view_url: z.string().nullable(),
  live_view_expires_at: z.number().nullable(),
  profile: BrowserProfileSchema,
  started_at: z.number().nullable(),
})
export type BrowserSessionState = z.infer<typeof BrowserSessionStateSchema>

export const BrowserPluginEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('session'), state: BrowserSessionStateSchema }),
])
export type BrowserPluginEvent = z.infer<typeof BrowserPluginEventSchema>

export const BrowserPluginCommandSchema = z.discriminatedUnion('kind', [
  /** "What is this conversation's browser doing?" — answered with a `session` event. */
  z.object({ kind: z.literal('state'), conversation_id: z.number().int() }),
  z.object({ kind: z.literal('refresh_live_view'), conversation_id: z.number().int() }),
  z.object({ kind: z.literal('close'), conversation_id: z.number().int() }),
])
export type BrowserPluginCommand = z.infer<typeof BrowserPluginCommandSchema>

// ---- what the model is told

/**
 * The whole API the model writes against, as a declaration: it is the one form of documentation a
 * model reads reliably. Kept free of anything that changes per deployment so the prompt prefix,
 * and with it the cache, stays stable.
 */
export const BROWSER_USE_CONTRACT = `export async function run(ctx: {
  page: Page               // Playwright Page, already on this conversation's browser with its tabs, cookies and logins
  browser: Browser         // for another tab or context; browser.contexts()[0] is the one page lives in
  log(...args: unknown[]): void             // shown to the user live and returned to you with the result
  screenshot(name?: string): Promise<void>  // saved for the user and shown to you if you can see images
}): Promise<string | object>                // your return value is the tool result (objects are JSON-encoded)`

export const BROWSER_USE_DESCRIPTION = [
  'Runs Playwright code you write in a browser that belongs to this conversation. Tabs, cookies and logins persist between calls.',
  'The code is an ES module and must export run:',
  '```ts',
  BROWSER_USE_CONTRACT,
  '```',
  'To read a page: after await ctx.page.goto(url), use await ctx.page.locator("body").ariaSnapshot() for structured text, which costs far less than a screenshot. Call await ctx.screenshot() only when the layout is what matters.',
  'To drive a page: page.getByRole / getByText / locator with click / fill / press. page.evaluate is available.',
  'Limits: the code itself has no network access (fetch throws), a second browser cannot be started, and a call has a time limit — on timeout the logs so far come back.',
  'The return value, the logs, the screenshots and the final page URL and title all come back together. Logs over the budget are truncated and marked.',
].join('\n')

/** When the user takes over. How to drive the page is browser_use's own description. */
export const BROWSER_GUIDANCE = [
  'browser_use drives a real browser that belongs to this conversation.',
  'For a login, a captcha, a second factor, sensitive input or an action a person has to confirm, call browser_handoff and let the user take over rather than retrying. Never hand over a step you can do yourself.',
].join(' ')

export const BROWSER_HANDOFF_DESCRIPTION = [
  'Asks the user to take over one step in the live browser that you cannot do: a login, a captcha, a second factor, sensitive input, or an action a person has to confirm.',
  'State what the user should do and the point at which they hand control back. They report success or failure, and you continue in the same browser.',
  'Ask for one thing at a time.',
].join('\n')

// ---- pure helpers shared by server and tests

export function profileStorageKey(profile: BrowserProfile, scope: { userId: number; projectId: number | null }): string | null {
  if (profile === 'ephemeral') return null
  if (profile === 'project') return scope.projectId === null ? null : `browser-profile:project:${scope.projectId}`
  return `browser-profile:user:${scope.userId}`
}

/** Cuts a log to the model's budget from the end, since the newest lines say what happened last. */
export function truncateLogs(logs: string, maxBytes: number = MAX_RESULT_LOG_BYTES): { logs: string; truncated: boolean } {
  const encoder = new TextEncoder()
  if (encoder.encode(logs).byteLength <= maxBytes) return { logs, truncated: false }
  let kept = logs
  while (encoder.encode(kept).byteLength > maxBytes) kept = kept.slice(Math.floor(kept.length / 4))
  return { logs: `…[earlier logs truncated]\n${kept}`, truncated: true }
}
