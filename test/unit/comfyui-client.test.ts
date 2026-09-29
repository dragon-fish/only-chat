import { describe, expect, it } from 'vitest'
import { COMFYUI_CONFIG_SCHEMA } from '@/plugins/comfyui/shared'
import { ComfyuiClient, ComfyuiError, type HistoryEntry } from '@/plugins/comfyui/server/client'
import { MAX_OUTPUT_IMAGES, readHistory } from '@/plugins/comfyui/server/history'
import { compactNodeInfo } from '@/plugins/comfyui/server/runners'

const config = {
  base_url: 'https://comfy.example/',
  headers: [{ name: 'CF-Access-Client-Id', value: 'id.access', secret: true }, { name: 'CF-Access-Client-Secret', value: 'secret', secret: true }],
}

function clientAnswering(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string, headers: Record<string, string> }> = []
  const client = new ComfyuiClient(config, async (input, init) => {
    calls.push({ url: String(input), headers: init?.headers as Record<string, string> })
    return respond(String(input), init ?? {})
  })
  return { client, calls }
}

async function errorOf(promise: Promise<unknown>): Promise<ComfyuiError> {
  const error = await promise.then(() => null, (caught: unknown) => caught)
  expect(error).toBeInstanceOf(ComfyuiError)
  return error as ComfyuiError
}

describe('ComfyuiClient', () => {
  it('joins paths onto a base URL with a trailing slash and sends the Access headers', async () => {
    const { client, calls } = clientAnswering(() => Response.json(['loras']))
    await client.modelFolders()
    expect(calls[0]!.url).toBe('https://comfy.example/api/models')
    expect(calls[0]!.headers).toMatchObject({ 'CF-Access-Client-Id': 'id.access', 'CF-Access-Client-Secret': 'secret', 'User-Agent': 'only-chat' })
  })

  it('encodes a userdata path as one segment', async () => {
    const { client, calls } = clientAnswering(() => new Response('# guide', { headers: { 'Content-Type': 'text/markdown' } }))
    await client.readUserdata('guides/anima.md')
    expect(calls[0]!.url).toBe('https://comfy.example/api/userdata/guides%2Fanima.md')
  })

  it.each([
    ['a 403', () => new Response('denied', { status: 403 }), 'auth'],
    ['the Access login page', () => new Response('<html>', { headers: { 'Content-Type': 'text/html' } }), 'auth'],
    ['a 404', () => new Response('404: Not Found', { status: 404 }), 'not_found'],
    ['a 500', () => new Response('boom', { status: 500 }), 'comfyui_error'],
    ['a connection failure', () => { throw new TypeError('fetch failed') }, 'network'],
  ] as const)('classifies %s', async (_, respond, type) => {
    const { client } = clientAnswering(respond)
    expect((await errorOf(client.modelFolders())).type).toBe(type)
  })

  it('carries ComfyUI\'s per-node report when a workflow fails validation', async () => {
    const nodeErrors = { 2: { errors: [{ message: 'Value not in list', details: 'lora_name: x' }], class_type: 'LoraLoader' } }
    const { client } = clientAnswering(() => Response.json({
      error: { type: 'prompt_outputs_failed_validation', message: 'Prompt outputs failed validation', details: '' }, node_errors: nodeErrors,
    }, { status: 400 }))
    const error = await errorOf(client.submit({}))
    expect(error.type).toBe('validation')
    expect(error.nodeErrors).toEqual(nodeErrors)
  })

  it('returns the prompt id of an accepted workflow', async () => {
    const { client } = clientAnswering(() => Response.json({ prompt_id: 'p-1', number: 3, node_errors: {} }))
    await expect(client.submit({})).resolves.toBe('p-1')
  })
})

describe('readHistory', () => {
  const done = (outputs: HistoryEntry['outputs'], messages: Array<[string, Record<string, unknown>]> = []): HistoryEntry => ({
    outputs, status: { status_str: 'success', completed: true, messages },
  })
  const image = (filename: string) => ({ filename, subfolder: '', type: 'output' })

  it('is pending until the entry exists', () => {
    expect(readHistory(null)).toEqual({ state: 'pending' })
  })

  it('collects images in node-id order, numerically', () => {
    const outcome = readHistory(done({ 10: { images: [image('c.png')] }, 9: { images: [image('a.png'), image('b.png')] } }))
    expect(outcome).toMatchObject({ state: 'success', images: [image('a.png'), image('b.png'), image('c.png')] })
  })

  it('caps the number of images', () => {
    const many = Array.from({ length: MAX_OUTPUT_IMAGES + 3 }, (_, index) => image(`${index}.png`))
    expect((readHistory(done({ 1: { images: many } })) as { images: unknown[] }).images).toHaveLength(MAX_OUTPUT_IMAGES)
  })

  it('measures execution time from the status messages', () => {
    const outcome = readHistory(done({}, [['execution_start', { timestamp: 1000 }], ['execution_success', { timestamp: 43_300 }]]))
    expect(outcome).toMatchObject({ durationMs: 42_300 })
  })

  it('reports the exception of a failed execution', () => {
    const outcome = readHistory({ status: { status_str: 'error', completed: false, messages: [
      ['execution_start', { timestamp: 1 }],
      ['execution_error', { node_id: '5', node_type: 'KSampler', exception_message: 'CUDA out of memory\n' }],
    ] } })
    expect(outcome).toEqual({ state: 'error', message: 'CUDA out of memory (KSampler #5)' })
  })
})

describe('compactNodeInfo', () => {
  const many = Array.from({ length: 150 }, (_, index) => `model-${index}.safetensors`)

  it('caps both spellings of a combo input and leaves other inputs alone', () => {
    const info = compactNodeInfo({ input: { required: {
      legacy: [many, { tooltip: 'x' }],
      modern: ['COMBO', { options: many }],
      steps: ['INT', { default: 20 }],
    } } })
    const required = (info.input as { required: Record<string, [unknown, { options?: unknown[] }]> }).required
    expect(required.legacy![0]).toHaveLength(101)
    expect(required.modern![1].options).toHaveLength(101)
    expect(required.steps).toEqual(['INT', { default: 20 }])
  })
})

describe('COMFYUI_CONFIG_SCHEMA', () => {
  it('refuses a header name HTTP cannot carry, or the same header twice', () => {
    const withHeaders = (names: string[]) => COMFYUI_CONFIG_SCHEMA.safeParse({
      base_url: 'https://comfy.example', headers: names.map(name => ({ name, value: 'v', secret: false })),
    }).success
    expect(withHeaders(['Authorization'])).toBe(true)
    expect(withHeaders(['Bad Header'])).toBe(false)
    expect(withHeaders(['X-Token', 'x-token'])).toBe(false)
  })

  it('refuses plain http to a remote host', () => {
    expect(COMFYUI_CONFIG_SCHEMA.safeParse({ base_url: 'http://comfy.example' }).success).toBe(false)
  })

  it('refuses a directory that climbs out of userdata', () => {
    expect(COMFYUI_CONFIG_SCHEMA.safeParse({ base_url: 'https://comfy.example', workflows_dir: '../secrets' }).success).toBe(false)
  })
})
