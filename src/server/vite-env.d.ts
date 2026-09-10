/**
 * The Worker bundle is built by @cloudflare/vite-plugin, so Vite substitutes `import.meta.env.DEV`
 * with a literal at build time and dead code behind it is dropped. Declared here because the Worker
 * tsconfig deliberately does not pull in `vite/client`, which is browser-shaped.
 */
interface ImportMetaEnv {
  readonly DEV: boolean
  readonly PROD: boolean
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
