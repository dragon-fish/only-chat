import type { FilesV4 } from '@ai-sdk/provider'

export interface ScopedFilesClient {
  family: 'openai' | 'anthropic'
  baseURL: string
  credentialVersion: number
  files: FilesV4
}

export interface FilesClientSettings {
  baseURL: string
  apiKey: string
  credentialVersion: number
}

export const PROVIDER_FILE_TTL_SECONDS = 604_800
