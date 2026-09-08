export interface CodexTokenBundle {
  idToken: string
  accessToken: string
  refreshToken: string
  tokenType: string
  accountId: string
  email: string
  expiresAt: number
}

export interface CodexIdentity {
  accountId: string
  email: string
}

export interface CodexDeviceGrant {
  deviceAuthId: string
  userCode: string
  verificationUrl: string
  intervalMs: number
  expiresAt: number
}

export type CodexDevicePoll =
  | { status: 'pending' }
  | { status: 'authorized'; authorizationCode: string; codeVerifier: string; codeChallenge: string }

export type CodexProtocolErrorCategory = 'permanent' | 'transient' | 'upstream'

/** A sanitized upstream failure that is safe to persist or surface to application code. */
export class CodexProtocolError extends Error {
  constructor(
    readonly operation: string,
    readonly category: CodexProtocolErrorCategory,
    readonly status: number | null,
  ) {
    super(`Codex ${operation} failed${status === null ? '' : ` (${status})`}`)
    this.name = 'CodexProtocolError'
  }
}
