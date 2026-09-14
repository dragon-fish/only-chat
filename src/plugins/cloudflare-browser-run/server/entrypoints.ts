/**
 * The plugin's Worker-side entrypoints, exported from the Worker so `ctx.exports` can mint loopback
 * stubs of them with per-run `props`. They live outside the Durable Object on purpose: a Durable
 * Object has no `ctx.exports`, and the Dynamic Worker must get capabilities pinned to one session
 * and one generation rather than the real bindings.
 */
import { WorkerEntrypoint } from 'cloudflare:workers'
import { BROWSER_RUN_PLUGIN_ID } from '@/shared/plugins'
import type { GatewayProps, HostApi, HostCall, HostProps, RunArgs, RunResult } from '../runtime/protocol'
import { gatewayAllows } from './gateway'

/** Must match `compatibility_date` in wrangler.jsonc: the sandbox runs on the same runtime rules. */
const DYNAMIC_WORKER_COMPAT_DATE = '2026-09-05'
/** CPU, not wall clock: Playwright waits are I/O. Generous, so a heavy `evaluate` is not cut short. */
const DYNAMIC_WORKER_CPU_MS = 60_000
const RUNTIME_PATH = '/browser-runtime/runtime.js'
const RUNTIME_MANIFEST_PATH = '/browser-runtime/manifest.json'
const MAX_LOG_LINE = 4_000

export interface RunnerArgs extends RunArgs {
  userId: number
  conversationId: number
  messageId: number
  callId: string
  /** The model's module, or null for a probe that only connects, reads state and disconnects. */
  code: string | null
}

/** Forwards only a WebSocket connect to the one session it was created for; everything else is 403. */
export class BrowserGateway extends WorkerEntrypoint<Env, GatewayProps> {
  async fetch(request: Request): Promise<Response> {
    if (!gatewayAllows(new URL(request.url), request.headers.get('Upgrade'), this.ctx.props)) {
      return new Response('this sandbox may only connect to its own browser session', { status: 403 })
    }
    return this.env.BROWSER.fetch(request)
  }
}

/** The harness's way back: each call is forwarded into the owning user's Durable Object. */
export class BrowserHost extends WorkerEntrypoint<Env, HostProps> implements HostApi {
  async log(line: string): Promise<void> {
    await this.forward({ kind: 'log', ...this.ids(), line: String(line).slice(0, MAX_LOG_LINE) })
  }

  async attach(name: string, mime: string, bytes: ArrayBuffer): Promise<number> {
    const id = await this.forward({ kind: 'attach', ...this.ids(), name: String(name).slice(0, 200), mime, bytes })
    if (typeof id !== 'number') throw new Error('attachment was not stored')
    return id
  }

  private ids() {
    const { conversationId, messageId, callId } = this.ctx.props
    return { conversationId, messageId, callId }
  }

  private forward(call: HostCall): Promise<unknown> {
    const { userId } = this.ctx.props
    return this.env.USER_HUB.getByName(String(userId)).pluginHostCall(userId, BROWSER_RUN_PLUGIN_ID, call)
  }
}

let runtimeCache: Promise<{ source: string; hash: string }> | undefined

/** The bundled harness, read from static assets once per isolate. */
function loadRuntime(env: Env): Promise<{ source: string; hash: string }> {
  runtimeCache ??= (async () => {
    const [source, manifest] = await Promise.all([
      env.ASSETS.fetch(`https://assets.invalid${RUNTIME_PATH}`),
      env.ASSETS.fetch(`https://assets.invalid${RUNTIME_MANIFEST_PATH}`),
    ])
    if (!source.ok || !manifest.ok) throw new Error('browser runtime bundle is missing; run scripts/build-browser-runtime.ts')
    const { hash } = await manifest.json() as { hash: string }
    return { source: await source.text(), hash }
  })().catch((error: unknown) => {
    runtimeCache = undefined
    throw error
  })
  return runtimeCache
}

/** The main module is tiny and constant: the harness and the model's code are separate modules. */
const MAIN_MODULE = `import { WorkerEntrypoint } from 'cloudflare:workers'
import { createRunner } from './runtime.js'
import * as user from './user.js'
export default class extends WorkerEntrypoint {
  run(args) { return createRunner(this.env, user.run)(args) }
}
`
const PROBE_MODULE = 'export const run = undefined\n'

/**
 * Loads a Dynamic Worker around the model's code and runs it. Every run is a fresh isolate: the
 * stubs in its `env` carry this run's session and generation, and a cached isolate would keep the
 * previous run's.
 */
export class BrowserRunner extends WorkerEntrypoint<Env> {
  async run(args: RunnerArgs): Promise<RunResult> {
    const runtime = await loadRuntime(this.env)
    const { userId, conversationId, messageId, callId, code, ...runArgs } = args
    const exports = this.ctx.exports as unknown as {
      BrowserGateway: (options: { props: GatewayProps }) => Fetcher
      BrowserHost: (options: { props: HostProps }) => Fetcher
    }
    const worker = this.env.LOADER.load({
      compatibilityDate: DYNAMIC_WORKER_COMPAT_DATE,
      compatibilityFlags: ['nodejs_compat'],
      mainModule: 'main.js',
      modules: {
        'main.js': MAIN_MODULE,
        'runtime.js': runtime.source,
        'user.js': code ?? PROBE_MODULE,
      },
      env: {
        BROWSER: exports.BrowserGateway({ props: { sessionId: runArgs.sessionId } }),
        HOST: exports.BrowserHost({ props: { userId, conversationId, messageId, callId } }),
      },
      globalOutbound: null,
      limits: { cpuMs: DYNAMIC_WORKER_CPU_MS },
    })
    const entrypoint = worker.getEntrypoint() as unknown as { run(args: RunArgs): Promise<RunResult> }
    return entrypoint.run(runArgs)
  }
}
