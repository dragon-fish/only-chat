import { computed, toValue, type MaybeRefOrGetter } from 'vue'
import { useTitle } from '@vueuse/core'

export function usePageTitle(title: MaybeRefOrGetter<string> = ''): void {
  useTitle(computed(() => toValue(title)), {
    titleTemplate: value => value ? `${value} | Only Chat` : 'Only Chat',
  })
}
