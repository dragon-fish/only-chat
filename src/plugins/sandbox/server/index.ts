import type { Context } from 'cordis'
import { tool } from 'ai'
import { and, eq } from 'drizzle-orm'
import { attachments } from '@/server/db/schema'
import type { ToolContext } from '@/server/plugins/tools'
import { storeGeneratedAttachment } from '@/server/plugins/api/attachments'
import { disposeRpcStub } from '@/server/rpc'
import { whileOffered } from '@/server/plugins/prompt-sections'
import { markUnitBackupsDeleted } from '@/server/sandbox/backups'
import {
  MAX_TEXT_READ_BYTES, execFiles, normalizeSandboxPath, unitDir,
  type ExecFrame, type MachineOptions, type SandboxRpc, type Unit,
} from '@/server/sandbox/protocol'
import { isTextMime, isUtf8Text, MAX_ATTACHMENT_BYTES, mimeFromExtension, textMimeFromFilename } from '@/shared/file-media'
import { readLines } from '@/shared/text-lines'
import { binaryFromAttachment } from '@/plugins/file-reader/server/service'
import { fileToolError, refFailure } from '@/plugins/file-reader/server/refs'
import type { ReadAssetTextOutput } from '@/plugins/file-reader/shared'
import { MESSAGES, servicesFor, workspaceToolError, writeWorkspaceFile } from '@/plugins/workspace-files/server'
import { applyTextEdit, MAX_FILE_BYTES } from '@/server/plugins/workspace-files/service'
import {
  RESULT_HEAD_BYTES, RESULT_TAIL_BYTES, SANDBOX_CONFIG_SCHEMA, SANDBOX_EXEC_TOOL_ID, SANDBOX_EXPORT_TOOL_ID,
  SANDBOX_IMPORT_TOOL_ID, SANDBOX_PLUGIN_ID, SANDBOX_WRITE_FILE_TOOL_ID, SANDBOX_EDIT_FILE_TOOL_ID,
  SandboxExecInputSchema, SandboxExportInputSchema, SandboxImportInputSchema, SandboxWriteFileInputSchema, SandboxEditFileInputSchema,
  type SandboxExecInput, type SandboxExecOutput, type SandboxExportResult, type SandboxImportInput, type SandboxImportResult, type SandboxToolError,
  type SandboxWriteFileInput, type SandboxEditFileInput,
  type SandboxWriteFileResult, type SandboxEditFileResult,
} from '../shared'
import { countLines } from '@/server/plugins/workspace-files/path'
import manifest from '../manifest'
import { LineBuffer, OutputWindow } from './output'
import { cwdNotes, summarize, wrapCommand } from './command'
import { inCallOrder } from './order'
import { STALL_MARGIN_MS, STALLED, nextBefore } from './stall'
import { STOPPED, untilStopped } from './stop'

const SANDBOX_TOOL_IDS: readonly string[] = [
  SANDBOX_EXEC_TOOL_ID, SANDBOX_IMPORT_TOOL_ID, SANDBOX_EXPORT_TOOL_ID, SANDBOX_WRITE_FILE_TOOL_ID, SANDBOX_EDIT_FILE_TOOL_ID,
]
const PROGRESS_FLUSH_MS = 100
/** Binary bytes cross Durable Object RPC whole, and one RPC message is capped at 32 MiB. */
const MAX_BINARY_BYTES = MAX_ATTACHMENT_BYTES
const BINARY_MIMES: Record<string, string> = {
  zip: 'application/zip', gz: 'application/gzip', tgz: 'application/gzip', tar: 'application/x-tar', '7z': 'application/x-7z-compressed',
}

/**
 * When and how to use the machine, offered while any sandbox tool is. The tool descriptions keep
 * only how to call each tool; what spans tools or should happen unprompted belongs here.
 */
