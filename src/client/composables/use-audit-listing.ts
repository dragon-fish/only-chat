import { computed, onMounted, shallowRef, watch } from 'vue'
import { useRoute, useRouter, type LocationQueryRaw } from 'vue-router'
import { authClient } from '@/client/lib/auth-client'
import { useAuthStore } from '@/client/stores/auth'
import { useSiteConfigStore } from '@/client/stores/site-config'
import { isAuthOwner } from '@/shared/auth'

export const AUDIT_LIMITS = ['50', '100', '250', '500'] as const

export interface AuditUserOption { id: string, name: string, email: string }

/**
 * The URL is the listing's whole state, as on a MediaWiki special page: a filtered view can be
 * bookmarked or shared, and reload and back keep it. Changing a filter drops the paging cursor,
 * which only means something for the query that produced it.
 */
export function useAuditListing() {
  const route = useRoute()
  const router = useRouter()
  const query = computed<Record<string, string>>(() => Object.fromEntries(Object.entries(route.query)
    .flatMap(([key, value]) => typeof value === 'string' && value !== '' ? [[key, value]] : [])))

  function withQuery(patch: Record<string, string | undefined>, keepCursor = false): LocationQueryRaw {
    const next: Record<string, string | undefined> = { ...query.value, ...(keepCursor ? {} : { after: undefined, before: undefined }), ...patch }
    return Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined && value !== ''))
  }
  function update(patch: Record<string, string | undefined>, keepCursor = false) {
    void router.push({ query: withQuery(patch, keepCursor) })
  }

  return { query, withQuery, update }
}

/** Every account, for the owner filter. A failure leaves the filter empty, not the listing. */
export function useAuditUsers() {
  const users = shallowRef<AuditUserOption[]>([])
  onMounted(async () => {
    try {
      const result = await authClient.admin.listUsers({ query: { limit: 500, sortBy: 'id', sortDirection: 'asc' } })
      users.value = (result.data?.users ?? []).map(user => ({ id: String(user.id), name: user.name, email: user.email }))
    } catch { users.value = [] }
  })
  return users
}

/** Whether to offer the audit pages: only to the owner, and only while the deployment enables them. */
export function useAuditEnabled() {
  const auth = useAuthStore()
  const site = useSiteConfigStore()
  // Nobody but the owner is ever told `audit`; for anyone else the field is absent and this is false.
  watch(() => auth.generation, () => { if (isAuthOwner(auth.authUser)) site.load().catch(() => {}) }, { immediate: true })
  return computed(() => isAuthOwner(auth.authUser) && site.config?.audit === true)
}
