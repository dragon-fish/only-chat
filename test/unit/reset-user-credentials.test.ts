import { DatabaseSync } from 'node:sqlite'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { readFile, readdir, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hashPassword, verifyPassword } from 'better-auth/crypto'
import { buildResetSql, getResetUser, parseResetArgs, resetUserCredentials } from '../../scripts/lib/reset-user-credentials'
import { escapeSqlLiteral, type WranglerRunner } from '../../scripts/lib/d1'

const target = { userId: 1, environment: 'local' as const }
const replacement = { ...target, name: "O'Brien\n; DELETE FROM users; --", email: 'recovered@example.com', passwordHash: 'hashed-value', accountId: 'replacement-account', now: 1234 }

async function fixture() {
  const db = new DatabaseSync(':memory:')
  for (const file of (await readdir(new URL('../../migrations/', import.meta.url))).filter(file => file.endsWith('.sql')).sort()) {
    db.exec(await readFile(new URL(`../../migrations/${file}`, import.meta.url), 'utf8'))
  }
  db.exec(`INSERT INTO users (id,name,settings,created_at,email,role) VALUES
    (1,'Owner','{"theme":"dark"}',1,'old@example.com','admin'),(2,'Other','{}',1,'taken@example.com','user');
    INSERT INTO auth_accounts (id,account_id,provider_id,user_id,password,updated_at) VALUES
    ('old','1','credential',1,'old-hash',1),('oauth','external','github',1,NULL,1),('other','2','credential',2,'other-hash',1);
    INSERT INTO auth_sessions (id,token,user_id,expires_at,updated_at) VALUES ('old-session','old-token',1,99999,1),('other-session','other-token',2,99999,1);
    INSERT INTO conversations (user_id,title,created_at,updated_at) VALUES (1,'Keep conversation',1,1);
    INSERT INTO providers (user_id,name,created_at) VALUES (1,'Keep provider',1);
    INSERT INTO projects (user_id,name,created_at,updated_at) VALUES (1,'Keep project',1,1);
    INSERT INTO attachments (user_id,sha256,mime,size,r2_key,origin,created_at) VALUES (1,'sha','image/png',1,'key','upload',1);`)
  return db
}

function executeBatch(db: DatabaseSync, sql: string) {
  db.exec('BEGIN')
  try { db.exec(sql); db.exec('COMMIT') } catch (error) { db.exec('ROLLBACK'); throw error }
}

describe('credential reset arguments', () => {
  it.each(['1', '42', '9007199254740991'])('accepts canonical user ID %s and explicit environment', id => {
    expect(parseResetArgs(['--', '--userid', id, '--remote'])).toEqual({ userId: Number(id), environment: 'remote' })
  })
  it.each(['0', '-1', '01', '1.0', '1e2', ' 1', '9007199254740992', '1;DELETE', ''])('rejects malformed ID %s', id => {
    expect(() => parseResetArgs(['--userid', id, '--local'])).toThrow(/userid/i)
  })
  it.each([[], ['--local'], ['--userid', '1'], ['--userid', '1', '--local', '--remote'], ['--userid', '1', '--local', '--local'], ['--userid', '1', '--userid', '2', '--local'], ['--userid', '1', '--local', '--password', 'secret']].map(args => ({ args })))('rejects unsafe or ambiguous arguments $args', ({ args }) => {
    expect(() => parseResetArgs(args)).toThrow()
  })
})

describe('credential reset SQL', () => {
  it('escapes apostrophes and rejects NUL before file ingestion', () => {
    expect(escapeSqlLiteral("O'Brien")).toBe("'O''Brien'")
    expect(() => escapeSqlLiteral('name\0tail')).toThrow()
  })
  it('replaces all login methods and sessions while preserving business data and other users', async () => {
    const db = await fixture()
    try {
      const before = db.prepare('SELECT * FROM users WHERE id = 2').get()
      const business = ['conversations', 'providers', 'projects', 'attachments'].map(table => db.prepare(`SELECT * FROM ${table}`).all())
      executeBatch(db, buildResetSql(replacement))
      expect(db.prepare('SELECT name,email,email_verified,role,settings FROM users WHERE id = 1').get()).toEqual({ name: replacement.name, email: replacement.email, email_verified: 0, role: 'admin', settings: '{"theme":"dark"}' })
      expect(db.prepare('SELECT account_id,provider_id,password FROM auth_accounts WHERE user_id = 1').all()).toEqual([{ account_id: '1', provider_id: 'credential', password: 'hashed-value' }])
      expect(db.prepare('SELECT id FROM auth_sessions').all()).toEqual([{ id: 'other-session' }])
      expect(db.prepare('SELECT * FROM users WHERE id = 2').get()).toEqual(before)
      expect(db.prepare('SELECT password FROM auth_accounts WHERE user_id = 2').get()).toEqual({ password: 'other-hash' })
      expect(['conversations', 'providers', 'projects', 'attachments'].map(table => db.prepare(`SELECT * FROM ${table}`).all())).toEqual(business)
    } finally { db.close() }
  })
  it.each(['conflict', 'last-statement'])('rolls back all changes on %s failure', async reason => {
    const db = await fixture()
    try {
      const sql = buildResetSql({ ...replacement, email: reason === 'conflict' ? 'taken@example.com' : replacement.email }) + (reason === 'last-statement' ? '\nINSERT INTO missing_table VALUES (1);' : '')
      expect(() => executeBatch(db, sql)).toThrow()
      expect(db.prepare('SELECT email FROM users WHERE id = 1').get()).toEqual({ email: 'old@example.com' })
      expect(db.prepare('SELECT id FROM auth_accounts WHERE user_id = 1 ORDER BY id').all()).toEqual([{ id: 'oauth' }, { id: 'old' }])
      expect(db.prepare('SELECT id FROM auth_sessions WHERE user_id = 1').all()).toEqual([{ id: 'old-session' }])
    } finally { db.close() }
  })
  it('does not insert an orphan credential if the target disappeared', async () => {
    const db = await fixture()
    try {
      executeBatch(db, buildResetSql({ ...replacement, userId: 99 }))
      expect(db.prepare('SELECT id FROM auth_accounts WHERE user_id = 99').all()).toEqual([])
    } finally { db.close() }
  })
})

