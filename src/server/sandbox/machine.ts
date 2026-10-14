import type { TaskNotificationPart } from '@/shared/parts'
import {
  ALARM_INTERVAL_MS, BACKUP_EXCLUDE, CHECKPOINT_INTERVAL_MS, EXEC_LOG_DIR, JOB_RUN, JOBS_DIR, PLATFORM_INACTIVITY_MS,
  SANDBOX_IMAGE, SANDBOX_RUN, UNITS_DIR, USER_UNIT, jobTaskId, unitDir, unitKey, unitOfPath,
  type ExecFrame, type ExecRequest, type JobRequest, type JobStarted, type MachineOptions, type ReadRequest,
  type ReadResult, type StatResult, type Unit, type WriteRequest,
} from './protocol'

/**
 * The image's own ENV, passed again on every exec: an exec does not inherit the image environment
 * on every runtime, and a missing PATH entry shows up as "command not found" far from its cause.
 */
export const SANDBOX_ENV: Record<string, string> = {
  HOME: '/workspace/home',
  PATH: '/opt/venv/bin:/workspace/home/.local/bin:/workspace/home/.bun/bin:/opt/sandbox/bin:/usr/local/bin:/usr/bin:/bin',
  VIRTUAL_ENV: '/opt/venv',
  UV_PYTHON_INSTALL_DIR: '/opt/uv/python',
  UV_LINK_MODE: 'copy',
  // Package caches stay out of HOME, which is backed up whole.
  UV_CACHE_DIR: '/tmp/uv-cache',
  npm_config_cache: '/tmp/npm-cache',
  pnpm_config_store_dir: '/tmp/pnpm-store',
  BUN_INSTALL_CACHE_DIR: '/tmp/bun-cache',
  UV_TOOL_DIR: '/workspace/home/.local/share/uv/tools',
  UV_TOOL_BIN_DIR: '/workspace/home/.local/bin',
  NPM_CONFIG_PREFIX: '/workspace/home/.local',
  PNPM_HOME: '/workspace/home/.local/bin',
  BUN_INSTALL: '/workspace/home/.bun',
  MPLBACKEND: 'Agg',
  LANG: 'C.UTF-8',
}

/** How much of a finished job's log the notification quotes. */
const JOB_TAIL_BYTES = 4 * 1024
const READY_TIMEOUT_MS = 30_000

export interface StoredBackupRef {
  backupId: string
  sha256: string
  size: number
  createdAt: number
}

export interface BackupRecordLike {
  id: string
  dir: string
  size: number
  sha256: string
  format: 'tar+zstd/1'
}

/** Everything the machine touches, injected so the logic runs against fakes in Node. */
export interface MachineDeps {
  container: Container | undefined
  files: {
    readFile(path: string): Promise<Response>
    writeFile(path: string, content: Uint8Array | string): Promise<void>
    stat(path: string): Promise<{ type: string, size: bigint }>
    mkdir(path: string, options: { recursive: true }): Promise<void>
    remove(path: string, options: { recursive: true, force: true }): Promise<void>
    readDirectory(path: string): Promise<Array<{ name: string, type: string }>>
  }
  backups: {
    backup(options: { dir: string, exclude: readonly string[], gitignore: boolean }): Promise<BackupRecordLike>
    restore(record: BackupRecordLike, options: { dir: string }): Promise<void>
  }
  records: {
    latest(unit: Unit): Promise<StoredBackupRef | null>
    record(unit: Unit, record: BackupRecordLike): Promise<void>
    rotate(unit: Unit): Promise<void>
  }
  storage: {
    get<T>(key: string): Promise<T | undefined>
    put(key: string, value: unknown): Promise<void>
    delete(key: string): Promise<boolean>
    list<T>(options: { prefix: string }): Promise<Map<string, T>>
  }
  setAlarm(at: number): Promise<void>
  settle(job: StoredJob, notification: TaskNotificationPart): Promise<void>
  /** Whether a filesystem error is "no such file". */
  isMissing(error: unknown): boolean
  now(): number
}

export interface StoredJob {
  id: number
  pluginId: string
  conversationId: number
  originMessageId: number
  toolCallId: string
  summary: string
  startedAt: number
  dir: string
}

