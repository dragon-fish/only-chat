import { z } from 'zod'
import { INSTANCE_TYPES, MAX_COMMAND_BYTES, MAX_STDIN_BYTES, MAX_TIMEOUT_MS } from '@/shared/sandbox'

export const SANDBOX_PLUGIN_ID = 'sandbox' as const
export const SANDBOX_EXEC_TOOL_ID = 'sandbox_exec' as const
export const SANDBOX_IMPORT_TOOL_ID = 'sandbox_import' as const
export const SANDBOX_EXPORT_TOOL_ID = 'sandbox_export' as const

export const DEFAULT_TIMEOUT_MS = 120_000
export const DEFAULT_IDLE_MINUTES = 10
/** Each stream keeps this much of its start and of its end in the result; the rest is in the log. */
export const RESULT_HEAD_BYTES = 4 * 1024
export const RESULT_TAIL_BYTES = 16 * 1024
/** How much of a finished job's log its notification quotes. */
export const NOTIFICATION_TAIL_BYTES = 4 * 1024

// ---- plugin configuration

export const SANDBOX_CONFIG_SCHEMA = z.object({
  instance_type: z.enum(INSTANCE_TYPES).default('standard-1'),
  idle_minutes: z.number().int().min(5).max(120).default(DEFAULT_IDLE_MINUTES),
  default_timeout_ms: z.number().int().min(1_000).max(MAX_TIMEOUT_MS).default(DEFAULT_TIMEOUT_MS),
})
export type SandboxConfig = z.infer<typeof SANDBOX_CONFIG_SCHEMA>

// ---- tool contracts

/**
 * Two optional fields rather than `string | string[]`: some providers' strict modes handle `anyOf`
 * badly. The tool rejects a call that sets both or neither.
 */
export const SandboxExecInputSchema = z.object({
  command: z.string().min(1).max(MAX_COMMAND_BYTES).optional()
    .describe('A shell command run with `bash -lc`: pipes, redirection, && and globs work. Set this or argv, not both.'),
  argv: z.array(z.string()).min(1).optional()
    .describe('A program and its arguments, passed as-is with no shell parsing, so nothing needs quoting or escaping. Set this or command, not both.'),
  stdin: z.string().max(MAX_STDIN_BYTES).optional()
    .describe('Text written to the process\'s standard input. With argv ["tee", "path"] it writes a file exactly as given.'),
  cwd: z.string().min(1).optional()
    .describe('Absolute working directory. Defaults to this conversation\'s workspace directory.'),
  timeout_ms: z.number().int().min(1_000).max(MAX_TIMEOUT_MS).optional()
    .describe(`Foreground time limit in milliseconds, at most ${MAX_TIMEOUT_MS}. Ignored with background.`),
  background: z.boolean().optional()
    .describe('Start the command and return at once; its outcome arrives later as a <task-notification>.'),
})
export type SandboxExecInput = z.infer<typeof SandboxExecInputSchema>

export interface SandboxExecResult {
  exit_code: number
  timed_out: boolean
  duration_ms: number
  stdout: string
  stderr: string
  truncated: boolean
  log_path: string
  notes?: string[]
}

export interface SandboxJobStartedResult {
  task_id: string
  status: 'started'
  pid: number
  log_path: string
  notes?: string[]
}

export interface SandboxToolError {
  error: string
}

export type SandboxExecOutput = SandboxExecResult | SandboxJobStartedResult | SandboxToolError

export const SandboxImportInputSchema = z.object({
  from: z.string().min(1).describe('A file you can read: a workspace path such as /project/data.csv, or an asset: reference.'),
  to: z.string().min(1).describe('Absolute destination path in the sandbox. Parent directories are created; an existing file is replaced.'),
})
export type SandboxImportInput = z.infer<typeof SandboxImportInputSchema>

export interface SandboxImportResult {
  to: string
  size: number
}

export const SandboxExportInputSchema = z.object({
  from: z.string().min(1).describe('Absolute path of a file in the sandbox.'),
  to: z.string().min(1).describe('Workspace destination, under /project or /conversation.'),
  expected_version: z.number().int().min(1).optional()
    .describe('The version you last read, when replacing an existing workspace file.'),
})
export type SandboxExportInput = z.infer<typeof SandboxExportInputSchema>

export interface SandboxExportResult {
  path: string
  version: number
  size: number
  operation: 'created' | 'updated' | 'replaced'
}
