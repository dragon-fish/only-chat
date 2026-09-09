import { Storage } from 'happy-dom'
import { beforeEach } from 'vitest'

const storage = new Storage()

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: storage,
})

beforeEach(() => storage.clear())
