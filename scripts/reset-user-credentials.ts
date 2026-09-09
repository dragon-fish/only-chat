import { randomUUID } from 'node:crypto'
import { confirm, input, password } from '@inquirer/prompts'
import { hashPassword } from 'better-auth/crypto'
import { z } from 'zod'
import { getResetUser, parseResetArgs, resetUserCredentials } from './lib/reset-user-credentials.ts'

async function main() {
  const target = parseResetArgs(process.argv.slice(2))
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Run this command in an interactive terminal.')
  const user = await getResetUser(target)
  console.log(`Environment: ${target.environment}\nUser ID: ${user.id}\nCurrent email: ${JSON.stringify(user.email)}`)
  if (!await confirm({ message: 'Remove all current login methods and sessions for this user?', default: false })) return
  const name = await input({ message: 'Name', default: user.name, validate: value => Boolean(value.trim()) && !value.includes('\0') || 'Enter a nonempty name without NUL characters.' })
  const email = (await input({ message: 'Email', default: user.email, validate: value => z.email().safeParse(value.trim().toLowerCase()).success || 'Enter a valid email address.' })).trim().toLowerCase()
  const secret = await password({ message: 'New password', mask: false, validate: value => value.length >= 8 && value.length <= 128 || 'Use 8–128 characters.' })
  await password({ message: 'Confirm new password', mask: false, validate: value => value === secret || 'Passwords do not match.' })
  await resetUserCredentials({ ...target, name: name.trim(), email, passwordHash: await hashPassword(secret), accountId: randomUUID(), now: Date.now() })
  console.log(`Credentials reset and verified for user ${user.id} (${target.environment}).`)
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Credential reset failed.')
  process.exitCode = 1
})
