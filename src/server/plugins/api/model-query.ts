import { z } from 'zod'
import { ModelQuerySchema, ModelWithMetadataSchema, type ModelPage, type ModelQuery } from '@/shared/models'

export interface ModelCursor { provider_id: number; sort: number; id: number }
const CursorSchema = z.strictObject({ provider_id: z.number().int().positive(), sort: z.number().int(), id: z.number().int().positive() })

export class ModelQueryError extends Error {}

export function buildModelQuery(input: ModelQuery, userId: number) {
  const query = ModelQuerySchema.parse(input)
  const predicates = ['p.user_id = ?']
  const params: (string | number)[] = [userId]
  function filter(sql: string, ...values: (string | number)[]) { predicates.push(sql); params.push(...values) }
  if (query.provider_id !== undefined) filter('m.provider_id = ?', query.provider_id)
  if (query.enabled !== undefined) filter('m.enabled = ?', Number(query.enabled))
  if (query.enabled === true && query.provider_id === undefined) filter('p.enabled = 1')
  if (query.interface_id !== undefined) filter('(m.interface_id = ? OR (m.interface_id IS NULL AND p.default_interface_id = ?))', query.interface_id, query.interface_id)
  if (query.lab_id !== undefined) filter('m.lab_id = ?', query.lab_id)
  for (const [key, column] of [
    ['vision', 'supports_image_input'], ['reasoning', 'supports_reasoning'],
    ['tools', 'supports_tools'], ['image_output', 'supports_image_output'],
  ] as const) {
    if (query[key] !== undefined) filter(`m.${column} = ?`, Number(query[key]))
  }
  if (query.min_context !== undefined) filter('m.context_limit >= ?', query.min_context)
  if (query.search !== undefined) {
    const search = query.search.trim()
    // FTS5 trigram cannot answer shorter strings; never fall back to a full-table LIKE scan.
    if (Array.from(search).length < 3) throw new ModelQueryError('Model search requires at least 3 characters')
    filter('m.id IN (SELECT rowid FROM models_fts WHERE models_fts MATCH ?)', `"${search.replaceAll('"', '""')}"`)
  }
  if (query.cursor) {
    let cursor: ModelCursor
    try { cursor = CursorSchema.parse(JSON.parse(atob(query.cursor))) }
    catch { throw new ModelQueryError('Invalid model cursor') }
    filter('(p.id > ? OR (p.id = ? AND (m.sort > ? OR (m.sort = ? AND m.id > ?))))', cursor.provider_id, cursor.provider_id, cursor.sort, cursor.sort, cursor.id)
  }
  params.push(query.limit + 1)
  return {
    sql: `SELECT m.id, m.provider_id, m.model_id, m.interface_id, m.metadata_resolved, m.metadata_override, m.catalog_matches, m.lab_id, m.enabled, m.manual_pinned, m.upstream_available, m.sort
      FROM models m JOIN providers p ON p.id = m.provider_id
      WHERE ${predicates.join(' AND ')} ORDER BY p.id, m.sort, m.id LIMIT ?`,
    params,
  }
}

export async function queryModels(db: D1Database, input: ModelQuery, userId: number): Promise<ModelPage> {
  const query = buildModelQuery(input, userId)
  const result = await db.prepare(query.sql).bind(...query.params).all<{
    id: number; provider_id: number; model_id: string; interface_id: number | null;
    metadata_resolved: string; metadata_override: string; catalog_matches: string;
    lab_id: string | null; enabled: number; manual_pinned: number; upstream_available: number | null; sort: number;
  }>()
  const selected = result.results.slice(0, input.limit)
  const last = selected.at(-1)
  return {
    models: selected.map(row => ModelWithMetadataSchema.parse({
      id: row.id, provider_id: row.provider_id, model_id: row.model_id, interface_id: row.interface_id,
      metadata: JSON.parse(row.metadata_resolved), metadata_override: JSON.parse(row.metadata_override),
      catalog_matches: JSON.parse(row.catalog_matches), lab_id: row.lab_id, enabled: Boolean(row.enabled),
      manual_pinned: Boolean(row.manual_pinned), upstream_available: row.upstream_available === null ? null : Boolean(row.upstream_available), sort: row.sort,
    })),
    next_cursor: result.results.length > input.limit && last ? btoa(JSON.stringify({ provider_id: last.provider_id, sort: last.sort, id: last.id })) : null,
  }
}
