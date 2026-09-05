import { Context, Service } from 'cordis'
import { createDb, type DB } from '../db/client'
import { users } from '../db/schema'
import { DEFAULT_USER_ID } from '@/shared/constants'

export async function ensureDefaultUser(db: DB): Promise<void> {
  await db
    .insert(users)
    .values({ id: DEFAULT_USER_ID, name: 'owner', settings: { plugins: {} }, created_at: Date.now() })
    .onConflictDoNothing()
}

export class Database extends Service {
  static readonly provide = 'db'
  static readonly inject = ['env']

  readonly orm: DB

  constructor(ctx: Context) {
    super(ctx, 'db')
    this.orm = createDb(ctx.env.DB)
  }

  async [Service.init]() {
    await ensureDefaultUser(this.orm)
  }
}
