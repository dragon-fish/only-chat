import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('deployment resource guard', () => {
  it('disables automatic provisioning and creation in the deployment command', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
    const deploy = pkg.scripts.deploy.split('&&').find((command: string) => /\bwrangler deploy\b/u.test(command))
    expect(deploy).toBeDefined()
    expect(deploy.trim().split(/\s+/u)).toEqual(expect.arrayContaining([
      '--experimental-provision=false', '--experimental-auto-create=false',
    ]))
  })
})
