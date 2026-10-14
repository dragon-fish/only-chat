import { DurableObject } from 'cloudflare:workers'
import { DirectoryBackup, Files, SandboxFileError, type DirectoryBackupGatewayBinding } from '@cloudflare/sandbox'
import { createDb } from '@/server/db/client'
import { parseAuthUserId } from '@/server/plugins/auth/user-id'
import { disposeRpcStub } from '@/server/rpc'
import { latestBackup, recordBackup, rotateBackups } from './backups'
import { SandboxMachine, type MachineDeps } from './machine'
import {
  BACKUP_PREFIX,
  type ExecRequest, type JobRequest, type JobStarted, type MachineOptions, type ReadRequest, type ReadResult,
  type SandboxRpc, type StatResult, type Unit, type WriteRequest,
} from './protocol'

const OWNER_KEY = 'user_id'

/**
 * One user's sandbox machine (spec 2026-10-14-sandbox-design §2.1), addressed by
 * `SANDBOX.getByName(String(userId))`. Only this Worker's own code calls it; every call names the
 * user and is refused when that is not the instance's owner, as `UserHub` does.
 */
export class Sandbox extends DurableObject<Env> implements SandboxRpc {
  private owner: number | undefined
  private readonly machine: SandboxMachine

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    const container = ctx.container
    const db = createDb(env.DB)
    const files = container ? new Files(container) : undefined
    const backups = container
      ? new DirectoryBackup(container, ctx.exports.DirectoryBackupGateway as unknown as DirectoryBackupGatewayBinding, { binding: 'BUCKET', prefix: BACKUP_PREFIX })
      : undefined
    const userId = () => {
      if (this.owner === undefined) throw new Error('Sandbox identity is not initialized')
      return this.owner
    }
    const unavailable = () => {
      throw new Error('Containers are disabled here: local dev runs them only with SANDBOX_DEV=1 and Docker.')
    }
    const deps: MachineDeps = {
      container,
      files: files ?? new Proxy({}, { get: unavailable }) as MachineDeps['files'],
      backups: backups ?? new Proxy({}, { get: unavailable }) as MachineDeps['backups'],
      records: {
        latest: async (unit) => latestBackup(db, userId(), unit),
        record: async (unit, record) => {
          await recordBackup(db, userId(), unit, record, Date.now())
        },
        rotate: async (unit) => {
          await rotateBackups(db, env.BUCKET, userId(), unit)
        },
      },
      storage: {
        get: key => ctx.storage.get(key),
        put: (key, value) => ctx.storage.put(key, value),
        delete: key => ctx.storage.delete(key),
        list: options => ctx.storage.list(options),
      },
      setAlarm: at => ctx.storage.setAlarm(at),
      settle: async (job, notification) => {
        const id = userId()
        const hub = env.USER_HUB.getByName(String(id))
        try {
          await hub.settleTask(id, { conversation_id: job.conversationId, origin_message_id: job.originMessageId, notification })
        } finally {
          disposeRpcStub(hub)
        }
      },
      isMissing: error => SandboxFileError.is(error) && error.code === 'ENOENT',
      now: () => Date.now(),
    }
    this.machine = new SandboxMachine(deps)
    void ctx.blockConcurrencyWhile(async () => {
      this.owner = await ctx.storage.get<number>(OWNER_KEY)
    })
  }

  private async claim(userId: number): Promise<void> {
    const parsed = parseAuthUserId(userId)
    if (this.owner === parsed) return
    if (this.owner !== undefined) throw new Error('Sandbox identity mismatch')
    await this.ctx.storage.put(OWNER_KEY, parsed)
    this.owner = parsed
  }

  async exec(request: ExecRequest): Promise<ReadableStream<Uint8Array>> {
    await this.claim(request.userId)
    return this.machine.exec(request)
  }

  async kill(userId: number, execId: string): Promise<void> {
    await this.claim(userId)
    await this.machine.kill(execId)
  }

  async startJob(request: JobRequest): Promise<JobStarted> {
    await this.claim(request.userId)
    return this.machine.startJob(request)
  }

  async stat(userId: number, machine: MachineOptions, path: string): Promise<StatResult | null> {
    await this.claim(userId)
    return this.machine.stat(machine, path)
  }

  async readFile(request: ReadRequest): Promise<ReadResult> {
    await this.claim(request.userId)
    return this.machine.readFile(request)
  }

  async writeFile(request: WriteRequest): Promise<void> {
    await this.claim(request.userId)
    await this.machine.writeFile(request)
  }

  async dropUnit(userId: number, unit: Unit): Promise<void> {
    await this.claim(userId)
    await this.machine.dropUnit(unit)
  }

  override async alarm(): Promise<void> {
    if (this.owner === undefined) return
    await this.machine.alarm()
  }
}
