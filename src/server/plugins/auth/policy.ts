import type { BetterAuthOptions } from 'better-auth'
import { APIError, createAuthMiddleware } from 'better-auth/api'
import { z } from 'zod'
import type { DB } from '@/server/db/client'
import { resolveAllowRegister } from './site-settings'

type ValidateUserInfo = NonNullable<NonNullable<BetterAuthOptions['user']>['validateUserInfo']>

export function registrationPolicy(db: DB, envValue: unknown) {
  return async ({ source }: Parameters<ValidateUserInfo>[0]) => {
    if (source.action !== 'create-user' || source.method === 'admin') return
    if (!(await resolveAllowRegister(db, envValue)).value) {
      return { error: 'registration_closed', errorDescription: 'Registration is closed' }
    }
  }
}

const adminMutationSchema = z.object({
  userId: z.coerce.string(),
  role: z.unknown().optional(),
  data: z.unknown().optional(),
})
const adminUpdateSchema = z.object({ role: z.unknown().optional(), banned: z.unknown().optional() })

export const protectOwner = createAuthMiddleware(async context => {
  if (!['/admin/ban-user', '/admin/set-role', '/admin/update-user'].includes(context.path)) return
  const body = adminMutationSchema.safeParse(context.body)
  // SQLite compares integer IDs numerically; strings such as "01" still target the owner.
  if (!body.success || Number(body.data.userId) !== 1) return
  const update = adminUpdateSchema.safeParse(body.data.data)
  const role = context.path === '/admin/set-role' ? body.data.role : update.data?.role
  const keepsAdmin = role === 'admin' || (Array.isArray(role) && role.includes('admin'))
  // Admin update-user accepts arbitrary data, and the adapter coerces truthy values to booleans.
  if (context.path === '/admin/ban-user' || Boolean(update.data?.banned) || (role !== undefined && !keepsAdmin)) {
    throw new APIError('FORBIDDEN', { message: 'The owner cannot be banned or demoted' })
  }
})
