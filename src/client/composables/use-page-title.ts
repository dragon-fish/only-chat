import { computed, toValue, type MaybeRefOrGetter } from 'vue'
import { useTitle } from '@vueuse/core'

const PROJECT_NAME = 'Only Chat'
const DEV = import.meta.env.DEV
const DISPLAY_NAME = DEV ? `[DEV] ${PROJECT_NAME}` : PROJECT_NAME

export function usePageTitle(title: MaybeRefOrGetter<string> = ''): void {
  useTitle(
    computed(() => toValue(title)),
    {
      titleTemplate: (value) =>
        value ? `${value} | ${DISPLAY_NAME}` : DISPLAY_NAME,
    }
  )
}
