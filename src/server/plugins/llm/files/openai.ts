import { createOpenAI } from '@ai-sdk/openai'
import type { FilesV4 } from '@ai-sdk/provider'
import { filesOperation, normalizeFilesBaseURL } from './shared'
import { PROVIDER_FILE_TTL_SECONDS, type FilesClientSettings, type ScopedFilesClient } from './types'

export function createOpenAIFiles(settings: FilesClientSettings): ScopedFilesClient {
  const baseURL = normalizeFilesBaseURL(settings.baseURL)
  const sdk = createOpenAI({ baseURL, apiKey: settings.apiKey }).files()
  const files: FilesV4 = {
    specificationVersion: sdk.specificationVersion,
    provider: sdk.provider,
    uploadFile: options => filesOperation('upload', baseURL, () => sdk.uploadFile({
      ...options,
      providerOptions: { ...options.providerOptions, openai: {
        purpose: 'user_data', ...options.providerOptions?.openai, expiresAfter: PROVIDER_FILE_TTL_SECONDS,
      } },
    })),
    ...(sdk.deleteFile && { deleteFile: options => filesOperation('delete', baseURL, () => sdk.deleteFile!(options)) }),
    ...(sdk.getFileMetadata && { getFileMetadata: options => filesOperation('metadata lookup', baseURL, () => sdk.getFileMetadata!(options)) }),
    ...(sdk.downloadFile && { downloadFile: options => filesOperation('download', baseURL, () => sdk.downloadFile!(options)) }),
  }
  return { family: 'openai', baseURL, credentialVersion: settings.credentialVersion, files }
}
