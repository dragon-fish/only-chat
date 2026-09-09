import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

export interface ResetTarget {
  userId: number
  environment: 'local' | 'remote'
}

interface ResetInput extends ResetTarget {
  name: string
  email: string
  passwordHash: string
  accountId: string
  now: number
}

export type WranglerRunner = (args: string[], options?: { signal?: AbortSignal }) => Promise<string>

export function parseResetArgs(rawArgs: string[]): ResetTarget {
  const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs
  let userId: number | undefined
  let environment: ResetTarget['environment'] | undefined
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--userid') {
      const value = args[++index]
      if (userId !== undefined || !value || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
        throw new Error('--userid must be one canonical positive safe integer.')
      }
      userId = Number(value)
    } else if (arg === '--local' || arg === '--remote') {
      if (environment) throw new Error('Specify exactly one of --local and --remote.')
      environment = arg === '--local' ? 'local' : 'remote'
    } else {
      // Do not echo unknown arguments: an operator might accidentally put a secret there.
      throw new Error('Unknown argument. Usage: pnpm auth:reset-user -- --userid <id> --local|--remote')
    }
  }
  if (userId === undefined) throw new Error('--userid is required.')
  if (!environment) throw new Error('Specify exactly one of --local and --remote.')
  return { userId, environment }
}

export function escapeSqlLiteral(value: string): string {
  if (value.includes('\0')) throw new Error('SQL text cannot contain NUL characters.')
  return `'${value.replaceAll("'", "''")}'`
}

export function buildResetSql(input: ResetInput): string {
  if (!Number.isSafeInteger(input.userId) || input.userId <= 0 || !Number.isSafeInteger(input.now) || input.now < 0) {
    throw new Error('Invalid user ID or timestamp.')
  }
  const { userId, now } = input
  const name = escapeSqlLiteral(input.name)
  const email = escapeSqlLiteral(input.email)
  // Future login-method tables (for example Passkeys) must be cleared in this same batch.
  // D1 file ingestion owns the transaction; explicit BEGIN/COMMIT is rejected remotely.
  return `DELETE FROM auth_sessions WHERE user_id = ${userId};
DELETE FROM auth_accounts WHERE user_id = ${userId};
UPDATE users SET name = ${name}, email = ${email}, email_verified = 0, updated_at = ${now} WHERE id = ${userId};
INSERT INTO auth_accounts (id, account_id, provider_id, user_id, password, created_at, updated_at)
SELECT ${escapeSqlLiteral(input.accountId)}, CAST(id AS TEXT), 'credential', id, ${escapeSqlLiteral(input.passwordHash)}, ${now}, ${now}
FROM users WHERE id = ${userId} AND email = ${email};
`
}

const executeFile = promisify(execFile)
const require = createRequire(import.meta.url)
const wranglerBin = join(dirname(require.resolve('wrangler/package.json')), 'bin/wrangler.js')

export const runWrangler: WranglerRunner = async (args, options = {}) => {
  const execution = executeFile(process.execPath, [wranglerBin, ...args], { maxBuffer: 4 * 1024 * 1024, signal: options.signal })
  const closed = new Promise<void>(resolve => execution.child.once('close', () => resolve()))
  try {
    // Invoke the installed CLI with Node so Windows does not need a shell for pnpm.cmd.
    const { stdout } = await execution
    return stdout
  } catch {
    // Abort rejects before process exit; wait for Wrangler's signal forwarding and stdio closure.
    await closed
    options.signal?.throwIfAborted()
    // Subprocess errors can embed SQL/output. Keep them out of operator logs.
    throw new Error('Wrangler D1 execution failed. Check database configuration, access, and email uniqueness.')
  }
}

function commandArgs(target: ResetTarget): string[] {
  return ['d1', 'execute', 'DB', `--${target.environment}`, '--json', '--yes']
}

function readResults(output: string): Record<string, unknown>[] {
  const response: unknown = JSON.parse(output)
  if (!Array.isArray(response) || response.length !== 1 || response[0]?.success !== true || !Array.isArray(response[0].results)) {
    throw new Error('Wrangler returned an unsuccessful or invalid query result.')
  }
  return response[0].results
}

export async function getResetUser(target: ResetTarget, run: WranglerRunner = runWrangler) {
  const rows = readResults(await run([...commandArgs(target), '--command', `SELECT id, name, email FROM users WHERE id = ${target.userId};`]))
  const user = rows[0]
  if (rows.length !== 1 || !user || user.id !== target.userId || typeof user.name !== 'string' || typeof user.email !== 'string') {
    throw new Error('Target user not found.')
  }
  return { id: target.userId, name: user.name, email: user.email }
}

export async function resetUserCredentials(input: ResetInput, run: WranglerRunner = runWrangler): Promise<void> {
  const sql = buildResetSql(input)
  const controller = new AbortController()
  const interrupt = (signal: 'SIGINT' | 'SIGTERM') => {
    if (controller.signal.aborted) return
    process.exitCode = signal === 'SIGINT' ? 130 : 143
    controller.abort(new Error(`Credential reset interrupted by ${signal}.`))
  }
  const onSigint = () => interrupt('SIGINT')
  const onSigterm = () => interrupt('SIGTERM')
  // Keep both handlers through cancellation and cleanup; repeated signals must not bypass finally.
  process.on('SIGINT', onSigint)
  process.on('SIGTERM', onSigterm)
  let directory: string | undefined
  try {
    directory = await mkdtemp(join(tmpdir(), 'only-chat-reset-'))
    controller.signal.throwIfAborted()
    const file = join(directory, 'reset.sql')
    await writeFile(file, sql, { mode: 0o600, flag: 'wx', signal: controller.signal })
    controller.signal.throwIfAborted()
    await run([...commandArgs(input), '--file', file], { signal: controller.signal })
    controller.signal.throwIfAborted()
    const query = `SELECT u.id, u.name, u.email, u.email_verified,
      (SELECT COUNT(*) FROM auth_sessions WHERE user_id = u.id) AS session_count,
      (SELECT COUNT(*) FROM auth_accounts WHERE user_id = u.id) AS account_count,
      (SELECT COUNT(*) FROM auth_accounts WHERE user_id = u.id AND id = ${escapeSqlLiteral(input.accountId)} AND provider_id = 'credential' AND account_id = CAST(u.id AS TEXT) AND password IS NOT NULL) AS credential_count
      FROM users u WHERE u.id = ${input.userId};`
    const rows = readResults(await run([...commandArgs(input), '--command', query], { signal: controller.signal }))
    controller.signal.throwIfAborted()
    const user = rows[0]
    if (rows.length !== 1 || !user || user.id !== input.userId || user.name !== input.name || user.email !== input.email || user.email_verified !== 0 || user.session_count !== 0 || user.account_count !== 1 || user.credential_count !== 1) {
      throw new Error('Reset verification failed. Inspect the target before attempting another reset.')
    }
  } finally {
    try {
      if (directory) await rm(directory, { recursive: true, force: true })
    } finally {
      process.off('SIGINT', onSigint)
      process.off('SIGTERM', onSigterm)
    }
  }
  controller.signal.throwIfAborted()
}
