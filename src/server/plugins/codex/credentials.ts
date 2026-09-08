import { and, eq, exists, sql } from 'drizzle-orm'
import type { DB } from '@/server/db/client'
import { providerInterfaces, providerOAuthCredentials, providers } from '@/server/db/schema'
import { DEFAULT_USER_ID } from '@/shared/constants'
import { decryptJson, encryptJson } from '../llm/crypto'
import { CODEX_API_BASE_URL } from './constants'
import type { CodexTokenBundle } from './types'

export type CodexCredentialSnapshot = {
  providerId: number
  revision: number
  credentialVersion: number
  accountId: string
} & (
  | { status: 'connected' | 'reconnect-required'; bundle: CodexTokenBundle; encryptedBundle: string }
  | { status: 'disconnected'; bundle: null; encryptedBundle: null }
)

function conflict(): Error {
  return new Error('Codex credentials changed concurrently; reload and retry')
}

function isDuplicateAccount(error: unknown): boolean {
  let cause = error
  while (cause instanceof Error) {
    if (cause.message.includes('NOT NULL constraint failed: providers.name')) return true
    cause = cause.cause
  }
  return false
}

export class CodexCredentialStore {
  constructor(readonly db: DB, readonly encryptionSecret: string) {}

  private ownedProvider(providerId: number) {
    return and(eq(providers.id, providerId), eq(providers.user_id, DEFAULT_USER_ID), eq(providers.kind, 'codex-oauth'))
  }

  private async row(providerId: number) {
    const [row] = await this.db.select({ credential: providerOAuthCredentials, credentialVersion: providers.credential_version })
      .from(providerOAuthCredentials).innerJoin(providers, eq(providers.id, providerOAuthCredentials.provider_id))
      .where(this.ownedProvider(providerId))
    return row
  }

  async read(providerId: number): Promise<CodexCredentialSnapshot | null> {
    const row = await this.row(providerId)
    if (!row) return null
    const credential = row.credential
    const common = { providerId, revision: credential.revision, credentialVersion: row.credentialVersion, accountId: credential.account_id }
    if (credential.status === 'disconnected') return { ...common, status: 'disconnected', bundle: null, encryptedBundle: null }
    return {
      ...common, status: credential.status, encryptedBundle: credential.encrypted_bundle!,
      bundle: await decryptJson<CodexTokenBundle>(this.encryptionSecret, credential.encrypted_bundle!),
    }
  }

  async createProvider(bundle: CodexTokenBundle, now: number): Promise<number> {
    const encrypted = await encryptJson(this.encryptionSecret, bundle)
    const duplicate = this.db.select({ id: providers.id }).from(providers)
      .innerJoin(providerOAuthCredentials, eq(providerOAuthCredentials.provider_id, providers.id))
      .where(and(eq(providers.user_id, DEFAULT_USER_ID), eq(providers.kind, 'codex-oauth'), eq(providerOAuthCredentials.account_id, bundle.accountId)))
    // The guard is inside the transaction: overlapping UserHub calls cannot both create an account.
    // MAX(id) refers to the just-inserted AUTOINCREMENT provider only within this single D1 batch.
    const providerId = sql<number>`(SELECT MAX(id) FROM providers)`
    try {
      const [created] = await this.db.batch([
        this.db.insert(providers).values({
          user_id: DEFAULT_USER_ID, kind: 'codex-oauth', created_at: now,
          name: sql`CASE WHEN ${exists(duplicate)} THEN NULL ELSE ${`Codex · ${bundle.email}`} END`,
        }).returning({ id: providers.id }),
        this.db.insert(providerInterfaces).values({ provider_id: providerId, protocol: 'responses', base_url: CODEX_API_BASE_URL, native_files: false, created_at: now }),
        this.db.insert(providerOAuthCredentials).values({
          provider_id: providerId, status: 'connected', encrypted_bundle: encrypted,
          account_id: bundle.accountId, account_email: bundle.email, access_expires_at: bundle.expiresAt, updated_at: now,
        }),
        this.db.update(providers).set({
          default_interface_id: sql`(SELECT id FROM provider_interfaces WHERE provider_id = ${providerId} AND protocol = 'responses')`,
        }).where(eq(providers.id, providerId)),
      ])
      return created[0]!.id
    } catch (error) {
      if (isDuplicateAccount(error)) throw new Error('This Codex account already has a provider')
      // Drizzle errors can contain bound ciphertext and private account data; keep them server-only.
      throw new Error('Codex credential creation failed')
    }
  }

