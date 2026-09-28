import { useSiteConfigStore } from '@/client/stores/site-config'
import { uploadProblem, type UploadPolicy } from '@/shared/upload-policy'

/**
 * The chat upload policy from the cached site config. Never force a reload here: the server
 * re-validates every upload against the current policy anyway.
 */
export async function currentUploadPolicy(): Promise<UploadPolicy> {
  return (await useSiteConfigStore().load()).uploads
}
export function validateUpload(policy: UploadPolicy, mime: string, size: number): void {
  const problem = uploadProblem(policy, mime, size)
  if (problem) throw new Error(problem.message)
}
