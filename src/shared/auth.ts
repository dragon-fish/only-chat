import { z } from 'zod'

export const PublicSiteSettingsSchema = z.object({ allowRegister: z.boolean() })
export type PublicSiteSettings = z.infer<typeof PublicSiteSettingsSchema>

export const AdminSiteSettingsSchema = PublicSiteSettingsSchema.extend({ source: z.enum(['db', 'env', 'default']) })
export type AdminSiteSettings = z.infer<typeof AdminSiteSettingsSchema>
export const AdminSiteSettingsUpdateSchema = z.object({ allowRegister: z.boolean().nullable() }).strict()
export type AdminSiteSettingsUpdate = z.infer<typeof AdminSiteSettingsUpdateSchema>

export const AuthRoleSchema = z.enum(['user', 'admin'])
export type AuthRole = z.infer<typeof AuthRoleSchema>

export function isAuthAdmin(user: { id: string | number; role?: string | null } | null): boolean {
  return user !== null && (String(user.id) === '1' || user.role === 'admin')
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