const GUIDANCE = [
  'You have a Linux machine of your own through the sandbox tools: Debian with Python 3.12 (uv, and a default venv holding numpy, pandas, matplotlib, requests, openpyxl, pillow, beautifulsoup4, lxml), Node 24 with pnpm and bun, git, curl, jq, ripgrep, zip, tmux and build-essential, with internet access. Use it whenever running something beats reasoning about it: computing, converting files, testing what you wrote.',
  'What lasts: this conversation\'s directory (its Project\'s, when it has one) and /workspace/home, which is HOME, are backed up when the machine idles and restored when next used. node_modules/, .venv/, __pycache__/, .cache/ and anything a .gitignore excludes are left out, so reinstall dependencies after a restore. `uv tool install` and npm/pnpm/bun global packages live in HOME and last; `uv pip install` goes into the default venv and lasts only until the machine stops, so put lasting dependencies in the project. Everything else on the machine is gone once it stops.',
  'Playwright 1.63.0 with a headless Chromium is preinstalled, for checking a web app you serve at localhost: in Python `from playwright.sync_api import sync_playwright` works as is; in Node add exactly `playwright@1.63.0` to the project (any other version downloads a browser of its own). Do not install another browser.',
  'The user cannot see the machine. Look at what you make with read_file("sandbox:/absolute/path"); an image read that way can be shown in your reply. To let the user keep or download something, publish it with sandbox_export — for a whole project, one zip without dependencies and build output, for example `zip -r /tmp/project.zip . -x "node_modules/*" "dist/*" ".venv/*" "__pycache__/*" ".git/*"`.',
  'Create and change files with sandbox_write_file and sandbox_edit_file rather than heredocs or sed.',
].join(' ')

const EXEC_DESCRIPTION = [
  'Run a command on your Linux machine.',
  'Set exactly one of command (run by bash -lc) or argv (passed as-is, no quoting needed). stdin is written to the process exactly as given.',
  'Every call starts in cwd, or in this conversation\'s directory: a cd lasts only for the call it is in.',
  'Output keeps the first 4 KiB and last 16 KiB of each stream; the whole output is in log_path. A foreground command stops at timeout_ms.',
  'For anything long — builds, crawls, servers — set background: true. It returns at once with a task id; the outcome arrives later as a <task-notification>. Do not poll or wait for it; carry on or answer the user. Read the log with tail on log_path if you need to look, and stop it with kill <pid>.',
].join(' ')

const WRITE_FILE_DESCRIPTION = [
  'Create a file in the sandbox, or replace one completely: this writes the whole file. Parent directories are created and an existing file is overwritten.',
  'Sandbox files have no versions, so nothing is kept of what was replaced.',
  `Limit is ${MAX_FILE_BYTES / 1024 / 1024} MiB of UTF-8 text; generate anything larger with sandbox_exec.`,
  'Read it back with read_file("sandbox:/absolute/path").',
].join(' ')

const EDIT_FILE_DESCRIPTION = [
  'Change part of a sandbox file by naming the text to replace.',
  'oldText is matched literally, not as a pattern or a regular expression. It must match the file exactly, including indentation — and without the line numbers read_file("sandbox:/absolute/path") prints in front of each line.',
  'It must match exactly one place, so include enough surrounding lines to be unambiguous; pass replaceAll to change every occurrence instead. An empty newText deletes the matched text.',
  'Sandbox files have no versions: the edit applies to whatever the file holds now, and the previous content is not kept.',
].join(' ')

const IMPORT_DESCRIPTION = [
  'Copy a file you can read — a workspace path such as /project/data.csv, or an asset: reference to an uploaded or generated file — into the sandbox at an absolute path.',
  'Parent directories are created and an existing file is replaced.',
].join(' ')

const EXPORT_DESCRIPTION = [
  'Publish a sandbox file to the workspace, under /project or /conversation, where the user can see and download it.',
  `Text files up to ${MAX_FILE_BYTES / 1024 / 1024} MiB become ordinary workspace text files: replacing one needs expected_version, as with write_file.`,
  `Anything else is published as a binary file of at most ${MAX_BINARY_BYTES / 1024 / 1024} MiB, and only to a free path — a binary file is never overwritten. Split or compress what is larger.`,
].join(' ')

function sandboxOf(env: Env, userId: number): SandboxRpc & Disposable {
  return env.SANDBOX.getByName(String(userId)) as unknown as SandboxRpc & Disposable
}

/** The one place a stub is used and released; a leaked stub keeps the connection open. */
async function withSandbox<T>(env: Env, userId: number, use: (sandbox: SandboxRpc) => Promise<T>): Promise<T> {
  const sandbox = sandboxOf(env, userId)
  try {
    return await use(sandbox)
  } finally {
    disposeRpcStub(sandbox)
  }
}

