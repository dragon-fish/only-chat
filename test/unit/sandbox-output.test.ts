import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LineBuffer, OutputWindow } from '@/plugins/sandbox/server/output'
import { wrapCommand } from '@/plugins/sandbox/server/command'

describe('OutputWindow', () => {
  it('keeps everything that fits', () => {
    const window = new OutputWindow(4, 8)
    window.push('abc')
    window.push('defgh')
    expect(window.truncated).toBe(false)
    expect(window.text()).toBe('abcdefgh')
  })

  it('keeps the head and the latest tail and counts what fell between', () => {
    const window = new OutputWindow(4, 4)
    for (const chunk of ['1234', '5678', '9abc', 'defg']) window.push(chunk)
    expect(window.truncated).toBe(true)
    const text = window.text()
    expect(text.startsWith('1234\n')).toBe(true)
    expect(text.endsWith('\ndefg')).toBe(true)
    expect(text).toContain('8 bytes omitted')
  })

  it('never splits a multi-byte character', () => {
    const window = new OutputWindow(4, 4)
    window.push('汉字汉字汉字')
    const text = window.text()
    expect(text.startsWith('汉\n')).toBe(true)
    expect(text.endsWith('\n字')).toBe(true)
  })
})

describe('LineBuffer', () => {
  it('holds a partial line until it completes or is flushed', () => {
    const buffer = new LineBuffer()
    expect(buffer.push('a\nb')).toEqual(['a'])
    expect(buffer.push('c\n')).toEqual(['bc'])
    expect(buffer.push('tail')).toEqual([])
    expect(buffer.flush()).toEqual(['tail'])
  })
})

describe('wrapCommand', () => {
  it('requires exactly one of command and argv', () => {
    expect(wrapCommand({})).toBeNull()
    expect(wrapCommand({ command: 'ls', argv: ['ls'] })).toBeNull()
  })

  it.skipIf(process.platform === 'win32')('passes argv through bash untouched', () => {
    const args = ['a b', '$HOME', '"quoted"', "it's", '*', '']
    const argv = wrapCommand({ argv: ['printf', '[%s]\\n', ...args] })!
    const out = execFileSync(argv[0]!, argv.slice(1), { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: '/nowhere' } as unknown as NodeJS.ProcessEnv })
    expect(out).toBe(args.map(arg => `[${arg}]\n`).join(''))
  })

  it.skipIf(process.platform === 'win32')('records where a command string ended without changing what it sees or returns', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sandbox-cwd-')))
    const cwdFile = join(dir, 'cwd')
    const argv = wrapCommand({ command: `cd ${dir} && echo "[$1][$#]" && false` }, cwdFile)!
    const result = spawnSync(argv[0]!, argv.slice(1), { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: '/nowhere' } as unknown as NodeJS.ProcessEnv })
    expect(result.stdout).toBe('[][0]\n')
    expect(result.status).toBe(1)
    expect(readFileSync(cwdFile, 'utf8').trim()).toBe(dir)
  })
})
