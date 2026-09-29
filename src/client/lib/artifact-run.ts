import { onBeforeUnmount, ref, watch, type Ref } from 'vue'
import { api } from '@/client/lib/api'
import type { ArtifactDto, ArtifactRunDto } from '@/shared/artifacts'

/**
 * Follows one background image run from a tool card: polls until it settles, then loads its
 * outputs. `enabled` is false for an auditor, whose session cannot read the owner's runs.
 */
export function useArtifactRun(runId: Ref<number | null>, enabled: boolean) {
  const run = ref<ArtifactRunDto | null>(null)
  const outputs = ref<ArtifactDto[]>([])
  const cancelling = ref(false)
  let timer: ReturnType<typeof setTimeout> | undefined

  async function refresh(): Promise<void> {
    const id = runId.value
    if (id === null) return
    try {
      run.value = await api.artifactRun(id)
      if (run.value.status === 'queued' || run.value.status === 'running') {
        timer = setTimeout(() => void refresh(), 1500)
        return
      }
      if (run.value.status === 'completed') {
        outputs.value = (await api.artifacts({ run_id: id })).artifacts.sort((a, b) => a.output_index - b.output_index)
      }
    } catch {
      timer = setTimeout(() => void refresh(), 3000)
    }
  }

  async function cancel(): Promise<void> {
    if (runId.value === null) return
    cancelling.value = true
    try { run.value = await api.cancelArtifactRun(runId.value) }
    finally { cancelling.value = false }
  }

  watch(runId, (id) => {
    clearTimeout(timer)
    if (id !== null && enabled) void refresh()
  }, { immediate: true })
  onBeforeUnmount(() => clearTimeout(timer))

  return { run, outputs, cancelling, cancel }
}
