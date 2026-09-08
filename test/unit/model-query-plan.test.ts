import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { buildModelQuery } from '@/server/plugins/api/model-query'

const databases: DatabaseSync[] = []
afterEach(() => databases.splice(0).forEach(db => db.close()))

describe('indexed model query plans', () => {
  it.each([
    { provider_id: 1, enabled: true, vision: true },
    { provider_id: 1, enabled: true, vision: true, cursor: btoa(JSON.stringify({ sort: 0, id: 500 })) },
    { enabled: true, reasoning: true },
    { enabled: true, tools: true },
    { enabled: true, image_output: true },
    { enabled: true, min_context: 1000 },
    { enabled: true, lab_id: 'lab' },
    { interface_id: 1 },
    { search: 'alpha' },
  ])('uses an index for %j without scanning models', input => {
    const db = new DatabaseSync(':memory:')
    databases.push(db)
    for (const migration of [
      '0000_init.sql',
      '0001_projects-media.sql',
      '0002_provider-catalog.sql',
      '0003_provider-files-cleanup.sql',
      '0004_model-membership-state.sql',
    ]) {
      db.exec(readFileSync(new URL(`../../migrations/${migration}`, import.meta.url), 'utf8'))
    }
    const query = buildModelQuery({ ...input, limit: 50 })
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.params) as { detail: string }[]
    expect(plan.some(row => /USING (?:COVERING )?INDEX|USING INTEGER PRIMARY KEY/u.test(row.detail))).toBe(true)
    expect(plan.some(row => /SCAN (?:m|models)(?: |$)/u.test(row.detail))).toBe(false)
  })

  it('rejects short trigram queries before issuing SQL and escapes FTS operators as literal text', () => {
    expect(() => buildModelQuery({ search: 'ab', limit: 50 })).toThrow(/3/u)
    const query = buildModelQuery({ search: 'alpha" OR beta', limit: 50 })
    expect(query.params).toContain('"alpha"" OR beta"')
  })
})
