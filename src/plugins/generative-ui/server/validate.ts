import { createParser, type Parser } from '@openuidev/lang-core'
import { buildLibrary, ROOT_COMPONENT } from '../library'
import type { RenderUiResult } from '../shared'

let compiled: { library: ReturnType<typeof buildLibrary>, parser: Parser } | undefined

/**
 * Built on first use, never at import. `createLibrary` mints its id with `crypto.randomUUID()`, and
 * Workers reject a script that generates random values in global scope — at upload, not in local
 * dev, so a module-level call here passes every local check and then fails the deploy.
 */
export function serverLibrary() {
  if (!compiled) {
    const library = buildLibrary(() => null)
    compiled = { library, parser: createParser(library.toJSONSchema(), ROOT_COMPONENT) }
  }
  return compiled
}

const RENDERED_MESSAGE = 'The UI is now on the user\'s screen. Do not repeat its contents in prose; at most add one or two sentences the UI does not already say.'

/**
 * Parse-level checks only — what the runtime would silently drop. A program that passes still runs
 * its expressions in the browser, where an unknown $variable simply reads as null.
 */
export function validateProgram(code: string): RenderUiResult {
  let result
  try {
    result = serverLibrary().parser.parse(code)
  } catch (error) {
    return invalid([`Parser crashed: ${error instanceof Error ? error.message : String(error)}`])
  }
  const errors: string[] = []
  if (result.meta.incomplete) errors.push('The program is truncated: a string, bracket or parenthesis is not closed.')
  if (!result.root) errors.push(`No renderable root. The program must contain \`root = ${ROOT_COMPONENT}([...])\`.`)
  for (const error of result.meta.errors) {
    const where = [error.statementId && `statement \`${error.statementId}\``, error.component, error.path].filter(Boolean).join(' ')
    errors.push(where ? `${where}: ${error.message}` : error.message)
  }
  if (result.meta.unresolved.length > 0) {
    errors.push(`Referenced but never defined (rendered as nothing): ${result.meta.unresolved.join(', ')}.`)
  }
  if (errors.length > 0) return invalid(errors)
  return { status: 'rendered', message: RENDERED_MESSAGE }
}

function invalid(errors: string[]): RenderUiResult {
  return {
    status: 'invalid',
    message: 'Nothing was shown to the user. Fix every error below and call render_ui again with the whole corrected program.',
    errors,
  }
}
