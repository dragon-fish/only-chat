import { z } from 'zod'

/** `GET /api/site-config`: every site-wide setting in one response. */
export interface SiteConfig {
  allowRegister: boolean
  /** Present only for the owner: whether the deployment enables the owner audit pages. */
  audit?: boolean
}

export const AdminSiteSettingsSchema = z.object({ allowRegister: z.boolean(), source: z.enum(['db', 'env', 'default']) })
export type AdminSiteSettings = z.infer<typeof AdminSiteSettingsSchema>
export const AdminSiteSettingsUpdateSchema = z.object({ allowRegister: z.boolean().nullable() }).strict()
export type AdminSiteSettingsUpdate = z.infer<typeof AdminSiteSettingsUpdateSchema>

export const AuthRoleSchema = z.enum(['user', 'admin'])
export type AuthRole = z.infer<typeof AuthRoleSchema>

/** The first account is the site owner: Better Auth's `adminUserIds` and every owner-only surface key on it. */
export const OWNER_USER_ID = '1'

export function isAuthOwner(user: { id: string | number } | null): boolean {
  return user !== null && String(user.id) === OWNER_USER_ID
}

export function isAuthAdmin(user: { id: string | number; role?: string | null } | null): boolean {
  return isAuthOwner(user) || user?.role === 'admin'
}

export const AdminCreateUserSchema = z.object({
  name: z.string().trim().min(1), email: z.email(), password: z.string().min(8).max(128), role: AuthRoleSchema.optional(),
}).strict()
export const AdminSetRoleSchema = z.object({ userId: z.coerce.string(), role: AuthRoleSchema }).strict()

export const AuthUserSummarySchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  email: z.string(),
  image: z.string().nullable(),
  role: z.enum(['user', 'admin']),
})
export type AuthUserSummary = z.infer<typeof AuthUserSummarySchema>

export const AdminUserSummarySchema = AuthUserSummarySchema.extend({
  banned: z.boolean(),
  banReason: z.string().nullable(),
  banExpires: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type AdminUserSummary = z.infer<typeof AdminUserSummarySchema>
