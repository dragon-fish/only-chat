import type { LocationQuery, RouteLocationNormalizedLoaded, RouteLocationRaw } from 'vue-router'

/**
 * A chat opens an image over itself as `?image=<artifact id>`, so closing the viewer — or the Back
 * button — leaves the person in the chat. Gallery and Studio keep their own `/a/:id` routes.
 */
const QUERY_KEY = 'image'

export function viewerArtifactId(query: LocationQuery): number | null {
  const value = query[QUERY_KEY]
  const id = Number(typeof value === 'string' ? value : undefined)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

export function withViewer(route: RouteLocationNormalizedLoaded, artifactId: number): RouteLocationRaw {
  return { path: route.path, hash: route.hash, query: { ...route.query, [QUERY_KEY]: String(artifactId) } }
}

export function withoutViewer(route: RouteLocationNormalizedLoaded): RouteLocationRaw {
  const { [QUERY_KEY]: _, ...query } = route.query
  return { path: route.path, hash: route.hash, query }
}
