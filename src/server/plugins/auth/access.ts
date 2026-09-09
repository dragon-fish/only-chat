import { createAccessControl } from 'better-auth/plugins/access'

export const authAccess = createAccessControl({
  user: ['create', 'list', 'set-role', 'ban', 'set-password'],
  session: ['list', 'revoke'],
} as const)

export const authRoles = {
  admin: authAccess.newRole({ user: ['create', 'list', 'set-role', 'ban', 'set-password'], session: ['list', 'revoke'] }),
  user: authAccess.newRole({ user: [], session: [] }),
}

// adminUserIds bypasses Better Auth permission checks. Enforce this HTTP boundary for every user.
export const adminEndpoints = new Set([
  'GET /api/auth/admin/list-users',
  ...['create-user', 'set-role', 'ban-user', 'unban-user', 'set-user-password', 'list-user-sessions', 'revoke-user-session', 'revoke-user-sessions']
    .map(endpoint => `POST /api/auth/admin/${endpoint}`),
])
