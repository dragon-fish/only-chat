import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

export type D1Environment = 'local' | 'remote'

export type WranglerRunner = (args: string[], options?: { signal?: AbortSignal }) => Promise<string>

/** SQLite string literal quoting. Every value interpolated into script SQL must pass through here. */
export function escapeSqlLiteral(value: string): string {
  if (value.includes('\0')) throw new Error('SQL text cannot contain NUL characters.')
  return `'${value.replaceAll("'", "''")}'`
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
    throw new Error('Wrangler D1 execution failed. Check database configuration and access.')
  }
}

export function d1Args(environment: D1Environment): string[] {
  return ['d1', 'execute', 'DB', `--${environment}`, '--json', '--yes']
}

export function readResults(output: string): Record<string, unknown>[] {
  const response: unknown = JSON.parse(output)
  if (!Array.isArray(response) || response.length !== 1 || response[0]?.success !== true || !Array.isArray(response[0].results)) {
    throw new Error('Wrangler returned an unsuccessful or invalid query result.')
  }
  return response[0].results
}
