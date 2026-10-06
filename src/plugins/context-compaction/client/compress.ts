import type { SlashCommand } from '@/client/plugins/host'
import { compactTokenCount } from '@/client/lib/ui-models'
import type { CheckpointPart } from '@/shared/parts'
import type { CompactionCommand, CompactionData, CompactionEvent } from '../shared'

/** Summarizing a long conversation is one model call; past this, the answer is not coming. */
export const COMPRESS_TIMEOUT_MS = 5 * 60_000

type ResultEvent = Extract<CompactionEvent, { type: 'compress.result' }>
type NoticeEvent = Extract<CompactionEvent, { type: 'notice' }>

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

export function asResultEvent(payload: unknown): ResultEvent | null {
  if (!isRecord(payload) || payload.type !== 'compress.result' || typeof payload.requestId !== 'string') return null
  if (payload.ok === true) return { type: 'compress.result', requestId: payload.requestId, ok: true }
  return { type: 'compress.result', requestId: payload.requestId, ok: false, error: typeof payload.error === 'string' ? payload.error : '压缩失败' }
}

export function asNoticeEvent(payload: unknown): NoticeEvent | null {
  if (!isRecord(payload) || payload.type !== 'notice' || typeof payload.message !== 'string') return null
  if (typeof payload.conversationId !== 'number' || (payload.kind !== 'failed' && payload.kind !== 'ineffective')) return null
  return { type: 'notice', conversationId: payload.conversationId, kind: payload.kind, message: payload.message }
}

/**
 * `/compress [重点说明]` (spec context-compaction §3.7): asks the server half for a checkpoint
 * under the current head and settles with its `compress.result`. The checkpoint itself arrives as
 * an ordinary new message; this only reports whether one was written.
 */
export function createCompressCommand({
  timeoutMs = COMPRESS_TIMEOUT_MS,
  newRequestId = () => crypto.randomUUID(),
}: { timeoutMs?: number, newRequestId?: () => string } = {}): SlashCommand {
  return {
    enabled(ctx) {
      if (ctx.conversationId === null) return '会话还没开始'
      if (ctx.streaming) return '生成中不可用'
      if (ctx.compacting) return '正在压缩上下文'
      return true
    },
    run(ctx, args) {
      const conversationId = ctx.conversationId
      if (conversationId === null) return Promise.reject(new Error('会话还没开始'))
      const requestId = newRequestId()
      return new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined
        let off = () => {}
        const finish = (error?: Error) => {
          clearTimeout(timer)
          off()
          if (error) reject(error)
          else resolve()
        }
        // Subscribed before sending: a fast answer must not arrive with nobody listening.
        off = ctx.on((payload) => {
          const result = asResultEvent(payload)
          if (!result || result.requestId !== requestId) return
          finish(result.ok ? undefined : new Error(result.error))
        })
        timer = setTimeout(() => finish(new Error('压缩超时，没有收到服务端的结果')), timeoutMs)
        const command: CompactionCommand = { type: 'compress', requestId, conversationId, focus: args.trim() || null }
        if (!ctx.send(command)) finish(new Error('未连接'))
      })
    },
  }
}

/** This plugin's data on a checkpoint, or null when it does not have the shape this build writes. */
export function compactionDataOf(checkpoint: CheckpointPart): CompactionData | null {
  const data = checkpoint.data
  if (!isRecord(data) || typeof data.summary !== 'string' || typeof data.tokensBefore !== 'number') return null
  return data as unknown as CompactionData
}

export function checkpointLabel(data: CompactionData | null): string {
  return data ? `上下文已压缩 · 约 ${compactTokenCount(data.tokensBefore)} token` : '上下文已压缩'
}
