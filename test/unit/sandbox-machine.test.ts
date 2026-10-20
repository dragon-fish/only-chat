import { describe, expect, it, vi } from 'vitest'
import { SandboxMachine, type BackupRecordLike, type MachineDeps, type StoredBackupRef, type StoredJob } from '@/server/sandbox/machine'
import { HOME_DIR, SANDBOX_RUN, UNITS_DIR, execFiles, unitKey, type ExecFrame, type MachineOptions, type Unit } from '@/server/sandbox/protocol'
import type { TaskNotificationPart } from '@/shared/parts'

const MACHINE: MachineOptions = { instance: 'standard-1', idleMinutes: 10 }
const MISSING = Object.assign(new Error('ENOENT'), { missing: true })

type Handler = (argv: string[], options?: ContainerExecOptions) => { stdout?: string, stderr?: string, exitCode?: number, hold?: Promise<void> }

function stream(text: string, hold?: Promise<void>): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(controller) {
      if (text) controller.enqueue(new TextEncoder().encode(text))
      if (hold) await hold
      controller.close()
    },
  })
}

/** An in-memory machine: a container whose exec is scripted, a filesystem map, backups that record calls. */
function harness(options: { running?: boolean, files?: Record<string, string>, backups?: Partial<Record<string, StoredBackupRef>>, ready?: Promise<void> } = {}) {
  let running = options.running ?? false
  let now = 1_000_000
  const fs = new Map(Object.entries(options.files ?? {}))
  const storage = new Map<string, unknown>()
  const calls = { startedWith: [] as unknown[], start: 0, destroy: 0, restore: [] as string[], backup: [] as string[], settled: [] as TaskNotificationPart[], alarms: [] as number[] }
  let handler: Handler = () => ({})
  const backupFails = new Set<string>()

  const container = {
    get running() { return running },
    images: { sandbox: 'registry.example/sandbox@sha256:abc' },
    start: (startOptions: unknown) => { running = true; calls.start++; calls.startedWith.push(startOptions) },
    destroy: async () => { running = false; calls.destroy++ },
    setInactivityTimeout: async () => {},
    exec: async (argv: string[], execOptions?: ContainerExecOptions) => {
      if (!running) throw new Error('container not running')
      // The readiness probe stands for a cold start: held until the test lets the machine come up.
      if (argv[0] === 'true') await options.ready
      const result = argv[0] === 'true' ? {} : handler(argv, execOptions)
      const exitCode = (async () => { await result.hold; return result.exitCode ?? 0 })()
      return {
        stdout: stream(result.stdout ?? '', result.hold),
        stderr: stream(result.stderr ?? ''),
        stdin: null, pid: 1, isPty: false, exitCode,
        output: async () => ({ stdout: new TextEncoder().encode(result.stdout ?? '').buffer, stderr: new TextEncoder().encode(result.stderr ?? '').buffer, exitCode: await exitCode }),
        kill: () => {}, resize: () => {},
      } as unknown as ExecProcess
    },
  } as unknown as Container

  const deps: MachineDeps = {
    container,
    files: {
      readFile: async (path) => {
        if (!fs.has(path)) throw MISSING
        return new Response(fs.get(path))
      },
      writeFile: async (path, content) => { fs.set(path, typeof content === 'string' ? content : new TextDecoder().decode(content)) },
      stat: async (path) => {
        if (fs.has(path)) return { type: 'file', size: BigInt(fs.get(path)!.length) }
        if ([...fs.keys()].some(key => key.startsWith(`${path}/`))) return { type: 'directory', size: 0n }
        throw MISSING
      },
      mkdir: async () => {},
      remove: async (path) => { for (const key of [...fs.keys()]) if (key === path || key.startsWith(`${path}/`)) fs.delete(key) },
      readDirectory: async (path) => {
        const names = [...fs.keys()].filter(key => key.startsWith(`${path}/`)).map(key => key.slice(path.length + 1).split('/')[0]!)
        if (names.length === 0) throw MISSING
        return [...new Set(names)].map(name => ({ name, type: 'file' }))
      },
    },
    backups: {
      backup: async ({ dir }) => {
        calls.backup.push(dir)
        if (backupFails.has(dir)) throw new Error('upload failed')
        return { id: `b-${calls.backup.length}`, dir, size: 1, sha256: 'x', format: 'tar+zstd/1' } satisfies BackupRecordLike
      },
      restore: async (record, { dir }) => {
        calls.restore.push(dir)
        if (record.id === 'broken') throw new Error('BACKUP_INTEGRITY')
      },
    },
    records: {
      latest: async (unit: Unit) => options.backups?.[unitKey(unit)] ?? null,
      record: async () => {},
      rotate: async () => {},
    },
    storage: {
      get: async <T>(key: string) => storage.get(key) as T | undefined,
      put: async (key, value) => { storage.set(key, value) },
      delete: async key => storage.delete(key),
      list: async <T>({ prefix }: { prefix: string }) => new Map([...storage].filter(([key]) => key.startsWith(prefix))) as Map<string, T>,
    },
    setAlarm: async (at) => { calls.alarms.push(at) },
    settle: async (_job: StoredJob, notification) => { calls.settled.push(notification) },
    isMissing: error => error === MISSING,
    now: () => now,
  }
  const harnessed = {
    machine: new SandboxMachine(deps), fs, storage, calls, backupFails,
    /** A new object over the same storage and container, as after the runtime evicts the DO. */
    evict: () => { harnessed.machine = new SandboxMachine(deps) },
    setHandler: (next: Handler) => { handler = next },
    advance: (ms: number) => { now += ms },
    stop: () => { running = false },
  }
  return harnessed
}

