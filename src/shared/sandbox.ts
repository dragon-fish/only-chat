/** Sandbox limits and choices both the plugin's client and the `Sandbox` Durable Object read. */

export const INSTANCE_TYPES = ['standard-1', 'standard-2', 'standard-3', 'standard-4'] as const
export type InstanceType = (typeof INSTANCE_TYPES)[number]

export const MAX_COMMAND_BYTES = 32 * 1024
export const MAX_STDIN_BYTES = 1024 * 1024
export const MAX_TIMEOUT_MS = 600_000
