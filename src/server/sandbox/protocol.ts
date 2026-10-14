/**
 * The contract between the sandbox plugin (hub root) and the `Sandbox` Durable Object (spec
 * 2026-10-14-sandbox-design §2.1). The DO knows units, executions and backups; it never learns about
 * conversations, models or the VFS beyond the ids it is handed to settle a background task.
 */

import type { InstanceType } from '@/shared/sandbox'

export const SANDBOX_ROOT = '/workspace'
export const HOME_DIR = `${SANDBOX_ROOT}/home`
/** Marker files saying a unit was restored into the running container (spec §5.1). */
export const UNITS_DIR = `${SANDBOX_ROOT}/.units`
export const JOBS_DIR = `${SANDBOX_ROOT}/.jobs`
export const EXEC_LOG_DIR = '/tmp/sandbox-logs'

/** In-image helpers (sandbox/Dockerfile). */
export const SANDBOX_RUN = '/opt/sandbox/bin/sandbox-run'
export const JOB_RUN = '/opt/sandbox/bin/job-run'

/** Named in wrangler.jsonc `containers[].images`; `ctx.container.images` maps it to the reference `start` takes. */
export const SANDBOX_IMAGE = 'sandbox'

export const BACKUP_PREFIX = 'sandbox-backups/'
/** gitignore syntax, on top of each unit's own `.gitignore` files (spec §5.4). */
export const BACKUP_EXCLUDE = ['node_modules/', '.venv/', '__pycache__/', '.cache/'] as const
export const BACKUPS_KEPT = 2

export const ALARM_INTERVAL_MS = 60_000
export const CHECKPOINT_INTERVAL_MS = 15 * 60_000
/** The platform's own stop, a safety net behind the alarm (spec §5.1). */
export const PLATFORM_INACTIVITY_MS = 30 * 60_000

/** What a text read may load whole; beyond it a file is only exported or delivered as bytes. */
export const MAX_TEXT_READ_BYTES = 10 * 1024 * 1024

export type UnitKind = 'user' | 'project' | 'conversation'
export type Unit = { kind: 'user', id: null } | { kind: 'project' | 'conversation', id: number }

export const USER_UNIT: Unit = { kind: 'user', id: null }

export function unitDir(unit: Unit): string {
  switch (unit.kind) {
    case 'user': return HOME_DIR
    case 'project': return `${SANDBOX_ROOT}/projects/${unit.id}`
    case 'conversation': return `${SANDBOX_ROOT}/conversations/${unit.id}`
  }
}

export function unitKey(unit: Unit): string {
  return unit.kind === 'user' ? 'user' : `${unit.kind}-${unit.id}`
}

/** The unit an absolute path lives in, or null for a path outside every unit (spec §4). */
export function unitOfPath(path: string): Unit | null {
  if (path === HOME_DIR || path.startsWith(`${HOME_DIR}/`)) return USER_UNIT
  const match = /^\/workspace\/(projects|conversations)\/(\d+)(?:\/|$)/.exec(path)
  if (!match) return null
  const id = Number(match[2])
  if (!Number.isSafeInteger(id) || id <= 0) return null
  return { kind: match[1] === 'projects' ? 'project' : 'conversation', id }
}

/** Resolves `.` and `..` lexically; rejects anything that is not an absolute path. */
export function normalizeSandboxPath(path: string): string | null {
  if (!path.startsWith('/') || path.includes('\0')) return null
  const out: string[] = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') out.pop()
    else out.push(segment)
  }
  return `/${out.join('/')}`
}

/** What every call that may start the container carries; the DO keeps none of it between calls. */
export interface MachineOptions {
  instance: InstanceType
  idleMinutes: number
}

export interface ExecRequest {
  userId: number
  machine: MachineOptions
  /** The tool call id; names the log file and is what `kill` addresses. */
  execId: string
  /** Already wrapped by the caller (`bash -lc …`); the DO adds only its own helpers around it. */
  argv: string[]
  stdin?: string
  cwd: string
  timeoutMs: number
}

/** The files one foreground execution leaves in the container, named after its tool call. */
export function execFiles(execId: string): { log: string, pid: string, cwd: string } {
  // Tool call ids are provider-chosen, so they are made safe to use as a file name.
  const name = execId.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120) || 'exec'
  return { log: `${EXEC_LOG_DIR}/${name}.log`, pid: `${EXEC_LOG_DIR}/${name}.pid`, cwd: `${EXEC_LOG_DIR}/${name}.cwd` }
}

/** NDJSON frames of the stream `exec` returns. */
export type ExecFrame =
  | { type: 'notes', notes: string[] }
  | { type: 'out', stream: 'stdout' | 'stderr', data: string }
  | {
    type: 'end', exitCode: number, timedOut: boolean, durationMs: number, logPath: string
    /** Where the command's shell ended, when that is not where it started. */
    finalCwd?: string
    /** `finalCwd` lies in a unit not restored into this container: what was written there is not saved. */
    finalCwdUnsaved?: boolean
  }
  | { type: 'error', message: string }

export interface JobRequest {
  userId: number
  machine: MachineOptions
  argv: string[]
  stdin?: string
  cwd: string
  conversationId: number
  originMessageId: number
  toolCallId: string
  /** Names the notification's owner; the DO knows no plugin ids of its own. */
  pluginId: string
  /** Shown in the notification so the model knows which job finished. */
  summary: string
}

export interface JobStarted {
  taskId: string
  pid: number
  logPath: string
  notes: string[]
}

export type SandboxFileKind = 'file' | 'directory' | 'other'

export interface StatResult {
  kind: SandboxFileKind
  size: number
}

export interface ReadRequest {
  userId: number
  machine: MachineOptions
  path: string
  /** A larger file is refused with its size, never truncated. */
  maxBytes: number
}

export type ReadResult =
  | { ok: true, bytes: Uint8Array, size: number }
  | { ok: false, code: 'NOT_FOUND' | 'NOT_A_FILE' | 'TOO_LARGE', size?: number }

export interface WriteRequest {
  userId: number
  machine: MachineOptions
  path: string
  bytes: Uint8Array
}

export function jobTaskId(jobId: number): string {
  return `sandbox_job:${jobId}`
}

/** The RPC surface of the `Sandbox` Durable Object, stated once for the plugin's stub cast. */
export interface SandboxRpc {
  exec(request: ExecRequest): Promise<ReadableStream<Uint8Array>>
  kill(userId: number, execId: string): Promise<void>
  startJob(request: JobRequest): Promise<JobStarted>
  stat(userId: number, machine: MachineOptions, path: string): Promise<StatResult | null>
  readFile(request: ReadRequest): Promise<ReadResult>
  writeFile(request: WriteRequest): Promise<void>
  dropUnit(userId: number, unit: Unit): Promise<void>
}
