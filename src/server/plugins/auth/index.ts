import { Context, Service } from 'cordis'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from '@better-auth/drizzle-adapter'
import { admin as adminPlugin } from 'better-auth/plugins/admin'
import { authAccounts, authSessions, authVerifications, users } from '@/server/db/schema'
import { authRoles } from './access'
import { protectOwner, registrationPolicy } from './policy'

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
      hooks: { before: protectOwner },
    })
  }
}

export type AuthSession = Authentication['instance']['$Infer']['Session']
export type AuthUser = AuthSession['user']
