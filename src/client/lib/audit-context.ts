import { inject, provide, type InjectionKey } from 'vue'
import { api } from '@/client/lib/api'
import type { AuditProvider, ModelRef } from '@/shared/api'

export interface AuditModel { name: string | null, providerName: string, labId: string | null, family: string | null }

/**
 * Present while the owner reads another account's transcript. Message components under it render
 * no control that writes, and resolve images and models against the audited account instead of
 * the viewer's own.
 */
export interface AuditContext {
  attachmentUrl(id: number): string
  resolveModel(model: ModelRef): AuditModel | undefined
}

const AUDIT_CONTEXT: InjectionKey<AuditContext> = Symbol('audit-context')

/** `providers` is read on every lookup, so a reactive source that loads later still resolves names. */
export function createAuditContext(userId: number, providers: () => readonly AuditProvider[]): AuditContext {
  return {
    attachmentUrl: id => api.auditAttachmentUrl(userId, id),
    resolveModel(model) {
      const provider = providers().find(item => item.id === model.provider_id)
      if (!provider) return undefined
      const found = provider.models.find(item => item.model_id === model.model_id)
      return { name: found?.name ?? null, providerName: provider.name, labId: found?.lab_id ?? null, family: found?.family ?? null }
    },
  }
}

export function provideAuditContext(context: AuditContext): void {
  provide(AUDIT_CONTEXT, context)
}

export function useAuditContext(): AuditContext | null {
  return inject(AUDIT_CONTEXT, null)
}

/** Every attachment `<img>` inside a message goes through this, so an audited transcript loads the audited account's bytes. */
export function useAttachmentUrl(): (id: number) => string {
  return useAuditContext()?.attachmentUrl ?? api.attachmentUrl
}
