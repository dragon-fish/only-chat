import { ref, type Ref } from 'vue'
import { api } from '@/client/lib/api'

const names = ref<Record<string, string>>({})
let pending: Promise<void> | null = null

/**
 * Service names for tool cards, fetched once per page however many cards ask. A server deleted
 * since is simply absent, and the card falls back to its service_id.
 */
export function useMcpServerNames(): Ref<Record<string, string>> {
  pending ??= api.mcpServers()
    .then(({ servers }) => { names.value = Object.fromEntries(servers.map(server => [server.key, server.name])) })
    .catch(() => { pending = null })
  return names
}
