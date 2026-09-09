import { createAuthClient } from 'better-auth/vue'
import { adminClient } from 'better-auth/client/plugins'

export const authClient = createAuthClient({ basePath: '/api/auth', plugins: [adminClient()] })

export type AuthSession = typeof authClient.$Infer.Session
export type AuthUser = AuthSession['user']

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('code' in error)) return null
  return typeof error.code === 'string' ? error.code.toUpperCase() : null
}

export function authErrorMessage(error: unknown, action: 'login' | 'register'): string {
  const code = errorCode(error)
  if (code === 'INVALID_EMAIL_OR_PASSWORD' || code === 'INVALID_PASSWORD') return '邮箱或密码不正确'
  if (code === 'USER_ALREADY_EXISTS' || code === 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL') return '该邮箱已注册'
  if (code === 'REGISTRATION_CLOSED') return '注册未开放'
  return action === 'login' ? '登录失败，请稍后重试' : '注册失败，请稍后重试'
}
