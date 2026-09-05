import { and, desc, eq } from 'drizzle-orm'
import type { DB } from '../../db/client'
import { projects, sessions } from '../../db/schema'
import type { ProjectRow, SessionRow } from '../../db/schema'

/** Every read and write is scoped to the owning user; D1 is the source of truth (spec §5.1). */

export async function listProjects(db: DB, userId: number): Promise<ProjectRow[]> {
  return db.select().from(projects).where(eq(projects.user_id, userId)).orderBy(desc(projects.updated_at))
}

export async function getProject(db: DB, id: number, userId: number): Promise<ProjectRow | undefined> {
  return db.query.projects.findFirst({ where: and(eq(projects.id, id), eq(projects.user_id, userId)) })
}

export async function createProject(
  db: DB,
  input: Pick<ProjectRow, 'user_id' | 'name'> & Partial<Pick<ProjectRow, 'system_prompt' | 'provider_id' | 'model_id' | 'params'>>,
): Promise<ProjectRow> {
  const now = Date.now()
  const [row] = await db.insert(projects).values({
    user_id: input.user_id,
    name: input.name,
    system_prompt: input.system_prompt ?? null,
    provider_id: input.provider_id ?? null,
    model_id: input.model_id ?? null,
    params: input.params ?? null,
    created_at: now,
    updated_at: now,
  }).returning()
  return row!
}

export async function updateProject(
  db: DB,
  id: number,
  userId: number,
  patch: Partial<Pick<ProjectRow, 'name' | 'system_prompt' | 'provider_id' | 'model_id' | 'params'>>,
): Promise<ProjectRow> {
  const [row] = await db.update(projects).set({ ...patch, updated_at: Date.now() })
    .where(and(eq(projects.id, id), eq(projects.user_id, userId))).returning()
  if (!row) throw new Error(`project ${id} not found`)
  return row
}

/** Sessions keep existing: the `ON DELETE SET NULL` foreign key moves them back to Chats (spec §3.1). */
export async function deleteProject(db: DB, id: number, userId: number): Promise<void> {
  await db.delete(projects).where(and(eq(projects.id, id), eq(projects.user_id, userId)))
}

export async function listProjectSessions(db: DB, projectId: number, userId: number): Promise<SessionRow[]> {
  return db.select().from(sessions)
    .where(and(eq(sessions.project_id, projectId), eq(sessions.user_id, userId)))
    .orderBy(desc(sessions.updated_at))
}
