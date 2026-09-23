import { loadEnvFile } from 'node:process'
import { d1Args, escapeSqlLiteral, readResults, runWrangler } from './lib/d1'
import { encryptSecret } from '../src/server/plugins/llm/crypto'
import { materializeModelMetadata } from '../src/server/plugins/model-catalog/resolve'
import { MOCK_BASE_URL } from '../src/server/plugins/mock-provider/constants'
import type { ModelMetadata } from '../src/shared/model-metadata'

/**
 * Creates the local mock Provider so the app can be driven end to end without spending money.
 *
 * Local only, on purpose: the mock adapter is registered behind `import.meta.env.DEV`, so a mock
 * Provider in a deployed database would resolve to an unreachable `.invalid` host.
 */
const PROVIDER_NAME = 'Mock (local)'

/**
 * The mock never reads a key, but `Llm.createModel` refuses a Provider without one before any
 * adapter is consulted, so the row carries an encrypted placeholder rather than NULL.
 */
const PLACEHOLDER_KEY = 'mock-provider-key-unused'

function encryptionSecret(): string {
  if (!process.env.KEY_ENCRYPTION_SECRET) {
    try { loadEnvFile('.dev.vars') }
    catch { /* reported below */ }
  }
  const secret = process.env.KEY_ENCRYPTION_SECRET
  if (!secret) throw new Error('KEY_ENCRYPTION_SECRET is not set. Add it to .dev.vars.')
  return secret
}

interface MockModel {
  id: string
  name: string
  tools: boolean
  reasoning: boolean
  image?: boolean
}

const MODELS: MockModel[] = [
  { id: 'mock-plain', name: 'Mock Plain', tools: false, reasoning: false },
  { id: 'mock-tools', name: 'Mock Tools', tools: true, reasoning: false },
  { id: 'mock-reasoning', name: 'Mock Reasoning', tools: true, reasoning: true },
  { id: 'mock-image', name: 'Mock Image', tools: false, reasoning: false, image: true },
]

function parseUserId(rawArgs: string[]): number {
  const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs
  const flag = args.indexOf('--user')
  if (flag === -1) return 1
  const value = Number(args[flag + 1])
  if (!Number.isInteger(value) || value <= 0) throw new Error('Pass a positive integer to --user.')
  return value
}

async function queryOne(sql: string): Promise<Record<string, unknown> | undefined> {
  return readResults(await runWrangler([...d1Args('local'), '--command', sql]))[0]
}

async function execute(sql: string): Promise<void> {
  await runWrangler([...d1Args('local'), '--command', sql])
}

function metadata(model: MockModel): ModelMetadata {
  if (model.image) {
    return {
      name: model.name,
      description: 'Local mock image model. Returns placeholder photos from picsum.photos at the requested size.',
      modalities: { input: ['text', 'image'], output: ['image'] },
    }
  }
  return {
    name: model.name,
    description: 'Local mock provider. Send /tool_call, /parallel, /reasoning, /error or /slow to shape the reply.',
    tool_call: model.tools,
    reasoning: model.reasoning,
    temperature: true,
    limit: { context: 128_000, output: 8_192 },
  }
}

async function main() {
  const userId = parseUserId(process.argv.slice(2))
  const now = Date.now()
  const name = escapeSqlLiteral(PROVIDER_NAME)

  const user = await queryOne(`SELECT id FROM users WHERE id = ${userId};`)
  if (!user) throw new Error(`No user ${userId} in the local database.`)

  const apiKey = escapeSqlLiteral(await encryptSecret(encryptionSecret(), PLACEHOLDER_KEY))
  const existing = await queryOne(`SELECT id FROM providers WHERE user_id = ${userId} AND name = ${name};`)
  if (existing) {
    await execute(`UPDATE providers SET api_key = ${apiKey}, enabled = 1 WHERE id = ${Number(existing.id)};`)
  } else {
    await execute(`INSERT INTO providers (user_id, name, api_key, enabled, created_at) VALUES (${userId}, ${name}, ${apiKey}, 1, ${now});`)
  }
  const provider = await queryOne(`SELECT id FROM providers WHERE user_id = ${userId} AND name = ${name};`)
  const providerId = Number(provider?.id)
  if (!Number.isInteger(providerId)) throw new Error('Could not resolve the mock provider id.')

  // The interface keeps a real protocol so protocol-dependent behaviour upstream stays on its
  // normal path; only the base URL marks it as mock.
  const baseUrl = escapeSqlLiteral(MOCK_BASE_URL)
  await execute(
    `INSERT INTO provider_interfaces (provider_id, protocol, base_url, native_files, created_at)`
    + ` VALUES (${providerId}, 'responses', ${baseUrl}, 0, ${now})`
    + ` ON CONFLICT (provider_id, protocol) DO UPDATE SET base_url = ${baseUrl};`,
  )
  const iface = await queryOne(`SELECT id FROM provider_interfaces WHERE provider_id = ${providerId} AND protocol = 'responses';`)
  const interfaceId = Number(iface?.id)
  if (!Number.isInteger(interfaceId)) throw new Error('Could not resolve the mock interface id.')
  await execute(`UPDATE providers SET default_interface_id = ${interfaceId} WHERE id = ${providerId};`)

  for (const [index, model] of MODELS.entries()) {
    const resolved = metadata(model)
    // Same derivation the catalog uses, so mock rows carry the same capability columns as real ones.
    const derived = materializeModelMetadata(resolved, model.id, 'Mock')
    const modelId = escapeSqlLiteral(model.id)
    const json = escapeSqlLiteral(JSON.stringify(resolved))
    const columns = `interface_id = ${interfaceId}, metadata_resolved = ${json},`
      + ` supports_reasoning = ${derived.supports_reasoning ? 1 : 0}, supports_tools = ${derived.supports_tools ? 1 : 0},`
      + ` supports_image_input = ${derived.supports_image_input ? 1 : 0}, supports_image_output = ${derived.supports_image_output ? 1 : 0},`
      + ` context_limit = ${derived.context_limit ?? 'NULL'}, output_limit = ${derived.output_limit ?? 'NULL'},`
      + ` enabled = 1, upstream_available = 1`
    await execute(
      `INSERT INTO models (provider_id, model_id, sort) VALUES (${providerId}, ${modelId}, ${index})`
      + ` ON CONFLICT (provider_id, model_id) DO NOTHING;`,
    )
    await execute(`UPDATE models SET ${columns}, sort = ${index} WHERE provider_id = ${providerId} AND model_id = ${modelId};`)
  }

  // Model lists are cached in KV under a key containing these revisions. Writing rows straight into
  // D1 bypasses the API paths that bump them, so without this the new models stay invisible until
  // some unrelated model edit invalidates the cache.
  await execute(`UPDATE providers SET model_revision = model_revision + 1 WHERE id = ${providerId};`)
  await execute(`UPDATE users SET enabled_models_revision = enabled_models_revision + 1 WHERE id = ${userId};`)

  console.log(`Seeded provider ${providerId} (${PROVIDER_NAME}) for user ${userId} with ${MODELS.length} models.`)
  console.log(`Interface ${interfaceId} → ${MOCK_BASE_URL} (protocol: responses)`)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Mock provider seeding failed.')
  process.exitCode ||= 1
})
