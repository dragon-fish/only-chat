import type { ComfyuiConfig, ComfyuiErrorType } from '../shared'

const REQUEST_TIMEOUT_MS = 30_000

export class ComfyuiError extends Error {
  constructor(message: string, readonly type: ComfyuiErrorType, readonly nodeErrors?: Record<string, unknown>) {
    super(message)
    this.name = 'ComfyuiError'
  }
}

export interface OutputImage {
  filename: string
  subfolder: string
  type: string
}

/** One `/history/<id>` entry; absent until the prompt finishes. */
export interface HistoryEntry {
  outputs?: Record<string, { images?: OutputImage[] } | undefined>
  status?: { status_str?: string, completed?: boolean, messages?: Array<[string, Record<string, unknown>]> }
}

/** Absent or blank means unset: the settings form stores a cleared text field as an empty string. */
export function configuredDir(value: string | undefined): string | null {
  return value ? value : null
}

export class ComfyuiClient {
  private readonly base: string
  private readonly headers: Record<string, string>
  private readonly fetcher: typeof fetch

  constructor(config: ComfyuiConfig, fetcher: typeof fetch = fetch) {
    // Called unbound: workerd's fetch throws "Illegal invocation" when `this` is anything else.
    this.fetcher = (input, init) => fetcher(input, init)
    this.base = config.base_url.replace(/\/+$/, '')
    this.headers = {
      // Without a User-Agent, Cloudflare's Browser Integrity Check answers 403 before Access runs.
      'User-Agent': 'only-chat',
      ...(config.cf_access_client_id && config.cf_access_client_secret
        ? { 'CF-Access-Client-Id': config.cf_access_client_id, 'CF-Access-Client-Secret': config.cf_access_client_secret }
        : {}),
    }
  }

  /** File paths relative to `dir`. */
  async listUserdata(dir: string): Promise<string[]> {
    const entries = await this.json<Array<string | { path: string }>>(`/api/userdata?dir=${encodeURIComponent(dir)}&recurse=true&full_info=true`)
    return entries.map(entry => typeof entry === 'string' ? entry : entry.path).sort()
  }

  async readUserdata(path: string): Promise<string> {
    return (await this.request(`/api/userdata/${encodeURIComponent(path)}`)).text()
  }

  modelFolders(): Promise<string[]> {
    return this.json('/api/models')
  }

  models(folder: string): Promise<string[]> {
    return this.json(`/api/models/${encodeURIComponent(folder)}`)
  }

  /** One class's definition, or every class's when `classType` is omitted (megabytes). */
  objectInfo(classType?: string): Promise<Record<string, Record<string, unknown>>> {
    return this.json(classType === undefined ? '/api/object_info' : `/api/object_info/${encodeURIComponent(classType)}`)
  }

  /** Validation happens here, synchronously: a 400 carries ComfyUI's per-node report. */
  async submit(workflow: Record<string, unknown>): Promise<string> {
    const response = await this.send('/api/prompt', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: workflow }),
    })
    if (response.status === 400) {
      const body = await response.json().catch(() => null) as { error?: { message?: string, details?: string }, node_errors?: Record<string, unknown> } | null
      const summary = [body?.error?.message, body?.error?.details].filter(Boolean).join(': ') || 'ComfyUI rejected the workflow'
      const nodeErrors = body?.node_errors && Object.keys(body.node_errors).length ? body.node_errors : undefined
      throw new ComfyuiError(summary, 'validation', nodeErrors)
    }
    const body = await this.parse<{ prompt_id?: string }>(await this.check(response, '/api/prompt'))
    if (!body.prompt_id) throw new ComfyuiError('ComfyUI accepted the workflow but returned no prompt_id', 'comfyui_error')
    return body.prompt_id
  }

  async history(promptId: string): Promise<HistoryEntry | null> {
    const body = await this.json<Record<string, HistoryEntry>>(`/api/history/${encodeURIComponent(promptId)}`)
    return body[promptId] ?? null
  }

  async view(image: OutputImage): Promise<{ bytes: Uint8Array<ArrayBuffer>, mime: string }> {
    const query = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder, type: image.type })
    const response = await this.request(`/api/view?${query}`)
    const mime = (response.headers.get('Content-Type') ?? '').split(';')[0]!.trim()
    return { bytes: new Uint8Array(await response.arrayBuffer()), mime }
  }

  private async json<T>(path: string): Promise<T> {
    return this.parse<T>(await this.request(path))
  }

  private async request(path: string): Promise<Response> {
    return this.check(await this.send(path, {}), path)
  }

  private async send(path: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetcher(`${this.base}${path}`, {
        ...init, headers: { ...this.headers, ...init.headers as Record<string, string> }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      throw new ComfyuiError(`Could not reach ComfyUI: ${error instanceof Error ? error.message : String(error)}`, 'network')
    }
  }

  private async check(response: Response, path: string): Promise<Response> {
    if (response.status === 401 || response.status === 403) {
      throw new ComfyuiError(`ComfyUI refused the request (${response.status}). Check the Cloudflare Access service token.`, 'auth')
    }
    if (response.status === 404) throw new ComfyuiError(`Not found: ${path.split('?')[0]}`, 'not_found')
    if (!response.ok) {
      const text = (await response.text().catch(() => '')).slice(0, 500)
      throw new ComfyuiError(`ComfyUI returned ${response.status}${text ? `: ${text}` : ''}`, 'comfyui_error')
    }
    // Cloudflare Access answers an unauthenticated request with its login page, not a status code.
    if ((response.headers.get('Content-Type') ?? '').includes('text/html')) {
      throw new ComfyuiError('ComfyUI answered with an HTML page, usually the Cloudflare Access login. Check the service token.', 'auth')
    }
    return response
  }

  private async parse<T>(response: Response): Promise<T> {
    try {
      return await response.json() as T
    } catch {
      throw new ComfyuiError('ComfyUI returned a response that is not JSON', 'comfyui_error')
    }
  }
}