const JOB_PREFIX = 'job:'
const JOB_SEQ_KEY = 'job_seq'
const IDLE_MINUTES_KEY = 'idle_minutes'

function keyToUnit(key: string): Unit | null {
  if (key === 'user') return USER_UNIT
  const match = /^(project|conversation)-(\d+)$/.exec(key)
  return match ? { kind: match[1] as 'project' | 'conversation', id: Number(match[2]) } : null
}

/** A file name for an id the model can influence (tool call ids are provider-chosen). */
function safeName(id: string): string {
  return id.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120) || 'exec'
}

function bytesOf(text: string | undefined): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text ?? '')
  return new ReadableStream({
    start(controller) {
      if (bytes.byteLength > 0) controller.enqueue(bytes)
      controller.close()
    },
  })
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * One user's machine: starting it, restoring units on demand, running commands, and backing up and
 * stopping it from the alarm (spec §5). Restore state lives in marker files inside the container,
 * never only here: a deploy resets this object without replacing a running container, and
 * trusting memory then would restore an old backup over newer work.
 */
export class SandboxMachine {
  /** Units confirmed restored in the current container; a cache of the marker files. */
  private readonly known = new Set<string>()
  private readonly dirty = new Set<string>()
  private readonly restoring = new Map<string, Promise<string | null>>()
  private readonly running = new Map<string, string>()
  private inflight = 0
  private lastActivity: number
  private lastBackupAt: number
  private backingUp: Promise<void> | null = null
  private adopted = false

  constructor(private readonly deps: MachineDeps) {
    this.lastActivity = deps.now()
    this.lastBackupAt = deps.now()
  }

  private get container(): Container {
    const container = this.deps.container
    if (!container) throw new Error('Containers are disabled here: local dev runs them only with SANDBOX_DEV=1 and Docker.')
    return container
  }

  private touch(): void {
    this.lastActivity = this.deps.now()
  }

  /**
   * A container still running after this object was reset: everything restored in it may hold
   * work newer than its backup, so all of it counts as dirty until backed up again.
   */
  private async adopt(): Promise<void> {
    if (this.adopted) return
    this.adopted = true
    if (!this.deps.container?.running) return
    let markers: Array<{ name: string }> = []
    try {
      markers = await this.deps.files.readDirectory(UNITS_DIR)
    } catch (error) {
      if (!this.deps.isMissing(error)) throw error
    }
    for (const marker of markers) {
      this.known.add(marker.name)
      this.dirty.add(marker.name)
    }
    await this.deps.setAlarm(this.deps.now() + ALARM_INTERVAL_MS)
  }

  async ensureRunning(machine: MachineOptions): Promise<void> {
    await this.adopt()
    await this.deps.storage.put(IDLE_MINUTES_KEY, machine.idleMinutes)
    const container = this.container
    if (container.running) return
    this.known.clear()
    this.dirty.clear()
    // The config's image name is not a reference: `start` needs the one the runtime maps it to, and
    // given the bare name the local backend starts nothing and says nothing.
    const image = container.images[SANDBOX_IMAGE]
    if (!image) throw new Error(`No container image named "${SANDBOX_IMAGE}" is configured for the Sandbox class.`)
    container.start({ image, instance: machine.instance, enableInternet: true, env: SANDBOX_ENV })
    await this.waitReady(container)
    await container.setInactivityTimeout(PLATFORM_INACTIVITY_MS)
    this.lastBackupAt = this.deps.now()
    this.touch()
    await this.deps.setAlarm(this.deps.now() + ALARM_INTERVAL_MS)
  }