/**
 * `withSandbox` for a tool call: a stopped turn gets `STOPPED` at once rather than wait for the
 * machine (see `untilStopped`). The stub is still released only when the call itself settles.
 */
function forTurn<T>(env: Env, runtime: Pick<ToolContext, 'userId' | 'signal'>, use: (sandbox: SandboxRpc) => Promise<T>): Promise<T | typeof STOPPED> {
  return untilStopped(runtime.signal, withSandbox(env, runtime.userId, use))
}

/**
 * Asks the machine to stop what one tool call started, launched or not yet. On a stub of its own,
 * so releasing the call's stub cannot cut it off.
 */
function killCall(env: Env, userId: number, callId: string): void {
  void withSandbox(env, userId, sandbox => sandbox.kill(userId, callId))
    .catch(error => console.error('sandbox kill failed', error))
}

const STOPPED_WAITING = 'The generation was stopped while waiting for the sandbox.'
const STOPPED_WRITE = `${STOPPED_WAITING} The change was not confirmed and may still be applied once the machine is up.`

function defaultUnit(runtime: Pick<ToolContext, 'projectId' | 'conversationId'>): Unit {
  return runtime.projectId !== null ? { kind: 'project', id: runtime.projectId } : { kind: 'conversation', id: runtime.conversationId }
}

