/**
 * Which nav entry a path belongs to, when one entry's target is a prefix of another's.
 *
 * Plain `startsWith` lights up every ancestor: a plugin's own page under `/settings/plugins/<id>/…`
 * would highlight 插件 as well as itself. The longest matching target is the one the reader is
 * actually looking at.
 */
export function activeNavTarget(path: string, targets: readonly string[]): string | null {
  let best: string | null = null
  for (const target of targets) {
    if (path !== target && !path.startsWith(`${target}/`)) continue
    if (best === null || target.length > best.length) best = target
  }
  return best
}
