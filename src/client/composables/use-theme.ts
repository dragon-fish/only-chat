import { computed, ref } from 'vue'
import {
  applyTheme,
  parseThemePreference,
  resolveTheme,
  THEME_STORAGE_KEY,
  type ThemePreference,
} from '@/client/lib/theme'

const media = window.matchMedia('(prefers-color-scheme: dark)')
const preference = ref<ThemePreference>(parseThemePreference(localStorage.getItem(THEME_STORAGE_KEY)))
const systemDark = ref(media.matches)

let stopTheme = () => {}
let stopSystemTracking = () => {}

function activateTheme(value: ThemePreference): void {
  stopTheme()
  stopSystemTracking()

  stopTheme = applyTheme(value)
  systemDark.value = media.matches

  if (value === 'system') {
    const syncSystemTheme = (event: MediaQueryListEvent) => {
      systemDark.value = event.matches
    }
    media.addEventListener('change', syncSystemTheme)
    stopSystemTracking = () => media.removeEventListener('change', syncSystemTheme)
  }
}

activateTheme(preference.value)

export function useTheme() {
  const resolved = computed(() => resolveTheme(preference.value, systemDark.value))

  function setPreference(value: ThemePreference): void {
    preference.value = value
    localStorage.setItem(THEME_STORAGE_KEY, value)
    activateTheme(value)
  }

  return { preference, resolved, setPreference }
}
