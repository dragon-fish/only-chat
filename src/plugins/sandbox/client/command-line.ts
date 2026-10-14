const SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/

/** One argv element as a POSIX shell would need it written; display only, never executed. */
export function shellQuote(arg: string): string {
  if (arg === '') return "''"
  if (SAFE.test(arg)) return arg
  return `'${arg.replaceAll("'", "'\\''")}'`
}

export function argvToCommandLine(argv: readonly string[]): string {
  return argv.map(shellQuote).join(' ')
}
