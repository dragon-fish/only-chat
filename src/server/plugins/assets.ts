import { Context, Service } from 'cordis'

export interface StoredBytes {
  bytes: Uint8Array
  mime: string
}

export interface StoredStream {
  body: ReadableStream
  mime: string
  size: number
}

export class Assets extends Service {
  static readonly provide = 'assets'
  static readonly inject = ['env']

  private readonly _bucket: R2Bucket

  constructor(ctx: Context) {
    super(ctx, 'assets')
    this._bucket = ctx.env.BUCKET
  }

  async put(key: string, bytes: Uint8Array | ArrayBuffer, mime: string): Promise<void> {
    await this._bucket.put(key, bytes, { httpMetadata: { contentType: mime } })
  }

  /** Undoes a write whose attachment row never landed, so no object is left without an owner. */
  async delete(key: string): Promise<void> {
    await this._bucket.delete(key)
  }

  async exists(key: string): Promise<boolean> {
    return (await this._bucket.head(key)) !== null
  }

  async getBytes(key: string): Promise<StoredBytes | null> {
    const obj = await this._bucket.get(key)
    if (!obj) return null
    return { bytes: new Uint8Array(await obj.arrayBuffer()), mime: obj.httpMetadata?.contentType ?? 'application/octet-stream' }
  }

  async getStream(key: string): Promise<StoredStream | null> {
    const obj = await this._bucket.get(key)
    if (!obj) return null
    return { body: obj.body, mime: obj.httpMetadata?.contentType ?? 'application/octet-stream', size: obj.size }
  }
}
