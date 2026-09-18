import { computed, toValue, type MaybeRefOrGetter } from 'vue'
import { useTitle } from '@vueuse/core'

const PROJECT_NAME = 'Only Chat'
const DEV = import.meta.env.DEV

/**
 * What every tab title ends in. Exported so callers and tests compose against it instead of
 * repeating the brand: under Vitest `import.meta.env.DEV` is true, so a hard-coded 'Only Chat'
 * expectation fails against the dev marker even though nothing is wrong.
 */
export const APP_TITLE = DEV ? `[DEV] ${PROJECT_NAME}` : PROJECT_NAME

export function usePageTitle(title: MaybeRefOrGetter<string> = ''): void {
  useTitle(
    computed(() => toValue(title)),
    {
      titleTemplate: (value) =>
        value ? `${value} | ${APP_TITLE}` : APP_TITLE,
    }
  )
}
