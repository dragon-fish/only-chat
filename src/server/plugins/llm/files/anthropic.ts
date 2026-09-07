import { createAnthropic } from '@ai-sdk/anthropic'
import { APICallError, type FilesV4 } from '@ai-sdk/provider'
import { combineHeaders, createJsonResponseHandler, deleteFromApi, type FetchFunction } from '@ai-sdk/provider-utils'
import { z } from 'zod'
import { filesOperation, normalizeFilesBaseURL } from './shared'
import { PROVIDER_FILE_TTL_SECONDS, type FilesClientSettings, type ScopedFilesClient } from './types'

/** URL parsers collapse even encoded dot segments; double-encode these as the OpenAI SDK does. */
function encodeFileId(id: string): string {
  return id === '.' ? '%252E' : id === '..' ? '%252E%252E' : encodeURIComponent(id)
}

export function createAnthropicFiles(settings: FilesClientSettings): ScopedFilesClient {
  const normalized = normalizeFilesBaseURL(settings.baseURL)
  // Match the Anthropic SDK's official-host normalization for the application-owned DELETE too.
  const baseURL = normalized === 'https://api.anthropic.com' ? `${normalized}/v1` : normalized
  const uploadFetch: FetchFunction = (input, init) => {
    if (init?.method !== 'POST' || String(input) !== `${baseURL}/files` || !(init.body instanceof FormData)) {
      throw new Error('Unexpected Anthropic Files upload request')
    }
    init.body.set('expires_in_seconds', String(PROVIDER_FILE_TTL_SECONDS))
    return fetch(input, init)
  }
  const sdk = createAnthropic({ baseURL, apiKey: settings.apiKey, fetch: uploadFetch }).files()
  const files: FilesV4 = {
    specificationVersion: sdk.specificationVersion,
    provider: sdk.provider,
    uploadFile: options => filesOperation('upload', baseURL, () => sdk.uploadFile(options)),
    deleteFile: options => filesOperation('delete', baseURL, async () => {
      const id = options.file.anthropic
      if (typeof id !== 'string' || id.trim() === '') throw new Error('Missing Anthropic file reference')
      const { value } = await deleteFromApi({
        url: `${baseURL}/files/${encodeFileId(id)}`,
        headers: combineHeaders({
          'x-api-key': settings.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'files-api-2025-04-14',
        }, options.headers),
        abortSignal: options.abortSignal,
        successfulResponseHandler: createJsonResponseHandler(z.object({ id: z.string(), type: z.literal('file_deleted') })),
        failedResponseHandler: async ({ response, url }) => {
          await response.body?.cancel().catch(() => {})
          return { value: new APICallError({
            message: 'Files deletion failed', url, requestBodyValues: undefined, statusCode: response.status,
          }) }
        },
      })
      if (value.id !== id) throw new Error('Anthropic did not confirm deletion of the requested file')
      return { warnings: [], providerReference: { anthropic: value.id }, deleted: true }
    }),
  }
  return { family: 'anthropic', baseURL, credentialVersion: settings.credentialVersion, files }
}