async function frames(body: ReadableStream<Uint8Array>): Promise<ExecFrame[]> {
  const text = await new Response(body).text()
  return text.trim().split('\n').map(line => JSON.parse(line) as ExecFrame)
}

const exec = (cwd: string, execId = 'call-1', timeoutMs = 60_000) => ({ userId: 1, machine: MACHINE, execId, argv: ['bash', '-lc', 'echo hi'], cwd, timeoutMs })

describe('SandboxMachine restore', () => {
  it('restores a unit from its latest backup once and says so', async () => {
    const h = harness({ backups: { 'project-3': { backupId: 'p3', sha256: 'x', size: 1, createdAt: 0 } } })
    h.setHandler(() => ({ stdout: 'hi\n' }))
    const first = await frames(await h.machine.exec(exec('/workspace/projects/3')))
    expect(h.calls.restore).toEqual(['/workspace/projects/3'])
    expect(first[0]).toMatchObject({ type: 'notes' })
    expect(h.fs.has(`${UNITS_DIR}/project-3`)).toBe(true)
    expect(h.calls.startedWith).toMatchObject([{ image: 'registry.example/sandbox@sha256:abc', instance: 'standard-1', enableInternet: true }])

    const second = await frames(await h.machine.exec(exec('/workspace/projects/3', 'call-2')))
    expect(h.calls.restore).toEqual(['/workspace/projects/3'])
    expect(second.some(frame => frame.type === 'notes')).toBe(false)
  })

  it('trusts the marker in a running container after a reset instead of restoring over newer work', async () => {
    const h = harness({ running: true, files: { [`${UNITS_DIR}/project-3`]: 'p3', [`${UNITS_DIR}/user`]: '' }, backups: { 'project-3': { backupId: 'p3', sha256: 'x', size: 1, createdAt: 0 } } })
    await frames(await h.machine.exec(exec('/workspace/projects/3')))
    expect(h.calls.restore).toEqual([])
    expect(h.calls.start).toBe(0)
  })

  it('fails the call rather than hand over an empty directory when a restore fails', async () => {
    const h = harness({ backups: { 'conversation-9': { backupId: 'broken', sha256: 'x', size: 1, createdAt: 0 } } })
    await expect(h.machine.exec(exec('/workspace/conversations/9'))).rejects.toThrow('BACKUP_INTEGRITY')
    expect(h.fs.has(`${UNITS_DIR}/conversation-9`)).toBe(false)
  })

  it('always brings the home unit along', async () => {
    const h = harness({ backups: { user: { backupId: 'u', sha256: 'x', size: 1, createdAt: 0 } } })
    await frames(await h.machine.exec(exec('/tmp')))
    expect(h.calls.restore).toEqual([HOME_DIR])
  })
})

describe('SandboxMachine exec', () => {
  it('streams output and reports a timeout from exit code 124', async () => {
    const h = harness()
    h.setHandler(() => ({ stdout: 'partial', stderr: 'oops', exitCode: 124 }))
    const result = await frames(await h.machine.exec(exec('/workspace/conversations/1')))
    expect(result).toContainEqual({ type: 'out', stream: 'stdout', data: 'partial' })
    expect(result).toContainEqual({ type: 'out', stream: 'stderr', data: 'oops' })
    expect(result.at(-1)).toMatchObject({ type: 'end', exitCode: 124, timedOut: true })
  })

  it('passes stdin through the helper untouched', async () => {
    const h = harness()
    let seen = ''
    h.setHandler((argv, options) => {
      expect(argv.slice(0, 1)).toEqual(['/opt/sandbox/bin/sandbox-run'])
      expect(argv.slice(argv.indexOf('--') + 1)).toEqual(['tee', 'a b.txt'])
      void new Response(options?.stdin as ReadableStream).text().then(text => { seen = text })
      return {}
    })
    await frames(await h.machine.exec({ ...exec('/workspace/conversations/1'), argv: ['tee', 'a b.txt'], stdin: 'x = "$HOME"\n' }))
    expect(seen).toBe('x = "$HOME"\n')
  })
})

