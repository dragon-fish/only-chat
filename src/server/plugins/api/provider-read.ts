import type { Context } from 'cordis'
import { and, eq } from 'drizzle-orm'
import { DEFAULT_USER_ID } from '@/shared/constants'
import { ProviderWithInterfacesSchema } from '@/shared/models'
import { providerInterfaces, providerOAuthCredentials, providers } from '../../db/schema'
import { toProviderDto } from './provider-write'

async function readProviderDtos(ctx: Context, providerId?: number) {
  const db = ctx.db.orm
  const owned = and(eq(providers.user_id, DEFAULT_USER_ID), providerId === undefined ? undefined : eq(providers.id, providerId))
  const rows = await db.select({
    provider: providers,
    oauth: {
      status: providerOAuthCredentials.status,
      account_email: providerOAuthCredentials.account_email,
      access_expires_at: providerOAuthCredentials.access_expires_at,
      last_error: providerOAuthCredentials.last_error,
    },
  }).from(providers).leftJoin(providerOAuthCredentials, and(
    eq(providerOAuthCredentials.provider_id, providers.id), eq(providers.kind, 'codex-oauth'),
  )).where(owned).orderBy(providers.id)
  const endpoints = await db.select({ interface: providerInterfaces }).from(providerInterfaces)
    .innerJoin(providers, eq(providers.id, providerInterfaces.provider_id)).where(owned).orderBy(providerInterfaces.id)
  return rows.map(({ provider: row, oauth }) => {
    const interfaces = endpoints.filter(endpoint => endpoint.interface.provider_id === row.id).map(endpoint => endpoint.interface)
    if (row.kind === 'custom') return toProviderDto(row, interfaces)
    return ProviderWithInterfacesSchema.parse({
      id: row.id, user_id: row.user_id, name: row.name, kind: row.kind, enabled: row.enabled, has_key: false,
      default_interface_id: row.default_interface_id, credential_version: row.credential_version,
      models_dev_provider_id: row.models_dev_provider_id, models_dev_provider_source: row.models_dev_provider_source,
      interfaces, created_at: row.created_at, oauth,
    })
  })
}

export async function readProviderDto(ctx: Context, providerId: number) {
  return (await readProviderDtos(ctx, providerId))[0] ?? null
}

export async function listProviderDtos(ctx: Context) {
  return readProviderDtos(ctx)
}
