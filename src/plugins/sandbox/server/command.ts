import type { SandboxExecInput } from '../shared'

/**
 * Records where a command's shell ends up, so the model can be told a `cd` did not carry over. The
 * command runs through `eval` after the positional parameters are cleared, so its own `$1` is empty
 * as it would be under `bash -lc` alone; the helper's names start with `__sandbox_` to stay out of
 * its way.
 */
const TRACK_CWD = '__sandbox_cmd=$1; __sandbox_cwd=$2; set --; eval "$__sandbox_cmd"; __sandbox_status=$?; pwd > "$__sandbox_cwd" 2>/dev/null; exit $__sandbox_status'

/**
 * What `bash -lc` runs: a command string, or argv kept intact through `exec "$@"`. With `cwdFile`,
 * a command string also leaves its final directory there; argv runs no shell and cannot `cd`.
 */
export function wrapCommand(input: Pick<SandboxExecInput, 'command' | 'argv'>, cwdFile?: string): string[] | null {
  if ((input.command === undefined) === (input.argv === undefined)) return null
  if (input.command !== undefined) {
    return cwdFile === undefined ? ['bash', '-lc', input.command] : ['bash', '-lc', TRACK_CWD, 'sandbox', input.command, cwdFile]
  }
  return ['bash', '-lc', 'exec "$@"', 'sandbox', ...input.argv!]
}

/** What the model is told when a command's shell left its start directory. */
export function cwdNotes(end: { finalCwd?: string, finalCwdUnsaved?: boolean }, nextStart: string): string[] {
  if (end.finalCwd === undefined) return []
  const notes = [`This command ended in ${end.finalCwd}, but a cd lasts only for its own call: the next call starts in ${nextStart} again unless you pass cwd.`]
  if (end.finalCwdUnsaved) {
    notes.push(`${end.finalCwd} belongs to a workspace directory that was not loaded for this call, so nothing written there is saved and it can be replaced when that directory loads. Run commands there with cwd: "${end.finalCwd}".`)
  }
  return notes
}

export function summarize(input: Pick<SandboxExecInput, 'command' | 'argv'>): string {
  const text = input.command ?? input.argv!.join(' ')
  return text.length > 200 ? `${text.slice(0, 200)}…` : text
}
