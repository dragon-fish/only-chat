/**
 * Provider interfaces pointing at this host are answered by the local mock instead of the network.
 *
 * `.invalid` is reserved by RFC 2606 and never resolves, so a mock Provider that reaches a build
 * without the mock plugin fails loudly rather than quietly talking to a real endpoint.
 *
 * Kept dependency-free: the seed script imports it without pulling in cordis or the AI SDK.
 */
export const MOCK_HOST = 'mock.invalid'
export const MOCK_BASE_URL = `http://${MOCK_HOST}/v1`

export function isMockBaseUrl(baseUrl: string): boolean {
  try { return new URL(baseUrl).hostname === MOCK_HOST }
  catch { return false }
}
