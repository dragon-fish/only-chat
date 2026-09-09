import { access, readFile } from 'node:fs/promises'
import { resetUserCredentials } from '../../scripts/lib/reset-user-credentials.ts'

try {
  await resetUserCredentials({
    userId: 1, environment: 'local', name: 'Synthetic user', email: 'synthetic@example.com',
    passwordHash: 'synthetic-hash-only', accountId: 'synthetic-account', now: 1,
  }, async (args, options) => {
    const file = args[args.indexOf('--file') + 1]
    if (!(await readFile(file, 'utf8')).includes('synthetic-hash-only')) throw new Error('Fixture SQL missing hash')
    return new Promise((_resolve, reject) => {
      const keepAlive = setInterval(() => {}, 1000)
      options?.signal?.addEventListener('abort', async () => {
        process.send({ event: 'cancelled' })
        // Hold cancellation open until the parent sends a second termination signal.
        await new Promise(resolve => process.once('message', resolve))
        await access(file)
        process.send({ event: 'drained' })
        clearInterval(keepAlive)
        reject(new Error('Synthetic runner cancelled'))
      }, { once: true })
      process.send({ event: 'ready', file })
    })
  })
} catch {
  process.exitCode = process.exitCode || 1
} finally {
  process.disconnect()
}
