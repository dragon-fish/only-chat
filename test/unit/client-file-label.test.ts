import { expect, it } from 'vitest'
import { fileLabel } from '@/client/components/workspace-files'

it('names a file for a person, never by the reference the model uses', () => {
  expect(fileLabel('asset:3f9a2c1e', 'cars.csv')).toBe('cars.csv')
  expect(fileLabel('/project/refs/cat.png')).toBe('cat.png')
  expect(fileLabel('vfs:/conversation/notes.md')).toBe('notes.md')
  // Nothing named it: a pasted or generated file is called by what it is.
  expect(fileLabel('asset:5c2e8f10', null, 'image/png')).toBe('图片')
  expect(fileLabel('asset:b41d07a9')).toBe('文件')
  expect(fileLabel(undefined)).toBe('文件')
})
