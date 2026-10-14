/**
 * The start and the end of a stream that may be any size: the head fills once, the tail keeps the
 * latest bytes, and whatever fell between them is only counted. Memory stays bounded however much
 * a command prints; the whole output is in the sandbox's log file.
 */
export class OutputWindow {
  private head = ''
  private headBytes = 0
  private tail: string[] = []
  private tailBytes = 0
  private dropped = 0

  constructor(private readonly headLimit: number, private readonly tailLimit: number) {}

  push(text: string): void {
    let rest = text
    if (this.headBytes < this.headLimit) {
      const [taken, left] = splitAtBytes(rest, this.headLimit - this.headBytes)
      this.head += taken
      this.headBytes += byteLength(taken)
      rest = left
    }
    if (!rest) return
    this.tail.push(rest)
    this.tailBytes += byteLength(rest)
    while (this.tailBytes > this.tailLimit && this.tail.length > 0) {
      const first = this.tail[0]!
      const excess = this.tailBytes - this.tailLimit
      const size = byteLength(first)
      if (size <= excess) {
        this.tail.shift()
        this.tailBytes -= size
        this.dropped += size
      } else {
        const [cut, kept] = splitAfterBytes(first, excess)
        const cutBytes = byteLength(cut)
        this.tail[0] = kept
        this.tailBytes -= cutBytes
        this.dropped += cutBytes
      }
    }
  }

  get truncated(): boolean {
    return this.dropped > 0
  }

  text(): string {
    const tail = this.tail.join('')
    if (!this.truncated) return this.head + tail
    return `${this.head}\n[… ${this.dropped.toLocaleString('en-US')} bytes omitted; the full output is in log_path …]\n${tail}`
  }
}

const encoder = new TextEncoder()

function byteLength(text: string): number {
  return encoder.encode(text).byteLength
}

/** Splits after at most `bytes` UTF-8 bytes, never inside a character. */
function splitAtBytes(text: string, bytes: number): [string, string] {
  if (bytes <= 0) return ['', text]
  let used = 0
  let index = 0
  for (const char of text) {
    const size = byteLength(char)
    if (used + size > bytes) break
    used += size
    index += char.length
  }
  return [text.slice(0, index), text.slice(index)]
}

/** Splits after at least `bytes` UTF-8 bytes, rounding up to a whole character so a cut is never empty. */
function splitAfterBytes(text: string, bytes: number): [string, string] {
  let used = 0
  let index = 0
  for (const char of text) {
    if (used >= bytes) break
    used += byteLength(char)
    index += char.length
  }
  return [text.slice(0, index), text.slice(index)]
}

/** Turns arbitrary chunks into whole lines for the live card; a trailing partial line waits for `flush`. */
export class LineBuffer {
  private partial = ''

  push(text: string): string[] {
    const parts = (this.partial + text).split('\n')
    this.partial = parts.pop() ?? ''
    return parts
  }

  flush(): string[] {
    const rest = this.partial
    this.partial = ''
    return rest ? [rest] : []
  }
}
