import { inject, provide, type InjectionKey } from 'vue'
import { api } from '@/client/lib/api'
import { ASSET_REF_LENGTH, ASSET_SCHEME } from '@/shared/asset-ref'
import type { ConversationAsset } from '@/shared/conversation-assets'

const ASSET_SCOPE: InjectionKey<number> = Symbol('asset-scope')

/** The conversation whose files an `asset:` reference in rendered markdown names. */
export function provideAssetScope(conversationId: number): void {
  provide(ASSET_SCOPE, conversationId)
}

export function useAssetScope(): number | null {
  return inject(ASSET_SCOPE, null)
}

const ASSET_URL = new RegExp(`^${ASSET_SCHEME}:([0-9a-f]{${ASSET_REF_LENGTH},64})$`, 'i')

/** The hex prefix an `asset:` URL names, or null for any other URL. */
export function assetRefOf(url: string): string | null {
  return ASSET_URL.exec(url.trim())?.[1]!.toLowerCase() ?? null
}

type Fetch = (conversationId: number) => Promise<{ assets: ConversationAsset[] }>

/**
 * One asset list per conversation, shared by every image in it. A reference the cached list does
 * not know is fetched again once: the image it names may have arrived after the list was read.
 */
export function createAssetResolver(fetchAssets: Fetch = id => api.conversationAssets(id)) {
  const lists = new Map<number, Promise<ConversationAsset[]>>()
  const load = (conversationId: number) => {
    const pending = fetchAssets(conversationId).then(body => body.assets)
    lists.set(conversationId, pending)
    // A failed read must not be cached: the next image gets to try again.
    pending.catch(() => { if (lists.get(conversationId) === pending) lists.delete(conversationId) })
    return pending
  }
  const find = (assets: readonly ConversationAsset[], ref: string) => {
    const matches = assets.filter(asset => ref.startsWith(asset.ref.toLowerCase()))
    return matches.length === 1 ? matches[0]! : null
  }
  return async (conversationId: number, ref: string): Promise<ConversationAsset | null> => {
    const cached = lists.get(conversationId)
    const found = cached ? find(await cached, ref) : null
    if (found) return found
    // Several images of one reply miss together; they share the refetch rather than each starting one.
    const fresh = lists.get(conversationId) !== cached ? lists.get(conversationId)! : load(conversationId)
    return find(await fresh, ref)
  }
}

export const resolveAssetRef = createAssetResolver()
