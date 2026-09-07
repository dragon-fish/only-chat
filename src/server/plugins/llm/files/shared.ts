import { APICallError } from '@ai-sdk/provider'

/** The same canonical endpoint must identify a pointer and receive upload/delete requests. */
export function normalizeFilesBaseURL(baseURL: string): string {
  let url: URL
  try { url = new URL(baseURL) } catch { throw new Error('Files base URL must be an absolute HTTP(S) URL') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Files base URL must use HTTP(S) without credentials, query, or fragment')
  }
  return url.toString().replace(/\/+$/, '')
}

/** Provider errors may echo authorization or file contents; retain only classification fields. */
export async function filesOperation<T>(operation: string, baseURL: string, run: () => PromiseLike<T>): Promise<T> {
  try { return await run() } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new DOMException('Files request aborted', 'AbortError')
    if (APICallError.isInstance(error)) {
      throw new APICallError({
        message: `Files ${operation} failed${error.statusCode === undefined ? '' : ` (HTTP ${error.statusCode})`}`,
        url: baseURL,
        requestBodyValues: undefined,
        statusCode: error.statusCode,
        isRetryable: error.isRetryable,
      })
    }
    throw new Error(`Files ${operation} failed`)
  }
}