  private async waitReady(container: Container): Promise<void> {
    const deadline = this.deps.now() + READY_TIMEOUT_MS
    for (let delay = 100; ; delay = Math.min(delay * 2, 2_000)) {
      try {
        const probe = await container.exec(['true'])
        await probe.exitCode
        return
      } catch (error) {
        if (this.deps.now() >= deadline) throw new Error(`The sandbox did not start: ${message(error)}`)
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }
  }

  /** Restores (or creates) the units the given paths live in, plus the home unit. Returns notes. */
  async ensureUnits(paths: readonly string[]): Promise<string[]> {
    const units = new Map<string, Unit>([[unitKey(USER_UNIT), USER_UNIT]])
    for (const path of paths) {
      const unit = unitOfPath(path)
      if (unit) units.set(unitKey(unit), unit)
    }
    const notes = await Promise.all([...units.values()].map(unit => this.ensureUnit(unit)))
    return notes.filter((note): note is string => note !== null)
  }

  private ensureUnit(unit: Unit): Promise<string | null> {
    const key = unitKey(unit)
    if (this.known.has(key)) return Promise.resolve(null)
    const pending = this.restoring.get(key)
    if (pending) return pending
    const work = this.restoreUnit(unit, key).finally(() => this.restoring.delete(key))
    this.restoring.set(key, work)
    return work
  }

  private async restoreUnit(unit: Unit, key: string): Promise<string | null> {
    const { files } = this.deps
    const marker = `${UNITS_DIR}/${key}`
    try {
      await files.stat(marker)
      this.known.add(key)
      return null
    } catch (error) {
      if (!this.deps.isMissing(error)) throw error
    }
    const dir = unitDir(unit)
    const latest = await this.deps.records.latest(unit)
    let note: string | null = null
    if (latest) {
      await files.mkdir(dir.slice(0, dir.lastIndexOf('/')), { recursive: true })
      // Failing here fails the call: an empty directory in place of a backup would look like lost work.
      await this.deps.backups.restore(
        { id: latest.backupId, dir, size: latest.size, sha256: latest.sha256, format: 'tar+zstd/1' },
        { dir },
      )
      note = `${dir} was restored from its backup of ${new Date(latest.createdAt).toISOString()}. `
        + `Ignored paths (${BACKUP_EXCLUDE.join(', ')} and anything .gitignore excludes) were not kept: reinstall dependencies if you need them.`
    } else {
      await files.mkdir(dir, { recursive: true })
    }
    await files.mkdir(UNITS_DIR, { recursive: true })
    await files.writeFile(marker, latest?.backupId ?? '')
    this.known.add(key)
    return note
  }

  private markDirty(): void {
    for (const key of this.known) this.dirty.add(key)
  }

  /** Runs one foreground command and streams NDJSON frames; the work counts as in flight until the stream ends. */
  async exec(request: ExecRequest): Promise<ReadableStream<Uint8Array>> {
    await this.ensureRunning(request.machine)
    if (this.backingUp) await this.backingUp
    this.inflight++
    this.touch()
    const started = this.deps.now()
    const name = safeName(request.execId)
    const logPath = `${EXEC_LOG_DIR}/${name}.log`
    const pidPath = `${EXEC_LOG_DIR}/${name}.pid`
    let process: ExecProcess
    let notes: string[]
    try {
      notes = await this.ensureUnits([request.cwd])
      const seconds = Math.max(1, Math.ceil(request.timeoutMs / 1000))
      process = await this.container.exec([SANDBOX_RUN, logPath, pidPath, String(seconds), '--', ...request.argv], {
        cwd: request.cwd, env: SANDBOX_ENV, stdin: bytesOf(request.stdin), stdout: 'pipe', stderr: 'pipe',
      })
    } catch (error) {
      this.inflight--
      this.touch()
      throw error
    }
    this.markDirty()
    this.running.set(request.execId, pidPath)

    const encoder = new TextEncoder()
    const finish = () => {
      this.inflight--
      this.running.delete(request.execId)
      this.markDirty()
      this.touch()
    }
    return new ReadableStream<Uint8Array>({
      start: async (controller) => {
        const send = (frame: ExecFrame) => controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`))
        try {
          if (notes.length > 0) send({ type: 'notes', notes })
          const pump = async (stream: ReadableStream | null, which: 'stdout' | 'stderr') => {
            if (!stream) return
            const decoder = new TextDecoder()
            for await (const chunk of stream as ReadableStream<Uint8Array>) {
              const data = decoder.decode(chunk, { stream: true })
              if (data) send({ type: 'out', stream: which, data })
            }
            const rest = decoder.decode()
            if (rest) send({ type: 'out', stream: which, data: rest })
          }
          await Promise.all([pump(process.stdout, 'stdout'), pump(process.stderr, 'stderr')])
          const exitCode = await process.exitCode
          const durationMs = this.deps.now() - started
          const timedOut = exitCode === 124 || (exitCode === 137 && durationMs >= request.timeoutMs)
          send({ type: 'end', exitCode, timedOut, durationMs, logPath })
        } catch (error) {
          send({ type: 'error', message: message(error) })
        } finally {
          finish()
          controller.close()
        }
      },
    })
  }

  /** Stops a foreground command's whole process group: `AbortSignal` cannot cross RPC. */
  async kill(execId: string): Promise<void> {
    const pidPath = this.running.get(execId)
    if (!pidPath || !this.deps.container?.running) return
    const script = 'p=$(cat "$1" 2>/dev/null) || exit 0; kill -TERM -- "-$p" 2>/dev/null; sleep 5; kill -KILL -- "-$p" 2>/dev/null; exit 0'
    const process = await this.container.exec(['bash', '-c', script, 'kill', pidPath], { env: SANDBOX_ENV })
    void process.exitCode.catch(() => {})
  }

  async startJob(request: JobRequest): Promise<JobStarted> {
    await this.ensureRunning(request.machine)
    if (this.backingUp) await this.backingUp
    this.touch()
    const notes = await this.ensureUnits([request.cwd])
    const id = ((await this.deps.storage.get<number>(JOB_SEQ_KEY)) ?? 0) + 1
    await this.deps.storage.put(JOB_SEQ_KEY, id)
    const dir = `${JOBS_DIR}/${id}`
    const process = await this.container.exec([JOB_RUN, dir, '--', ...request.argv], {
      cwd: request.cwd, env: SANDBOX_ENV, stdout: 'pipe', stderr: 'pipe',
    })
    const output = await process.output()
    const exitCode = await process.exitCode
    const pid = Number(new TextDecoder().decode(output.stdout).trim())
    if (exitCode !== 0 || !Number.isSafeInteger(pid)) {
      throw new Error(`Could not start the job: ${new TextDecoder().decode(output.stderr).trim() || `exit ${exitCode}`}`)
    }
    const job: StoredJob = {
      id, pluginId: request.pluginId, conversationId: request.conversationId, originMessageId: request.originMessageId,
      toolCallId: request.toolCallId, summary: request.summary, startedAt: this.deps.now(), dir,
    }
    await this.deps.storage.put(`${JOB_PREFIX}${id}`, job)
    this.markDirty()
    return { taskId: jobTaskId(id), pid, logPath: `${dir}/log`, notes }
  }

  async stat(machine: MachineOptions, path: string): Promise<StatResult | null> {
    await this.ensureRunning(machine)
    await this.ensureUnits([path])
    this.touch()
    try {
      const stat = await this.deps.files.stat(path)
      return { kind: stat.type === 'file' ? 'file' : stat.type === 'directory' ? 'directory' : 'other', size: Number(stat.size) }
    } catch (error) {
      if (this.deps.isMissing(error)) return null
      throw error
    }
  }

  async readFile(request: ReadRequest): Promise<ReadResult> {
    const stat = await this.stat(request.machine, request.path)
    if (!stat) return { ok: false, code: 'NOT_FOUND' }
    if (stat.kind !== 'file') return { ok: false, code: 'NOT_A_FILE' }
    if (stat.size > request.maxBytes) return { ok: false, code: 'TOO_LARGE', size: stat.size }
    const response = await this.deps.files.readFile(request.path)
    const bytes = new Uint8Array(await response.arrayBuffer())
    this.touch()
    return { ok: true, bytes, size: bytes.byteLength }
  }

  async writeFile(request: WriteRequest): Promise<void> {
    await this.ensureRunning(request.machine)
    if (this.backingUp) await this.backingUp
    await this.ensureUnits([request.path])
    await this.deps.files.mkdir(request.path.slice(0, request.path.lastIndexOf('/')) || '/', { recursive: true })
    await this.deps.files.writeFile(request.path, request.bytes)
    this.markDirty()
    this.touch()
  }

  /** Removes a deleted Conversation's or Project's directory from a running machine. */
  async dropUnit(unit: Unit): Promise<void> {
    await this.adopt()
    const key = unitKey(unit)
    this.known.delete(key)
    this.dirty.delete(key)
    if (!this.deps.container?.running) return
    await this.deps.files.remove(unitDir(unit), { recursive: true, force: true })
    await this.deps.files.remove(`${UNITS_DIR}/${key}`, { recursive: true, force: true })
  }

  /** Backs up every dirty unit. False when any backup failed: the machine must not stop then. */
  private async backupDirty(): Promise<boolean> {
    let ok = true
    const work = (async () => {
      for (const key of [...this.dirty]) {
        const unit = keyToUnit(key)
        if (!unit) {
          this.dirty.delete(key)
          continue
        }
        try {
          const record = await this.deps.backups.backup({ dir: unitDir(unit), exclude: BACKUP_EXCLUDE, gitignore: true })
          await this.deps.records.record(unit, record)
          this.dirty.delete(key)
          await this.deps.records.rotate(unit).catch(error => console.error('sandbox backup rotation failed', key, error))
        } catch (error) {
          ok = false
          console.error('sandbox backup failed', key, error)
        }
      }
    })()
    this.backingUp = work
    try {
      await work
    } finally {
      this.backingUp = null
    }
    this.lastBackupAt = this.deps.now()
    return ok
  }

  private async settleJobs(): Promise<number> {
    const jobs = await this.deps.storage.list<StoredJob>({ prefix: JOB_PREFIX })
    const running = this.deps.container?.running ?? false
    let remaining = 0
    for (const [key, job] of jobs) {
      let notification: TaskNotificationPart | null = null
      const base = { type: 'task_notification' as const, task_id: jobTaskId(job.id), plugin_id: job.pluginId, tool_call_id: job.toolCallId }
      if (!running) {
        notification = { ...base, status: 'failed', text: `The sandbox stopped before the background command finished, and the command ended with it: ${job.summary}` }
      } else {
        const exit = await this.readText(`${job.dir}/exit`)
        if (exit !== null) {
          const code = Number(exit.trim())
          const tail = await this.tail(`${job.dir}/log`)
          const seconds = Math.round((this.deps.now() - job.startedAt) / 1000)
          notification = {
            ...base,
            status: code === 0 ? 'completed' : 'failed',
            text: `Background command exited with code ${exit.trim()} after about ${seconds}s: ${job.summary}\n`
              + `Full log: ${job.dir}/log\nLast output:\n${tail}`,
          }
        }
      }
      if (!notification) {
        remaining++
        continue
      }
      try {
        await this.deps.settle(job, notification)
        await this.deps.storage.delete(key)
      } catch (error) {
        // Kept for the next alarm; the hub delivers each task id once, so a retry cannot duplicate it.
        console.error('sandbox job settlement failed', job.id, error)
        remaining++
      }
    }
    return remaining
  }

  private async readText(path: string): Promise<string | null> {
    try {
      return await (await this.deps.files.readFile(path)).text()
    } catch (error) {
      if (this.deps.isMissing(error)) return null
      throw error
    }
  }

  private async tail(path: string): Promise<string> {
    const process = await this.container.exec(['tail', '-c', String(JOB_TAIL_BYTES), path], { env: SANDBOX_ENV, stdout: 'pipe', stderr: 'pipe' })
    const output = await process.output()
    return new TextDecoder().decode(output.stdout)
  }

  /** Spec §5.3. */
  async alarm(): Promise<void> {
    await this.adopt()
    const runningJobs = await this.settleJobs()
    const container = this.deps.container
    if (!container?.running) return

    const idleMs = ((await this.deps.storage.get<number>(IDLE_MINUTES_KEY)) ?? 10) * 60_000
    const now = this.deps.now()
    const idle = this.inflight === 0 && runningJobs === 0 && now - this.lastActivity >= idleMs
    if (idle) {
      const activityBefore = this.lastActivity
      const ok = await this.backupDirty()
      if (ok && this.inflight === 0 && this.lastActivity === activityBefore) {
        await container.destroy()
        this.known.clear()
        this.dirty.clear()
        return
      }
    } else if (this.dirty.size > 0 && this.inflight === 0 && now - this.lastBackupAt >= CHECKPOINT_INTERVAL_MS) {
      await this.backupDirty()
    }
    await this.deps.setAlarm(this.deps.now() + ALARM_INTERVAL_MS)
  }
}
