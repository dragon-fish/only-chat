import { Context, Service } from 'cordis'
import type { ArtifactRunRow } from '@/server/db/schema'
import type { ArtifactUsage } from '@/shared/artifacts'

export interface ImageBackendResult {
  images: Array<{ bytes: Uint8Array<ArrayBuffer>, mime: string }>
  usage?: ArtifactUsage | null
  /** Replaces the run's `backend_state` when present. */
  state?: Record<string, unknown>
}

/**
 * An image source that is not a provider model. It owns the run's `backend_state` and produces
 * bytes; persisting them, the gallery and the task notification stay with the core.
 */
export interface ImageBackend {
  /** The plugin a tool run's task notification is attributed to, which picks its client renderer. */
  pluginId: string
  execute(userId: number, run: ArtifactRunRow): Promise<ImageBackendResult>
  /** What the Agent is told about a completed run; `refs` are the outputs' `asset:` references. */
  completedText?(state: Record<string, unknown> | null, refs: readonly string[]): string
}

/**
 * Loaded on the Worker side as well as the workflow side: cancelling a tool run from the API sends
 * its notification from the Worker, and the notification's plugin id comes from here.
 */
export class ImageBackends extends Service {
  static readonly provide = 'imageBackends'

  private readonly entries = new Map<string, ImageBackend>()

  constructor(ctx: Context) {
    super(ctx, 'imageBackends')
  }

  register(protocol: string, backend: ImageBackend): () => void {
    if (this.entries.has(protocol)) throw new Error(`image backend already registered: ${protocol}`)
    return this.ctx.effect(() => {
      this.entries.set(protocol, backend)
      return () => {
        if (this.entries.get(protocol) === backend) this.entries.delete(protocol)
      }
    }, `imageBackends.register(${protocol})`) as () => void
  }

  get(protocol: string): ImageBackend | undefined {
    return this.entries.get(protocol)
  }
}

export const ImageBackendsPlugin = {
  name: 'image-backends',
  async apply(ctx: Context) {
    await ctx.plugin(ImageBackends)
  },
}
