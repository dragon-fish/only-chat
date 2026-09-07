import { inject, provide, ref, watch, type InjectionKey, type Ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { isChatHistoryRoute } from '@/client/lib/settings'

const key: InjectionKey<Ref<string>> = Symbol('settings-return')

export function provideSettingsReturn() {
  const route = useRoute()
  const previous = useRouter().options.history.state.back
  const target = ref(isChatHistoryRoute(previous) ? previous as string : '/chats')
  watch(() => route.fullPath, (to, from) => {
    if (to.startsWith('/settings') && isChatHistoryRoute(from)) target.value = from
  })
  provide(key, target)
}

export function useSettingsReturn() {
  return inject(key, ref('/chats'))
}