describe('Wrangler execution boundary', () => {
  it.each([false, true])('uses a private hash-only file and removes it after success/failure (failure=%s)', async fail => {
    const listeners = (['SIGINT', 'SIGTERM'] as const).map(signal => process.listeners(signal))
    const db = await fixture()
    const plain = 'this-only-lives-in-memory'
    let filePath = ''
    const run: WranglerRunner = async args => {
      expect(args).toContain('--local')
      expect(args.join(' ')).not.toContain(plain)
      const index = args.indexOf('--file')
      if (index >= 0) {
        filePath = args[index + 1]!
        const sql = await readFile(filePath, 'utf8')
        if (process.platform !== 'win32') expect((await stat(filePath)).mode & 0o777).toBe(0o600)
        expect(sql).not.toContain(plain)
        expect(sql).not.toMatch(/\bBEGIN\b|\bCOMMIT\b/)
        if (fail) throw new Error('Wrangler failed')
        executeBatch(db, sql)
        return JSON.stringify([{ success: true, results: [], meta: {} }])
      }
      const results = db.prepare(args[args.indexOf('--command') + 1]!).all()
      return JSON.stringify([{ success: true, results, meta: {} }])
    }
    try {
      expect(await getResetUser(target, run)).toMatchObject({ id: 1, email: 'old@example.com' })
      const reset = resetUserCredentials({ ...replacement, passwordHash: await hashPassword(plain) }, run)
      if (fail) await expect(reset).rejects.toThrow('Wrangler failed')
      else {
        await reset
        const row = db.prepare('SELECT password FROM auth_accounts WHERE user_id = 1').get()!
        expect(await verifyPassword({ password: plain, hash: String(row.password) })).toBe(true)
      }
      await expect(stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' })
      expect((['SIGINT', 'SIGTERM'] as const).map(signal => process.listeners(signal))).toEqual(listeners)
    } finally { db.close() }
  })
  it.skipIf(process.platform === 'win32').each(['SIGINT', 'SIGTERM'] as const)('cancels the runner and removes temporary SQL on %s, including repeated signals', async signal => {
    const child = fork(new URL('../fixtures/reset-user-credentials-interruption.mjs', import.meta.url), { silent: true, execArgv: ['--import', 'tsx'], timeout: 5000, killSignal: 'SIGKILL' })
    const closed = once(child, 'close')
    const events: string[] = []
    child.on('message', message => events.push((message as { event: string }).event))
    let directory: string | undefined
    try {
      const [ready] = await once(child, 'message') as [{ event: string, file: string }]
      expect(ready.event).toBe('ready')
      directory = dirname(ready.file)
      const cancelledOrClosed = Promise.race([
        once(child, 'message').then(([message]) => message as { event: string }),
        closed.then(() => ({ event: 'exited-without-cancellation' })),
      ])
      child.kill(signal)
      const result = await cancelledOrClosed
      if (result.event === 'cancelled') {
        child.kill(signal === 'SIGINT' ? 'SIGTERM' : 'SIGINT')
        child.send('finish cancellation')
      }
      const [code, exitSignal] = await closed
      await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(result.event).toBe('cancelled')
      expect(events.filter(event => event === 'cancelled')).toHaveLength(1)
      expect(events).toContain('drained')
      expect(code).not.toBe(0)
      expect(exitSignal).toBeNull()
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await closed
      if (directory) await rm(directory, { recursive: true, force: true })
    }
  }, 10_000)
  it('fails before prompting if the target is missing or Wrangler reports failure', async () => {
    await expect(getResetUser(target, async () => JSON.stringify([{ success: true, results: [] }]))).rejects.toThrow(/not found/i)
    await expect(getResetUser(target, async () => JSON.stringify([{ success: false, results: [] }]))).rejects.toThrow(/Wrangler/i)
  })
  it('fails verification if the expected replacement account was not written', async () => {
    await expect(resetUserCredentials(replacement, async () => JSON.stringify([{ success: true, results: [] }]))).rejects.toThrow(/verif/i)
  })
})
