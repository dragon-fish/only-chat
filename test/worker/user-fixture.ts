import { env } from 'cloudflare:workers'
import { createDb, type DB } from '@/server/db/client'
import { users } from '@/server/db/schema'

export async function seedTestUser(db: DB = createDb(env.DB)): Promise<void> {
  await db.insert(users).values({
    id: 1, name: 'owner', email: 'owner@example.com', settings: { plugins: {} },
    createdAt: new Date(0), updatedAt: new Date(0),
  }).onConflictDoNothing()
}
