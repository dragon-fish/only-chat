import { useSiteConfigStore } from '@/client/stores/site-config'
import { uploadProblem, type UploadPolicy } from '@/shared/upload-policy'

export async function currentUploadPolicy(): Promise<UploadPolicy> {
  return (await useSiteConfigStore().load(true)).uploads
}
export function validateUpload(policy: UploadPolicy, mime: string, size: number): void {
  const problem = uploadProblem(policy, mime, size)
  if (problem) throw new Error(problem.message)
}