  private cas(providerId: number, revision: number, encryptedBundle: string | null) {
    return and(
      eq(providerOAuthCredentials.provider_id, providerId), eq(providerOAuthCredentials.revision, revision),
      sql`${providerOAuthCredentials.encrypted_bundle} IS ${encryptedBundle}`,
      exists(this.db.select({ id: providers.id }).from(providers).where(this.ownedProvider(providerId))),
    )
  }

  async reconnect(providerId: number, expectedRevision: number, bundle: CodexTokenBundle, now: number): Promise<void> {
    const row = await this.row(providerId)
    if (!row) throw new Error('Codex provider not found')
    if (row.credential.revision !== expectedRevision) throw conflict()
    if (row.credential.account_id !== bundle.accountId) throw new Error('Reconnect must use the same Codex account')
    const encrypted = await encryptJson(this.encryptionSecret, bundle)
    const predicate = this.cas(providerId, expectedRevision, row.credential.encrypted_bundle)
    const [, updated] = await this.db.batch([
      this.db.update(providers).set({ credential_version: sql`${providers.credential_version} + 1` })
        .where(and(this.ownedProvider(providerId), exists(this.db.select().from(providerOAuthCredentials).where(predicate)))),
      this.db.update(providerOAuthCredentials).set({
        status: 'connected', encrypted_bundle: encrypted, account_email: bundle.email, access_expires_at: bundle.expiresAt,
        revision: sql`${providerOAuthCredentials.revision} + 1`, last_error: null, updated_at: now,
      }).where(predicate).returning({ id: providerOAuthCredentials.provider_id }),
    ]).catch(() => { throw new Error('Codex credential reconnect failed') })
    if (updated.length === 0) throw conflict()
  }

  async storeRefresh(snapshot: CodexCredentialSnapshot, bundle: CodexTokenBundle, now: number): Promise<boolean> {
    if (snapshot.status !== 'connected') return false
    if (bundle.accountId !== snapshot.accountId) throw new Error('Refresh must use the same Codex account')
    const encrypted = await encryptJson(this.encryptionSecret, bundle)
    const updated = await this.db.update(providerOAuthCredentials).set({
      encrypted_bundle: encrypted, account_email: bundle.email, access_expires_at: bundle.expiresAt,
      revision: sql`${providerOAuthCredentials.revision} + 1`, last_error: null, updated_at: now,
    }).where(and(this.cas(snapshot.providerId, snapshot.revision, snapshot.encryptedBundle), eq(providerOAuthCredentials.status, 'connected')))
      .returning({ id: providerOAuthCredentials.provider_id })
      .catch(() => { throw new Error('Codex credential refresh persistence failed') })
    return updated.length > 0
  }

  /** message must be a sanitized application error, never an upstream response body. */
  async markReconnectRequired(snapshot: CodexCredentialSnapshot, message: string, now: number): Promise<boolean> {
    if (snapshot.status !== 'connected') return false
    const updated = await this.db.update(providerOAuthCredentials).set({
      status: 'reconnect-required', last_error: message, revision: sql`${providerOAuthCredentials.revision} + 1`, updated_at: now,
    }).where(and(this.cas(snapshot.providerId, snapshot.revision, snapshot.encryptedBundle), eq(providerOAuthCredentials.status, 'connected')))
      .returning({ id: providerOAuthCredentials.provider_id })
      .catch(() => { throw new Error('Codex credential failure persistence failed') })
    return updated.length > 0
  }

  async disconnect(providerId: number, expectedRevision: number, now: number): Promise<boolean> {
    const row = await this.row(providerId)
    if (!row || row.credential.revision !== expectedRevision || row.credential.status === 'disconnected') return false
    const predicate = this.cas(providerId, expectedRevision, row.credential.encrypted_bundle)
    const [, updated] = await this.db.batch([
      this.db.update(providers).set({ credential_version: sql`${providers.credential_version} + 1` })
        .where(and(this.ownedProvider(providerId), exists(this.db.select().from(providerOAuthCredentials).where(predicate)))),
      this.db.update(providerOAuthCredentials).set({
        status: 'disconnected', encrypted_bundle: null, access_expires_at: null, last_error: null,
        revision: sql`${providerOAuthCredentials.revision} + 1`, updated_at: now,
      }).where(predicate).returning({ id: providerOAuthCredentials.provider_id }),
    ]).catch(() => { throw new Error('Codex credential disconnect failed') })
    return updated.length > 0
  }
}
