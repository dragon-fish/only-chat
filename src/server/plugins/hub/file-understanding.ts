import { generateText } from 'ai'
import type { UserSettings } from '@/shared/models'
import { canServeAsFileModel } from '@/shared/service-model'
import { canReadFile, attachmentFilename } from '@/shared/file-media'
import { SERVICE_PROMPT_DEFAULTS } from '@/shared/service-prompts'
import { resolveServiceModel } from './service-model'
import { resolveAttachmentInputs, type TransportDeps } from './attachment-transport'
import { buildProviderOptions } from '../llm/messages'

export interface FileUnderstanding {
  canRead(mime: string): boolean
  analyze(attachmentId: number, question: string | undefined, signal: AbortSignal): Promise<{
    model: { provider_id: number, model_id: string }
    text: string
    truncated: boolean
  }>
}

/** Resolve once per generation, including the prompt; a mid-turn settings edit applies next turn. */
export async function resolveFileUnderstanding(deps: TransportDeps, settings: UserSettings): Promise<FileUnderstanding | undefined> {
  const resolved = await resolveServiceModel(deps.db, deps.userId, settings, { slot: 'file_understanding', accepts: canServeAsFileModel })
  if (!resolved) return
  const { provider, providerInterface: iface, model } = resolved
  const ref = { provider_id: provider.id, model_id: model.model_id }
  const system = settings.service_prompts?.file_understanding ?? SERVICE_PROMPT_DEFAULTS.file_understanding
  const canRead = (mime: string) => canReadFile(model.metadata_resolved, iface.protocol, mime)
  return {
    canRead,
    async analyze(attachmentId, question, signal) {
      signal.throwIfAborted()
      const inputs = await resolveAttachmentInputs({ ...deps, signal }, provider, iface, [attachmentId], mime => canRead(mime) ? undefined : 'Unsupported file type')
      const file = inputs.get(attachmentId)!
      if ('unavailable' in file) throw new Error(file.unavailable)
      signal.throwIfAborted()
      const result = await generateText({
        model: await deps.llm.createModel(provider, iface, model),
        system,
        messages: [{ role: 'user', content: [
          { type: 'file', mediaType: file.mime, data: file.data, filename: attachmentFilename(attachmentId, file.mime) },
          ...(question ? [{ type: 'text' as const, text: question }] : []),
        ] }],
        providerOptions: buildProviderOptions(iface.protocol, { reasoning_enabled: false }, model.metadata_resolved),
        abortSignal: signal,
      })
      if (!result.text.trim()) throw new Error('File analysis returned no text')
      return { model: ref, text: result.text, truncated: result.finishReason === 'length' }
    },
  }
}
