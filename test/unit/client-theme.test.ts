import { describe, expect, it } from 'vitest'
import { parseThemePreference, resolveTheme } from '@/client/lib/theme'

describe('theme preference', () => {
  it('accepts only the three persisted values', () => {
    expect(parseThemePreference('light')).toBe('light')
    expect(parseThemePreference('dark')).toBe('dark')
    expect(parseThemePreference('system')).toBe('system')
    expect(parseThemePreference('sepia')).toBe('system')
    expect(parseThemePreference(null)).toBe('system')
  })

  it('resolves system without changing explicit choices', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
  })
})
