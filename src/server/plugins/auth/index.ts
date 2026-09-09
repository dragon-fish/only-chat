import { Context, Service } from 'cordis'
import { betterAuth } from 'better-auth'
import { createAuthMiddleware } from 'better-auth/api'
import { z } from 'zod'
import { drizzleAdapter } from '@better-auth/drizzle-adapter'
import { admin as adminPlugin } from 'better-auth/plugins/admin'
import { authAccounts, authSessions, authVerifications, users } from '@/server/db/schema'
import { authRoles } from './access'
import { protectOwner, registrationPolicy } from './policy'
import { parseAuthUserId } from './user-id'
import { AUTH_REVOKED_PATH, INTERNAL_USER_ID_HEADER } from '../hub/identity'

const authSchema = { users, authAccounts, authSessions, authVerifications }

export class Authentication extends Service {
  static readonly provide = 'auth'
  static readonly inject = ['env', 'db']
  readonly instance

  constructor(ctx: Context) {
    super(ctx, 'auth')
    this.instance = betterAuth({
      database: drizzleAdapter(ctx.db.orm, { provider: 'sqlite', schema: authSchema }),
      baseURL: ctx.env.BETTER_AUTH_URL,
      secret: ctx.env.BETTER_AUTH_SECRET,
      advanced: {
        database: { generateId: ({ model }) => model === 'users' || model === 'user' ? false : crypto.randomUUID() },
        ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
      },
      emailAndPassword: { enabled: true },
      user: { modelName: 'users', validateUserInfo: registrationPolicy(ctx.db.orm, ctx.env.ALLOW_REGISTER) },
      account: { modelName: 'authAccounts' },
      session: { modelName: 'authSessions' },
      verification: { modelName: 'authVerifications' },
      plugins: [adminPlugin({ adminUserIds: ['1'], roles: authRoles })],
      hooks: {
        before: protectOwner,
        after: createAuthMiddleware(async context => {
          if (!['/admin/ban-user', '/admin/update-user'].includes(context.path)) return
          // Failed endpoints return APIError; only a successful persisted ban carries this user.
          const userSchema = z.object({ id: z.union([z.string(), z.number()]), banned: z.literal(true) })
          const result = (context.path === '/admin/ban-user' ? z.object({ user: userSchema }).transform(result => result.user) : userSchema).safeParse(context.context.returned)
          if (!result.success) return
          const userId = parseAuthUserId(result.data.id)
          const response = await ctx.env.USER_HUB.getByName(String(userId)).fetch(new Request(`https://hub${AUTH_REVOKED_PATH}`, {
            method: 'POST', headers: { [INTERNAL_USER_ID_HEADER]: String(userId) },
          }))
          if (!response.ok) throw new Error('UserHub access revocation failed')
        }),
      },
    })
  }
}

export type AuthSession = Authentication['instance']['$Infer']['Session']
export type AuthUser = AuthSession['user']
