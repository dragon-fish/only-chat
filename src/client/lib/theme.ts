export const THEME_STORAGE_KEY = 'oc.theme'

export type ThemePreference = 'system' | 'light' | 'dark'

export function parseThemePreference(raw: string | null): ThemePreference {
  return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : 'system'
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean): 'light' | 'dark' {
  return preference === 'system' ? (systemDark ? 'dark' : 'light') : preference
}

export function applyResolvedTheme(theme: 'light' | 'dark'): void {
  document.documentElement.classList.toggle('dark', theme === 'dark')
  document.documentElement.style.colorScheme = theme
}

export function applyTheme(preference: ThemePreference): () => void {
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  const sync = () => applyResolvedTheme(resolveTheme(preference, media.matches))

  sync()
  if (preference === 'system') media.addEventListener('change', sync)

  return () => media.removeEventListener('change', sync)
}