describe('SandboxMachine kill', () => {
  it('never launches a command whose kill arrived while the machine was still starting', async () => {
    let up!: () => void
    const h = harness({ ready: new Promise<void>(resolve => { up = resolve }) })
    const launched: string[][] = []
    h.setHandler((argv) => {
      launched.push(argv)
      return {}
    })
    const call = h.machine.exec(exec('/workspace/conversations/1'))
    await h.machine.kill('call-1')
    up()
    await expect(call).rejects.toThrow(/cancel/i)
    expect(launched.filter(argv => argv[0] === SANDBOX_RUN)).toEqual([])
  })
})

describe('SandboxMachine cwd', () => {
  it('says where the shell ended when it left its start, and whether that place is saved', async () => {
    const h = harness()
    h.setHandler(() => {
      h.fs.set(execFiles('call-1').cwd, '/workspace/projects/9\n')
      return {}
    })
    const result = await frames(await h.machine.exec(exec('/workspace/conversations/1')))
    expect(result.at(-1)).toMatchObject({ type: 'end', finalCwd: '/workspace/projects/9', finalCwdUnsaved: true })

    h.setHandler(() => {
      h.fs.set(execFiles('call-2').cwd, '/workspace/conversations/1\n')
      return {}
    })
    const stayed = await frames(await h.machine.exec(exec('/workspace/conversations/1', 'call-2')))
    expect(stayed.at(-1)).not.toHaveProperty('finalCwd')
  })
})

describe('SandboxMachine alarm', () => {
  it('backs up dirty units and stops once idle', async () => {
    const h = harness()
    await frames(await h.machine.exec(exec('/workspace/projects/3')))
    h.advance(11 * 60_000)
    await h.machine.alarm()
    expect(h.calls.backup.sort()).toEqual([HOME_DIR, '/workspace/projects/3'].sort())
    expect(h.calls.destroy).toBe(1)
  })

  it('still stops once idle when the object is evicted between alarms', async () => {
    const h = harness()
    await frames(await h.machine.exec(exec('/workspace/projects/3')))
    for (let minute = 0; minute < 11; minute++) {
      h.evict()
      h.advance(60_000)
      await h.machine.alarm()
    }
    expect(h.calls.backup.sort()).toEqual([HOME_DIR, '/workspace/projects/3'].sort())
    expect(h.calls.destroy).toBe(1)
  })

  it('keeps running when a backup fails', async () => {
    const h = harness()
    await frames(await h.machine.exec(exec('/workspace/projects/3')))
    h.backupFails.add('/workspace/projects/3')
    h.advance(11 * 60_000)
    await h.machine.alarm()
    expect(h.calls.destroy).toBe(0)
    expect(h.calls.alarms.length).toBeGreaterThan(1)
  })

  it('skips a checkpoint while a foreground command is running, and never stops then', async () => {
    const h = harness()
    let release!: () => void
    const hold = new Promise<void>(resolve => { release = resolve })
    h.setHandler(() => ({ stdout: 'working', hold }))
    const body = await h.machine.exec(exec('/workspace/projects/3'))
    const done = frames(body)
    h.advance(20 * 60_000)
    await h.machine.alarm()
    expect(h.calls.backup).toEqual([])
    expect(h.calls.destroy).toBe(0)
    release()
    await done
  })

  it('does not stop while a background job runs, and settles it once when it exits', async () => {
    const h = harness()
    h.setHandler(argv => (argv[0] === '/opt/sandbox/bin/job-run' ? { stdout: '4321\n' } : { stdout: 'last lines' }))
    const started = await h.machine.startJob({
      userId: 1, machine: MACHINE, argv: ['bash', '-lc', 'make'], cwd: '/workspace/projects/3',
      conversationId: 5, originMessageId: 6, toolCallId: 'call-9', pluginId: 'sandbox', summary: 'make',
    })
    expect(started).toMatchObject({ taskId: 'sandbox_job:1', pid: 4321 })

    h.advance(30 * 60_000)
    await h.machine.alarm()
    expect(h.calls.destroy).toBe(0)
    expect(h.calls.settled).toEqual([])

    h.fs.set('/workspace/.jobs/1/exit', '2\n')
    await h.machine.alarm()
    await h.machine.alarm()
    expect(h.calls.settled).toHaveLength(1)
    expect(h.calls.settled[0]).toMatchObject({ task_id: 'sandbox_job:1', status: 'failed', tool_call_id: 'call-9', plugin_id: 'sandbox' })
  })

  it('reports a job as failed when its container is gone', async () => {
    const h = harness()
    h.setHandler(() => ({ stdout: '7\n' }))
    await h.machine.startJob({
      userId: 1, machine: MACHINE, argv: ['sleep', '999'], cwd: '/workspace/home',
      conversationId: 5, originMessageId: 6, toolCallId: 'call-1', pluginId: 'sandbox', summary: 'sleep',
    })
    h.stop()
    await h.machine.alarm()
    expect(h.calls.settled).toMatchObject([{ task_id: 'sandbox_job:1', status: 'failed' }])
    expect([...h.storage.keys()].some(key => key.startsWith('job:'))).toBe(false)
  })
})

vi.setConfig({ testTimeout: 10_000 })
