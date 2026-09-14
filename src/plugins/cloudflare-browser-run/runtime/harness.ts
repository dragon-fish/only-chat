/**
 * Runs inside the Dynamic Worker. Bundled with `@cloudflare/playwright` by
 * `scripts/build-browser-runtime.ts`; nothing here may import from the rest of the app, because the
 * Worker this runs in has none of it.
 *
 * `env.BROWSER` is the gateway stub, which only lets this code connect to the session it was
 * created for; `env.HOST` is the host stub, pinned to one generation. The model's `run` gets a
 * Playwright `page` and nothing else that reaches outside the sandbox.
 */
import { connect, type Browser, type BrowserContext, type Page } from '@cloudflare/playwright'
import type { HostApi, RunArgs, RunResult } from './protocol'

export type UserRun = (ctx: {
  page: Page
  browser: Browser
  log: (...args: unknown[]) => void
  screenshot: (name?: string) => Promise<void>
}) => Promise<unknown> | unknown

interface HarnessEnv {
  BROWSER: Parameters<typeof connect>[0]
  HOST: HostApi
}

const MAX_SCREENSHOTS = 8
const SCREENSHOT_QUALITY = 75

function formatLogArgs(args: unknown[]): string {
  return args.map((value) => {
    if (typeof value === 'string') return value
    if (value instanceof Error) return `${value.name}: ${value.message}`
    try { return JSON.stringify(value) } catch { return String(value) }
  }).join(' ')
}

function encodeResult(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return ''
  try { return JSON.stringify(value, null, 2) ?? String(value) } catch { return String(value) }
}

interface StoredState {
  cookies?: Parameters<BrowserContext['addCookies']>[0]
}

/**
 * Always the browser's default context, never one of our own. Playwright closes every context a
 * client created when that client disconnects, and each call here is a fresh client, so a page in
 * a created context died the moment its call ended — the tab closed and the Live View went dark.
 * The default context outlives us. A saved profile is applied to it as cookies; localStorage
 * from the profile is not restored, since only `newContext` can seed that.
 */
async function pickContext(browser: Browser, storageState: unknown | null): Promise<BrowserContext> {
  const context = browser.contexts()[0] ?? await browser.newContext()
  const inUse = context.pages().some(page => page.url() !== 'about:blank')
  const cookies = (storageState as StoredState | null)?.cookies
  if (!inUse && cookies?.length) await context.addCookies(cookies).catch(() => {})
  return context
}

async function liveViewOf(context: BrowserContext, page: Page, ttlMs: number): Promise<RunResult['liveView']> {
  try {
    const cdp = await context.newCDPSession(page)
    try {
      const { devtoolsFrontendUrl } = await (cdp.send as (method: string, params?: object) => Promise<{ devtoolsFrontendUrl: string }>)(
        'Cloudflare.getLiveView', { mode: 'tab', expiresInMs: ttlMs },
      )
      return { url: devtoolsFrontendUrl, expiresAt: Date.now() + ttlMs }
    } finally {
      await cdp.detach().catch(() => {})
    }
  } catch {
    return null
  }
}

export function createRunner(env: HarnessEnv, userRun: UserRun | undefined) {
  return async function run(args: RunArgs): Promise<RunResult> {
    const screenshots: RunResult['screenshots'] = []
    let page: Page | null = null
    let context: BrowserContext | null = null
    let browser: Browser | null = null
    const result: RunResult = {
      ok: false, timedOut: false, url: null, title: null, storageState: null, liveView: null, screenshots,
    }

    try {
      browser = await connect(env.BROWSER, args.sessionId)
      context = await pickContext(browser, args.storageState)
      page = context.pages().at(-1) ?? await context.newPage()
      result.liveView = await liveViewOf(context, page, args.liveViewTtlMs)

      if (userRun) {
        const takeScreenshot = async (name?: string) => {
          if (screenshots.length >= MAX_SCREENSHOTS) {
            void env.HOST.log(`[screenshot] 已达到单次调用上限 ${MAX_SCREENSHOTS} 张，忽略 ${name ?? ''}`.trim())
            return
          }
          const label = name?.trim() || `screenshot-${screenshots.length + 1}`
          const bytes = await page!.screenshot({ type: 'jpeg', quality: SCREENSHOT_QUALITY })
          const attachmentId = await env.HOST.attach(label, 'image/jpeg', bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
          screenshots.push({ attachmentId, name: label })
        }
        const log = (...values: unknown[]) => { void env.HOST.log(formatLogArgs(values)) }

        let timer: ReturnType<typeof setTimeout> | undefined
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new TimeoutError()), args.timeoutMs)
        })
        try {
          const value = await Promise.race([userRun({ page, browser, log, screenshot: takeScreenshot }), timeout])
          result.result = encodeResult(value)
          result.ok = true
        } catch (error) {
          if (error instanceof TimeoutError) {
            result.timedOut = true
            result.error = { message: `代码运行超过 ${args.timeoutMs} 毫秒的时限` }
          } else {
            result.error = describe(error)
            // What the page looked like when it failed is usually the fastest way to see why.
            if (screenshots.length < MAX_SCREENSHOTS) await takeScreenshot('error').catch(() => {})
          }
        } finally {
          if (timer !== undefined) clearTimeout(timer)
        }
      } else {
        result.ok = true
      }
    } catch (error) {
      result.error = describe(error)
    }

    if (page) {
      try {
        result.url = page.url()
        result.title = await page.title()
      } catch { /* The page may be gone; the result still carries what it can. */ }
    }
    if (context) {
      try { result.storageState = await context.storageState({ indexedDB: true }) }
      catch { /* A closed context has no state to save. */ }
    }
    if (browser) {
      // A browser obtained by `connect` is disconnected by `close`, which keeps the session alive
      // for the next call; only an explicit close ends it.
      try {
        if (args.close) await closeSession(browser)
        else await browser.close()
      } catch { /* Already gone. */ }
    }
    return result
  }
}

class TimeoutError extends Error {}

function describe(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    const stack = error.stack?.split('\n').slice(0, 6).join('\n')
    return { message: `${error.name}: ${error.message}`, ...(stack ? { stack } : {}) }
  }
  return { message: String(error) }
}

/** `Browser.close` over CDP ends the session itself; Playwright's `close` on a connected browser only detaches. */
async function closeSession(browser: Browser): Promise<void> {
  const context = browser.contexts()[0]
  const page = context?.pages()[0]
  if (context && page) {
    const cdp = await context.newCDPSession(page)
    await (cdp.send as (method: string) => Promise<unknown>)('Browser.close').catch(() => {})
    return
  }
  await browser.close()
}