function machineOf(config: Record<string, unknown>): MachineOptions & { defaultTimeoutMs: number } {
  const parsed = SANDBOX_CONFIG_SCHEMA.parse(config)
  return { instance: parsed.instance_type, idleMinutes: parsed.idle_minutes, defaultTimeoutMs: parsed.default_timeout_ms }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function extensionOf(path: string): string {
  const name = basename(path)
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
}

async function* frames(body: ReadableStream<Uint8Array>): AsyncGenerator<ExecFrame> {
  const decoder = new TextDecoder()
  let buffered = ''
  for await (const chunk of body) {
    buffered += decoder.decode(chunk, { stream: true })
    let newline = buffered.indexOf('\n')
    while (newline >= 0) {
      const line = buffered.slice(0, newline)
      buffered = buffered.slice(newline + 1)
      if (line) yield JSON.parse(line) as ExecFrame
      newline = buffered.indexOf('\n')
    }
  }
  if (buffered.trim()) yield JSON.parse(buffered) as ExecFrame
}

export const SandboxServerPlugin = {
  name: 'sandbox',
  inject: ['tools', 'env', 'hub', 'db', 'assets', 'fileReader', 'pluginConfig', 'promptSections'] as const,
  apply(ctx: Context) {
    const env = ctx.env
    const hub = ctx.hub

    ctx.promptSections.register(SANDBOX_PLUGIN_ID, whileOffered(manifest, GUIDANCE))

    ctx.tools.register(SANDBOX_PLUGIN_ID, SANDBOX_EXEC_TOOL_ID, runtime => tool({
      description: EXEC_DESCRIPTION,
      inputSchema: SandboxExecInputSchema,
      execute: inCallOrder(runtime, async (input: SandboxExecInput, { toolCallId }: { toolCallId: string }): Promise<SandboxExecOutput> => {
        const argv = wrapCommand(input, input.background ? undefined : execFiles(toolCallId).cwd)
        if (!argv) return { error: 'Set exactly one of command or argv.' }
        if (input.background && input.stdin !== undefined) return { error: 'A background command cannot take stdin. Write the input to a file first and redirect it.' }
        const cwd = input.cwd === undefined ? unitDir(defaultUnit(runtime)) : normalizeSandboxPath(input.cwd)
        if (!cwd) return { error: `cwd must be an absolute path, got ${JSON.stringify(input.cwd)}.` }
        const { defaultTimeoutMs, ...machine } = machineOf(runtime.config)

        // A stopped turn asks the machine to stop this call at whatever stage it is in, and answers at
        // once rather than wait: on a cold start the machine holds the call until it is up.
        const kill = () => killCall(env, runtime.userId, toolCallId)
        runtime.signal.addEventListener('abort', kill, { once: true })
        try {
          if (input.background) {
            try {
              const started = await forTurn(env, runtime, sandbox => sandbox.startJob({
                userId: runtime.userId, machine, argv, cwd, conversationId: runtime.conversationId,
                originMessageId: runtime.assistantMessageId, toolCallId, pluginId: SANDBOX_PLUGIN_ID, summary: summarize(input),
              }))
              if (started === STOPPED) return { error: 'The generation was stopped before the background command started. It was cancelled, or stopped if it had already started.' }
              return {
                task_id: started.taskId, status: 'started', pid: started.pid, log_path: started.logPath,
                ...(started.notes.length > 0 ? { notes: started.notes } : {}),
              }
            } catch (error) {
              return { error: message(error) }
            }
          }

          const timeoutMs = input.timeout_ms ?? defaultTimeoutMs
          const result = await forTurn(env, runtime, async (sandbox): Promise<SandboxExecOutput> => {
            const stdout = new OutputWindow(RESULT_HEAD_BYTES, RESULT_TAIL_BYTES)
            const stderr = new OutputWindow(RESULT_HEAD_BYTES, RESULT_TAIL_BYTES)
            const lines = new LineBuffer()
            let pending: string[] = []
            const flush = () => {
              if (pending.length === 0) return
              const batch = pending
              pending = []
              void hub.broadcastGeneration({ type: 'tool.progress', message_id: runtime.assistantMessageId, call_id: toolCallId, lines: batch })
            }
            const timer = setInterval(flush, PROGRESS_FLUSH_MS)
            let notes: string[] = []
            try {
              const body = await sandbox.exec({ userId: runtime.userId, machine, execId: toolCallId, argv, stdin: input.stdin, cwd, timeoutMs })
              // The tool has answered already; only the stream is left to release.
              if (runtime.signal.aborted) {
                void body.cancel().catch(() => {})
                return { error: STOPPED_WAITING }
              }
              const iterator = frames(body)
              const deadline = Date.now() + timeoutMs + STALL_MARGIN_MS
              while (true) {
                const next = await untilStopped(runtime.signal, nextBefore(iterator, deadline))
                if (next === STOPPED) {
                  void iterator.return(undefined)
                  return { error: STOPPED_WAITING }
                }
                if (next === STALLED) {
                  void iterator.return(undefined)
                  kill()
                  return { error: 'The sandbox stopped answering before the command finished; it may have been restarted, losing unsaved files. Check the directory before relying on earlier output.' }
                }
                if (next.done) break
                const frame = next.value
                switch (frame.type) {
                  case 'notes':
                    notes = frame.notes
                    break
                  case 'out':
                    ;(frame.stream === 'stdout' ? stdout : stderr).push(frame.data)
                    pending.push(...lines.push(frame.data))
                    break
                  case 'error':
                    return { error: frame.message } satisfies SandboxToolError
                  case 'end':
                    pending.push(...lines.flush())
                    notes = [...notes, ...cwdNotes(frame, unitDir(defaultUnit(runtime)))]
                    return {
                      exit_code: frame.exitCode, timed_out: frame.timedOut, duration_ms: frame.durationMs,
                      stdout: stdout.text(), stderr: stderr.text(), truncated: stdout.truncated || stderr.truncated,
                      log_path: frame.logPath, ...(notes.length > 0 ? { notes } : {}),
                    }
                }
              }
              return { error: 'The sandbox closed the command\'s output before it finished.' }
            } catch (error) {
              return { error: message(error) }
            } finally {
              clearInterval(timer)
              flush()
            }
          })
          if (result === STOPPED) {
            return { error: `The generation was stopped before the command finished. It was cancelled, or killed if it had already started; whatever it printed is in ${execFiles(toolCallId).log}.` }
          }
          return result
        } finally {
          runtime.signal.removeEventListener('abort', kill)
        }
      }),
    }))

    ctx.tools.register(SANDBOX_PLUGIN_ID, SANDBOX_WRITE_FILE_TOOL_ID, runtime => tool({
      description: WRITE_FILE_DESCRIPTION,
      inputSchema: SandboxWriteFileInputSchema,
      execute: inCallOrder(runtime, async (input: SandboxWriteFileInput, _options: unknown): Promise<SandboxWriteFileResult | SandboxToolError> => {
        const path = normalizeSandboxPath(input.path)
        if (!path) return { error: `path must be an absolute sandbox path, got ${JSON.stringify(input.path)}.` }
        const bytes = new TextEncoder().encode(input.content)
        if (bytes.byteLength > MAX_FILE_BYTES) {
          return { error: `The content is ${bytes.byteLength.toLocaleString('en-US')} bytes, over the ${MAX_FILE_BYTES / 1024 / 1024} MiB limit. Generate a larger file with sandbox_exec instead.` }
        }
        const { defaultTimeoutMs: _timeout, ...machine } = machineOf(runtime.config)
        try {
          const written = await forTurn(env, runtime, async (sandbox): Promise<SandboxWriteFileResult | SandboxToolError> => {
            const existing = await sandbox.stat(runtime.userId, machine, path)
            if (existing && existing.kind !== 'file') return { error: `${path} exists and is not a regular file.` }
            if (runtime.signal.aborted) return { error: STOPPED_WAITING }
            await sandbox.writeFile({ userId: runtime.userId, machine, path, bytes })
            return { path, size: bytes.byteLength, totalLines: countLines(input.content), operation: existing ? 'replaced' as const : 'created' as const }
          })
          return written === STOPPED ? { error: STOPPED_WRITE } : written
        } catch (error) {
          return { error: message(error) }
        }
      }),
    }))

    ctx.tools.register(SANDBOX_PLUGIN_ID, SANDBOX_EDIT_FILE_TOOL_ID, runtime => tool({
      description: EDIT_FILE_DESCRIPTION,
      inputSchema: SandboxEditFileInputSchema,
      execute: inCallOrder(runtime, async (input: SandboxEditFileInput, _options: unknown): Promise<SandboxEditFileResult | SandboxToolError> => {
        const path = normalizeSandboxPath(input.path)
        if (!path) return { error: `path must be an absolute sandbox path, got ${JSON.stringify(input.path)}.` }
        const { defaultTimeoutMs: _timeout, ...machine } = machineOf(runtime.config)
        try {
          const result = await forTurn(env, runtime, async (sandbox): Promise<SandboxEditFileResult | SandboxToolError> => {
            const read = await sandbox.readFile({ userId: runtime.userId, machine, path, maxBytes: MAX_FILE_BYTES })
            if (!read.ok) {
              if (read.code === 'NOT_FOUND') return { error: `${path} does not exist in the sandbox.` }
              if (read.code === 'NOT_A_FILE') return { error: `${path} is not a regular file.` }
              return { error: `${path} is ${read.size?.toLocaleString('en-US')} bytes, over the ${MAX_FILE_BYTES / 1024 / 1024} MiB limit for editing. Change it with sandbox_exec instead.` }
            }
            if (!isUtf8Text(read.bytes)) return { error: `${path} is not UTF-8 text, so it cannot be edited as text. Change it with sandbox_exec instead.` }
            const edited = applyTextEdit(new TextDecoder().decode(read.bytes), input.oldText, input.newText, input.replaceAll)
            if (!edited.ok) return { error: MESSAGES[edited.error] }
            const bytes = new TextEncoder().encode(edited.value.content)
            if (bytes.byteLength > MAX_FILE_BYTES) {
              return { error: `The edited file would be ${bytes.byteLength.toLocaleString('en-US')} bytes, over the ${MAX_FILE_BYTES / 1024 / 1024} MiB limit. Nothing was changed.` }
            }
            if (runtime.signal.aborted) return { error: STOPPED_WAITING }
            await sandbox.writeFile({ userId: runtime.userId, machine, path, bytes })
            return { path, replacements: edited.value.replacements, size: bytes.byteLength, totalLines: countLines(edited.value.content) }
          })
          return result === STOPPED ? { error: STOPPED_WRITE } : result
        } catch (error) {
          return { error: message(error) }
        }
      }),
    }))

    ctx.tools.register(SANDBOX_PLUGIN_ID, SANDBOX_IMPORT_TOOL_ID, runtime => tool({
      description: IMPORT_DESCRIPTION,
      inputSchema: SandboxImportInputSchema,
      execute: inCallOrder(runtime, async (input: SandboxImportInput, _options: unknown): Promise<SandboxImportResult | SandboxToolError | { error: string, message: string }> => {
        const to = normalizeSandboxPath(input.to)
        if (!to) return { error: `to must be an absolute path, got ${JSON.stringify(input.to)}.` }
        const resolved = await ctx.fileReader.resolve(ctx.fileReader.turnOf(runtime.turn), input.from)
        if (!resolved.ok) return fileToolError(resolved)
        const { attachmentId } = resolved.value
        if (attachmentId === undefined) return { error: `${input.from} is not a stored file and cannot be imported.` }
        const [row] = await runtime.db.select().from(attachments)
          .where(and(eq(attachments.id, attachmentId), eq(attachments.user_id, runtime.userId))).limit(1)
        const stored = row ? await runtime.assets.getBytes(row.r2_key) : null
        if (!stored) return { error: `${input.from} is no longer stored.` }
        const { defaultTimeoutMs: _timeout, ...machine } = machineOf(runtime.config)
        try {
          const written = await forTurn(env, runtime, sandbox => sandbox.writeFile({ userId: runtime.userId, machine, path: to, bytes: stored.bytes }))
          if (written === STOPPED) return { error: STOPPED_WRITE }
        } catch (error) {
          return { error: message(error) }
        }
        return { to, size: stored.bytes.byteLength }
      }),
    }))

    ctx.tools.register(SANDBOX_PLUGIN_ID, SANDBOX_EXPORT_TOOL_ID, runtime => tool({
      description: EXPORT_DESCRIPTION,
      inputSchema: SandboxExportInputSchema,
      async execute(input, { toolCallId }): Promise<SandboxExportResult | SandboxToolError | { error: string, message: string }> {
        const from = normalizeSandboxPath(input.from)
        if (!from) return { error: `from must be an absolute sandbox path, got ${JSON.stringify(input.from)}.` }
        const { defaultTimeoutMs: _timeout, ...machine } = machineOf(runtime.config)
        let read
        try {
          read = await forTurn(env, runtime, sandbox => sandbox.readFile({ userId: runtime.userId, machine, path: from, maxBytes: MAX_BINARY_BYTES }))
        } catch (error) {
          return { error: message(error) }
        }
        if (read === STOPPED) return { error: `${STOPPED_WAITING} Nothing was published.` }
        if (!read.ok) {
          if (read.code === 'NOT_FOUND') return { error: `${from} does not exist in the sandbox.` }
          if (read.code === 'NOT_A_FILE') return { error: `${from} is not a regular file. Archive a directory first (zip -r).` }
          return { error: `${from} is ${read.size?.toLocaleString('en-US')} bytes, over the ${MAX_BINARY_BYTES / 1024 / 1024} MiB limit. Split or compress it.` }
        }
        const knownText = textMimeFromFilename(basename(from)) !== undefined
        const knownBinary = mimeFromExtension(extensionOf(from)) !== undefined && !isTextMime(mimeFromExtension(extensionOf(from))!)
        if (!knownBinary && read.size <= MAX_FILE_BYTES && (knownText || isUtf8Text(read.bytes))) {
          const written = await writeWorkspaceFile(runtime, { path: input.to, content: new TextDecoder().decode(read.bytes), expectedVersion: input.expected_version }, toolCallId)
          if ('error' in written) return written
          const { path, version, fileSize, operation } = written.output
          return { path, version, size: fileSize, operation }
        }
        const mime = mimeFromExtension(extensionOf(from)) ?? BINARY_MIMES[extensionOf(from)] ?? 'application/octet-stream'
        const attachmentId = await storeGeneratedAttachment(runtime.db, runtime.assets, runtime.userId, read.bytes, mime)
        const { files, scope } = servicesFor(runtime)
        const copied = await files.copy({
          from: { attachment: { attachmentId, mime, size: read.size } }, toPath: input.to,
          sourceMessageId: runtime.assistantMessageId, toolCallId, ...scope,
        })
        if (!copied.ok) return workspaceToolError(copied.error)
        return { path: copied.value.path, version: copied.value.version, size: copied.value.fileSize, operation: 'created' }
      },
    }))

    // `sandbox:/abs/path` exists only while a sandbox tool is on in the turn. Binary files become
    // attachments so the reader can show them; text pages through like any other file.
    ctx.fileReader.registerScheme('sandbox', async (turn, body, cited) => {
      if (!turn.toolIds.some(id => SANDBOX_TOOL_IDS.includes(id))) return undefined
      const path = normalizeSandboxPath(body)
      if (!path) return refFailure('INVALID_FILE_REF', `${cited} is not an absolute sandbox path.`)
      const { defaultTimeoutMs: _timeout, ...machine } = machineOf(await ctx.pluginConfig.read(turn.userId, SANDBOX_PLUGIN_ID))
      return withSandbox(env, turn.userId, async (sandbox) => {
        const stat = await sandbox.stat(turn.userId, machine, path)
        if (!stat) return refFailure('FILE_NOT_FOUND', `${path} does not exist in the sandbox.`)
        if (stat.kind !== 'file') return refFailure('UNSUPPORTED_FILE', `${path} is not a regular file; list a directory with sandbox_exec.`)
        const name = basename(path)
        const extensionMime = mimeFromExtension(extensionOf(path))
        const maybeText = textMimeFromFilename(name) !== undefined || extensionMime === undefined || isTextMime(extensionMime)
        if (maybeText && stat.size <= MAX_TEXT_READ_BYTES) {
          const read = await sandbox.readFile({ userId: turn.userId, machine, path, maxBytes: MAX_TEXT_READ_BYTES })
          if (!read.ok) return refFailure('FILE_NOT_FOUND', `${path} could not be read.`)
          if (isUtf8Text(read.bytes)) {
            const content = new TextDecoder().decode(read.bytes)
            return {
              ok: true as const,
              value: {
                kind: 'text' as const, ref: cited, mime: textMimeFromFilename(name) ?? 'text/plain', size: read.size, filename: name,
                read: async (range: { offset?: number, limit?: number }) => {
                  const lines = readLines(content, range)
                  if (!lines) return refFailure('READ_RANGE_TOO_LARGE', 'That range is past the end of the file, or too large to return. Use a smaller offset and limit.')
                  return { ok: true as const, value: { file: cited, name, ...lines } satisfies ReadAssetTextOutput }
                },
              },
            }
          }
        }
        if (stat.size > MAX_BINARY_BYTES) {
          return refFailure('UNSUPPORTED_FILE', `${path} is ${stat.size.toLocaleString('en-US')} bytes, over the ${MAX_BINARY_BYTES / 1024 / 1024} MiB a file can be shown at. Make a smaller version of it.`)
        }
        const read = await sandbox.readFile({ userId: turn.userId, machine, path, maxBytes: MAX_BINARY_BYTES })
        if (!read.ok) return refFailure('FILE_NOT_FOUND', `${path} could not be read.`)
        const mime = extensionMime ?? BINARY_MIMES[extensionOf(path)] ?? 'application/octet-stream'
        const attachmentId = await storeGeneratedAttachment(ctx.db.orm, ctx.assets, turn.userId, read.bytes, mime)
        const [row] = await ctx.db.orm.select().from(attachments)
          .where(and(eq(attachments.id, attachmentId), eq(attachments.user_id, turn.userId))).limit(1)
        if (!row) return refFailure('FILE_NOT_FOUND', `${path} could not be stored.`)
        return { ok: true as const, value: binaryFromAttachment(row, name) }
      })
    })

    // Deleting a conversation or Project trashes its backups for the nightly sweep instead of
    // erasing them, and clears its directory from a machine that is running.
    const dropUnit = async (userId: number, unit: Unit) => {
      await markUnitBackupsDeleted(ctx.db.orm, userId, unit, Date.now())
      await withSandbox(env, userId, sandbox => sandbox.dropUnit(userId, unit))
        .catch(error => console.error('sandbox unit cleanup failed', unit, error))
    }
    ctx.on('conversation/before-purge', async ({ userId, conversationId }) => {
      await dropUnit(userId, { kind: 'conversation', id: conversationId })
    })
    ctx.on('project/deleted', async (projectId) => {
      await dropUnit(hub.userId, { kind: 'project', id: projectId })
    })
  },
}
