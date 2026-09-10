import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { d1Args, escapeSqlLiteral, readResults, runWrangler, type WranglerRunner } from './d1.ts'

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

export async function getResetUser(target: ResetTarget, run: WranglerRunner = runWrangler) {
  const rows = readResults(await run([...d1Args(target.environment), '--command', `SELECT id, name, email FROM users WHERE id = ${target.userId};`]))
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
    await run([...d1Args(input.environment), '--file', file], { signal: controller.signal })
    controller.signal.throwIfAborted()
    const query = `SELECT u.id, u.name, u.email, u.email_verified,
      (SELECT COUNT(*) FROM auth_sessions WHERE user_id = u.id) AS session_count,
      (SELECT COUNT(*) FROM auth_accounts WHERE user_id = u.id) AS account_count,
      (SELECT COUNT(*) FROM auth_accounts WHERE user_id = u.id AND id = ${escapeSqlLiteral(input.accountId)} AND provider_id = 'credential' AND account_id = CAST(u.id AS TEXT) AND password IS NOT NULL) AS credential_count
      FROM users u WHERE u.id = ${input.userId};`
    const rows = readResults(await run([...d1Args(input.environment), '--command', query], { signal: controller.signal }))
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
