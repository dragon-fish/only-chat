// Optional configuration `wrangler types` cannot see. Do not move these into `wrangler.jsonc` `vars`:
// every deploy would reset a value set on the dashboard back to the declared default. Nor into
// `secrets.required`: a deploy without them would fail. Set them with `wrangler secret put`.
interface Env {
  /** Only the exact string "true" enables the owner audit routes. */
  ENABLE_AUDIT?: string
}
