import { d1Args, escapeSqlLiteral, readResults, runWrangler } from './lib/d1'

/**
 * A one-off repair, not a migration.
 *
 * For a short while, something the operator said mid-turn was stored as a part inside the
 * assistant's own message. That was the wrong shape: it is their message, and the records should
 * say so — a reply, their message, another reply — which is what the code writes now.
 *
 * Nothing reads the old shape any more. Rather than carry a fallback for a handful of rows, the
 * rows are moved to the shape everything expects.
 *
 * Each affected message becomes three: what was said before the interruption stays where it is,
 * what the operator said becomes a user message beneath it, and what followed becomes a new reply
 * beneath that. Runs with several interjections split repeatedly, last one first, so the ids of
 * the earlier splits are still valid when they are used.
 *
 *   pnpm tsx scripts/split-interjection-parts.ts [--remote] [--apply]
 *
 * Prints what it would do unless `--apply` is passed. Safe to run twice: a message with no
 * interjection part left in it is not selected.
 */

interface Row {
  id: number
  conversation_id: number
  parent_id: number | null
  seq: number
  provider_id: number | null
  model_id: string | null
  status: string
  created_at: number
  parts: string
}

type Part = { type: string, parts?: unknown[] }

const remote = process.argv.includes('--remote')
const apply = process.argv.includes('--apply')

function sql(statement: string): Promise<string> {
  return runWrangler([...d1Args(remote ? 'remote' : 'local'), '--command', statement])
}

async function query<T>(statement: string): Promise<T[]> {
  return readResults(await sql(statement)) as T[]
}

/** The split points, latest first: an earlier split must not move rows a later one still refers to. */
function interjectionIndexes(parts: Part[]): number[] {
  return parts.flatMap((part, index) => (part.type === 'interjection' ? [index] : []))
    .sort((a, b) => b - a)
}

async function splitOnce(row: Row, at: number, nextSeq: number): Promise<number> {
  const parts = JSON.parse(row.parts) as Part[]
  const before = parts.slice(0, at)
  const said = (parts[at]!.parts ?? []) as unknown[]
  const after = parts.slice(at + 1)

  const statements = [
    // The operator's words, as their own message, under the reply they interrupted.
    `INSERT INTO messages (conversation_id, parent_id, seq, role, parts, provider_id, model_id, usage, status, error, created_at)
     VALUES (${row.conversation_id}, ${row.id}, ${nextSeq}, 'user', ${escapeSqlLiteral(JSON.stringify(said))},
             NULL, NULL, NULL, 'done', NULL, ${row.created_at});`,
  ]

  if (!apply) {
    console.log(`  message ${row.id}: keep ${before.length} parts, user message of ${said.length}, then ${after.length} parts`)
    return nextSeq
  }

  await sql(statements[0]!)
  const [user] = await query<{ id: number }>('SELECT last_insert_rowid() AS id;')
  const userId = user!.id

  // The rest of the reply, continuing beneath what they said.
  await sql(`INSERT INTO messages (conversation_id, parent_id, seq, role, parts, provider_id, model_id, usage, status, error, created_at)
     VALUES (${row.conversation_id}, ${userId}, ${nextSeq + 1}, 'assistant', ${escapeSqlLiteral(JSON.stringify(after))},
             ${row.provider_id ?? 'NULL'}, ${row.model_id === null ? 'NULL' : escapeSqlLiteral(row.model_id)},
             NULL, ${escapeSqlLiteral(row.status)}, NULL, ${row.created_at});`)
  const [tail] = await query<{ id: number }>('SELECT last_insert_rowid() AS id;')
  const tailId = tail!.id

  // Anything that hung from the original now hangs from its tail, the conversation head included.
  await sql(`UPDATE messages SET parent_id = ${tailId} WHERE parent_id = ${row.id} AND id <> ${userId};`)
  await sql(`UPDATE conversations SET head_message_id = ${tailId} WHERE id = ${row.conversation_id} AND head_message_id = ${row.id};`)
  await sql(`UPDATE messages SET parts = ${escapeSqlLiteral(JSON.stringify(before))} WHERE id = ${row.id};`)
  console.log(`  message ${row.id} → ${row.id} / user ${userId} / assistant ${tailId}`)
  return nextSeq + 2
}

const affected = await query<Row>(`
  SELECT id, conversation_id, parent_id, seq, provider_id, model_id, status, created_at, parts
    FROM messages
   WHERE role = 'assistant' AND parts LIKE '%"interjection"%'
   ORDER BY id;`)

console.log(`${affected.length} message(s) to split${apply ? '' : ' (dry run; pass --apply)'}`)

for (const row of affected) {
  const [max] = await query<{ n: number | null }>(
    `SELECT MAX(seq) AS n FROM messages WHERE conversation_id = ${row.conversation_id};`,
  )
  let seq = (max?.n ?? row.seq) + 1
  for (const at of interjectionIndexes(JSON.parse(row.parts) as Part[])) {
    seq = await splitOnce(row, at, seq)
  }
}
