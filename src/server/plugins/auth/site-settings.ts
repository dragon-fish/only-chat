import { eq } from 'drizzle-orm'
import type { DB } from '@/server/db/client'
import { siteSettings } from '@/server/db/schema'

export interface ResolvedBoolean {
  value: boolean
  source: 'db' | 'env' | 'default'
}

function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value !== 'string') return undefined
  if (value.toLowerCase() === 'true') return true
  if (value.toLowerCase() === 'false') return false
  return undefined
}

export async function resolveAllowRegister(db: DB, envValue: unknown): Promise<ResolvedBoolean> {
  const row = await db.query.siteSettings.findFirst({ where: eq(siteSettings.key, 'auth.allow_register') })
  if (row) {
    const value = parseBoolean(row.value)
    if (value === undefined) throw new Error('Invalid stored registration setting')
    return { value, source: 'db' }
  }
  if (envValue === undefined) return { value: false, source: 'default' }
  const value = parseBoolean(envValue)
  if (value === undefined) console.warn('Invalid ALLOW_REGISTER configuration; registration is disabled')
  return { value: value ?? false, source: 'env' }
}
