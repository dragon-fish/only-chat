import { eq } from 'drizzle-orm'
import type { DB } from '@/server/db/client'
import { siteSettings } from '@/server/db/schema'
import { DEFAULT_UPLOAD_POLICY, UploadPolicySchema, type UploadPolicy } from '@/shared/upload-policy'

export const UPLOAD_POLICY_KEY = 'uploads.policy'

/** Read per request so administrator changes also apply to clients with an older cached policy. */
export async function resolveUploadPolicy(db: DB): Promise<UploadPolicy> {
  const row = await db.query.siteSettings.findFirst({ where: eq(siteSettings.key, UPLOAD_POLICY_KEY) })
  if (!row) return DEFAULT_UPLOAD_POLICY
  if (typeof row.value !== 'string') throw new Error('Invalid stored upload policy')
  return UploadPolicySchema.parse(JSON.parse(row.value))
}
