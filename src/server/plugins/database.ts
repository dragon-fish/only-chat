import { Context, Service } from 'cordis'
import { createDb, type DB } from '../db/client'

export class Database extends Service {
  static readonly provide = 'db'
  static readonly inject = ['env']

  readonly orm: DB

  constructor(ctx: Context) {
    super(ctx, 'db')
    this.orm = createDb(ctx.env.DB)
  }
}
