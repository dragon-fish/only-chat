import { computed, ref } from 'vue'

/** The baseline follows acknowledged saves, never concurrent store refreshes. */
export function useFormChanges(read: () => unknown) {
  const capture = () => JSON.stringify(read())
  const baseline = ref(capture())
  const dirty = computed(() => capture() !== baseline.value)
  function markSaved(snapshot = capture()) { baseline.value = snapshot }
  return { dirty, capture, markSaved }
}
