import { eq } from 'drizzle-orm'
import type { DB } from '@/server/db/client'
import { siteSettings } from '@/server/db/schema'
import { FILE_EXTENSIONS } from '@/shared/file-media'
import { DEFAULT_UPLOAD_POLICY, MAX_UPLOAD_POLICY_BYTES, type UploadPolicy } from '@/shared/upload-policy'

export const UPLOAD_POLICY_KEY = 'uploads.policy'

/**
 * Reads the chat attachment policy (spec §6.2). Read per request so administrator changes also
 * apply to clients with an older cached policy.
 */
export async function resolveUploadPolicy(db: DB): Promise<UploadPolicy> {
  const row = await db.query.siteSettings.findFirst({ where: eq(siteSettings.key, UPLOAD_POLICY_KEY) })
  return row ? parseStoredUploadPolicy(row.value) : DEFAULT_UPLOAD_POLICY
}

/**
 * Never throws: this runs on the public `/site-config` and on every chat upload, so a stored value
 * written by an older build (a format since removed, a limit above today's cap) must not take them
 * down. Unknown formats are dropped, an over-cap limit is clamped, and anything unreadable falls
 * back to the default for that field.
 */
export function parseStoredUploadPolicy(stored: unknown): UploadPolicy {
  let value: unknown
  try { value = typeof stored === 'string' ? JSON.parse(stored) : undefined } catch { value = undefined }
  if (typeof value !== 'object' || value === null) return DEFAULT_UPLOAD_POLICY
  const { maxBytes, allowedMimeTypes } = value as Record<string, unknown>
  return {
    maxBytes: typeof maxBytes === 'number' && Number.isInteger(maxBytes) && maxBytes > 0
      ? Math.min(maxBytes, MAX_UPLOAD_POLICY_BYTES)
      : DEFAULT_UPLOAD_POLICY.maxBytes,
    allowedMimeTypes: Array.isArray(allowedMimeTypes)
      ? [...new Set(allowedMimeTypes.filter((mime): mime is string => typeof mime === 'string' && Object.hasOwn(FILE_EXTENSIONS, mime)))]
      : DEFAULT_UPLOAD_POLICY.allowedMimeTypes,
  }
}
