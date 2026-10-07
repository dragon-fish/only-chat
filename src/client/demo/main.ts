import { DemoBackend } from './backend'
import { createFakeFetch } from './fake-fetch'
import { createFakeWebSocket } from './fake-socket'
import { installMemoryStorage } from './memory-storage'
import { DEFAULT_MODEL_ID, PROVIDER_ID } from './script'

// Everything here must be in place before any app module loads: Better Auth captures `fetch` when
// its client is created, so the app is imported dynamically below, never statically.
const backend = new DemoBackend()
installMemoryStorage({ 'oc.model': JSON.stringify({ provider_id: PROVIDER_ID, model_id: DEFAULT_MODEL_ID }) })
window.fetch = createFakeFetch(backend.routes(), window.fetch.bind(window), window.location.origin)
window.WebSocket = createFakeWebSocket(backend, window.location.origin)

const { boot } = await import('./boot')
await boot(backend)
