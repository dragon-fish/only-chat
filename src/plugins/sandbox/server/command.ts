import type { SandboxExecInput } from '../shared'

/** What `bash -lc` runs: a command string, or argv kept intact through `exec "$@"`. */
export function wrapCommand(input: Pick<SandboxExecInput, 'command' | 'argv'>): string[] | null {
  if ((input.command === undefined) === (input.argv === undefined)) return null
  if (input.command !== undefined) return ['bash', '-lc', input.command]
  return ['bash', '-lc', 'exec "$@"', 'sandbox', ...input.argv!]
}

export function summarize(input: Pick<SandboxExecInput, 'command' | 'argv'>): string {
  const text = input.command ?? input.argv!.join(' ')
  return text.length > 200 ? `${text.slice(0, 200)}…` : text
}
