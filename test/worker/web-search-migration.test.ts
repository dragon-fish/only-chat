import { env } from 'cloudflare:workers'
import { applyD1Migrations } from 'cloudflare:test'
import { expect, it } from 'vitest'

it('moves a Tavily configuration and switch onto the web search plugin, keeping it on Tavily', async () => {
  const legacy = env.TEST_LEGACY_DB
  const at = env.TEST_MIGRATIONS.findIndex(migration => migration.name.startsWith('0029_web-search-plugin'))
  expect(at).toBeGreaterThan(0)
  await applyD1Migrations(legacy, env.TEST_MIGRATIONS.slice(0, at))
  await legacy.batch([
    legacy.prepare("INSERT INTO users (id, name, email, settings, created_at, updated_at) VALUES (1, 'tavily user', 'a@example.com', ?, 0, 0)")
      .bind(JSON.stringify({ plugins: { tavily: true, datetime: false } })),
    legacy.prepare("INSERT INTO users (id, name, email, settings, created_at, updated_at) VALUES (2, 'bystander', 'b@example.com', ?, 0, 0)")
      .bind(JSON.stringify({ plugins: { datetime: true } })),
    legacy.prepare("INSERT INTO plugin_configs (user_id, plugin_id, key, value, updated_at) VALUES (1, 'tavily', 'api_key', 'iv.ciphertext', 5)"),
    legacy.prepare("INSERT INTO plugin_configs (user_id, plugin_id, key, value, updated_at) VALUES (1, 'tavily', 'search_depth', '\"advanced\"', 9)"),
    legacy.prepare("INSERT INTO plugin_configs (user_id, plugin_id, key, value, updated_at) VALUES (1, 'tavily', 'search_calls_per_turn', '4', 7)"),
  ])

  await applyD1Migrations(legacy, env.TEST_MIGRATIONS)

  const { results: rows } = await legacy.prepare('SELECT user_id, plugin_id, key, value, updated_at FROM plugin_configs ORDER BY key').all()
  expect(rows).toEqual([
    { user_id: 1, plugin_id: 'web_search', key: 'backend', value: '"tavily"', updated_at: 9 },
    { user_id: 1, plugin_id: 'web_search', key: 'search_calls_per_turn', value: '4', updated_at: 7 },
    { user_id: 1, plugin_id: 'web_search', key: 'tavily_api_key', value: 'iv.ciphertext', updated_at: 5 },
    { user_id: 1, plugin_id: 'web_search', key: 'tavily_search_depth', value: '"advanced"', updated_at: 9 },
  ])
  const { results: settings } = await legacy.prepare('SELECT id, settings FROM users ORDER BY id').all<{ id: number; settings: string }>()
  expect(settings.map(row => JSON.parse(row.settings))).toEqual([
    { plugins: { datetime: false, web_search: true } },
    { plugins: { datetime: true } },
  ])
})
