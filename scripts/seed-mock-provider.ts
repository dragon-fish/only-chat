import { d1Args, escapeSqlLiteral, readResults, runWrangler } from './lib/d1.ts'
import { MOCK_BASE_URL } from '../src/server/plugins/mock-provider/constants.ts'

/**
 * Creates the local mock Provider so the app can be driven end to end without spending money.
 *
 * Local only, on purpose: the mock adapter is registered behind `import.meta.env.DEV`, so a mock
 * Provider in a deployed database would resolve to an unreachable `.invalid` host.
 */
const PROVIDER_NAME = 'Mock (local)'

interface MockModel {
  id: string
  name: string
  tools: boolean
  reasoning: boolean
}

const MODELS: MockModel[] = [
  { id: 'mock-plain', name: 'Mock Plain', tools: false, reasoning: false },
  { id: 'mock-tools', name: 'Mock Tools', tools: true, reasoning: false },
  { id: 'mock-reasoning', name: 'Mock Reasoning', tools: true, reasoning: true },
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

function metadata(model: MockModel): string {
  return JSON.stringify({
    name: model.name,
    description: 'Local mock provider. Send /tool_call, /parallel, /reasoning, /error or /slow to shape the reply.',
    tool_call: model.tools,
    reasoning: model.reasoning,
    temperature: true,
    limit: { context: 128_000, output: 8_192 },
  })
}

async function main() {
  const userId = parseUserId(process.argv.slice(2))
  const now = Date.now()
  const name = escapeSqlLiteral(PROVIDER_NAME)

  const user = await queryOne(`SELECT id FROM users WHERE id = ${userId};`)
  if (!user) throw new Error(`No user ${userId} in the local database.`)

  const existing = await queryOne(`SELECT id FROM providers WHERE user_id = ${userId} AND name = ${name};`)
  if (!existing) {
    await execute(`INSERT INTO providers (user_id, name, api_key, enabled, created_at) VALUES (${userId}, ${name}, NULL, 1, ${now});`)
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
    const modelId = escapeSqlLiteral(model.id)
    const resolved = escapeSqlLiteral(metadata(model))
    const searchName = escapeSqlLiteral(model.name.toLowerCase())
    await execute(
      `INSERT INTO models (provider_id, model_id, interface_id, metadata_resolved, search_name,`
      + ` supports_reasoning, supports_tools, enabled, manual_pinned, upstream_available, sort)`
      + ` VALUES (${providerId}, ${modelId}, ${interfaceId}, ${resolved}, ${searchName},`
      + ` ${model.reasoning ? 1 : 0}, ${model.tools ? 1 : 0}, 1, 1, 1, ${index})`
      + ` ON CONFLICT (provider_id, model_id) DO UPDATE SET`
      + ` interface_id = ${interfaceId}, metadata_resolved = ${resolved}, search_name = ${searchName},`
      + ` supports_reasoning = ${model.reasoning ? 1 : 0}, supports_tools = ${model.tools ? 1 : 0},`
      + ` enabled = 1, upstream_available = 1;`,
    )
  }

  console.log(`Seeded provider ${providerId} (${PROVIDER_NAME}) for user ${userId} with ${MODELS.length} models.`)
  console.log(`Interface ${interfaceId} → ${MOCK_BASE_URL} (protocol: responses)`)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Mock provider seeding failed.')
  process.exitCode ||= 1
})
