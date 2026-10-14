import { describe, expect, it } from 'vitest'
import { argvToCommandLine } from '@/plugins/sandbox/client/command-line'

describe('argvToCommandLine', () => {
  it('leaves plain arguments bare', () => {
    expect(argvToCommandLine(['ls', '-la', '/tmp/a.txt'])).toBe('ls -la /tmp/a.txt')
  })

  it('quotes spaces, shell metacharacters and embedded single quotes', () => {
    expect(argvToCommandLine(['echo', 'a b', '$HOME', "it's"])).toBe("echo 'a b' '$HOME' 'it'\\''s'")
  })

  it('keeps an empty argument visible', () => {
    expect(argvToCommandLine(['printf', ''])).toBe("printf ''")
  })
})
