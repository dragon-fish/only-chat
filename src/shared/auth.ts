import { z } from 'zod'

export const PublicSiteSettingsSchema = z.object({ allowRegister: z.boolean() })
export type PublicSiteSettings = z.infer<typeof PublicSiteSettingsSchema>

export const AdminSiteSettingsSchema = PublicSiteSettingsSchema.extend({ source: z.enum(['db', 'env', 'default']) })
export type AdminSiteSettings = z.infer<typeof AdminSiteSettingsSchema>

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
