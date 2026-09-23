# 后台任务与 generate_image 实现计划（计划 1/2）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agent 调用 `generate_image` 在后台生成图片；完成后以 `<task-notification>` user 消息回到对话，并自动续写。

**Architecture:** 核心新增 `task_notification` Part 与 hub 内的通知队列（DO storage 持久化），投递时复用 `reserveUserMessage` / `generate` 与 `prepareStep` 插话机制。生图任务仍是 `artifact_runs` + Workflow；Workflow 新增 `notify` step 调 `UserHub.settleTask`。`image_generation` 插件只负责把工具调用变成一个 `source = 'tool'` 的 run。

**Tech Stack:** TypeScript, cordis, Cloudflare Durable Objects / Workflows / D1, AI SDK v6 (`streamText`, `prepareStep`), Vue 3 + Pug, Vitest（`unit` / `worker` 两个 project）。

**Spec:** [docs/superpowers/specs/2026-09-23-background-tasks-design.md](../specs/2026-09-23-background-tasks-design.md)（本计划覆盖 §2、§3；§4 投影挂载与读图、§3.2 `reference_images` 属于计划 2）

## Global Constraints

- 通知文本格式固定为 spec §2.3 的 `<task-notification>` 块，由 user role 承载。
- `task_id` 形如 `image_run:<run id>`。
- 续写上限常量 `MAX_NOTIFICATION_TURNS = 5`（含即将写入的这一条）。
- 工具幂等键 `client_request_id = tool:<message_id>:<call_id>`。
- 插件 id `image_generation`，工具 id `generate_image`；插件默认关闭（`user.settings.plugins` 未置 true 即关闭）。
- 生图模型解析：对话 `image_provider_id/image_model_id` > `settings.service_models.image`；模型必须 enabled、`supports_image_output`、接口协议属于 `IMAGE_PROTOCOLS`。
- 代码风格：两空格、单引号、无分号；注释英文，写「现在是什么 + 不要改成什么」。
- 只跑相关测试文件；全量只在合并/推送前跑。

## Review Focus

1. **人正在回答 `ask_user` 时任务完成**：head 上有等待人工回答的工具调用 → 通知留在队列，不能借 send 路径自动跳过那个问题；问题回答并续写结束后再投递。（Task 2 测试）
2. **用户发送与通知投递同时发生**：一轮正在进行（或 head CAS 失败）时通知不能丢——留在队列，由那一轮结束后投递。（Task 2 测试 `holds a notification while a turn runs…`）
3. **Workflow `notify` step 重试**：投递中途失败后重试，对话里只出现一条该 `task_id` 的通知。（Task 2 幂等测试）
4. **用户取消工具发起的 run**：取消走 API 而非 Workflow，Workflow 被 terminate 后 `notify` step 不会运行 → 取消路由必须自己通知；并且不能把聊天 assistant 消息标成 aborted。（Task 3 测试）
5. **生图失败（如 `moderation_blocked`）**：通知状态 `failed`，摘要带上游错误原文（已脱敏），Agent 能据此改写 prompt；仍然续写让 Agent 告诉用户。上游原文若回显了 API key，Agent 与用户都不能看到它。（Task 3、Task 6 测试）

---

## File Structure

| 文件 | 职责 |
|---|---|
| `src/shared/parts.ts` | 新增 `TaskNotificationPartSchema` |
| `src/server/plugins/llm/messages.ts` | 通知渲染为 user 文本；本轮插入的 user 消息区分「被打断」与「通知」 |
| `src/server/plugins/hub/tasks.ts`（新） | 纯函数：投递判定（分支、幂等、续写上限、人工待答） |
| `src/server/plugins/hub/index.ts` | 通知队列（DO storage `task:` 前缀）、`settleTask`、alarm 恢复 |
| `src/server/plugins/hub/generation.ts` | `deliverTaskNotifications`；`prepareStep` 取通知；`generate` 结束后投递 |
| `src/server/index.ts` | `UserHub.settleTask` RPC；`ArtifactGenerationWorkflow` 的 `notify` step |
| `src/server/plugins/artifacts/image-model.ts`（新） | `resolveImageModel` |
| `src/server/plugins/artifacts/runs.ts` | `createToolImageRun` |
| `src/server/plugins/artifacts/notify.ts`（新） | `toolRunNotification`（纯）、`notifyToolRun` |
| `src/server/plugins/artifacts/workflow.ts` | tool 来源的 run 不写聊天消息 |
| `src/server/plugins/api/artifacts.ts` | 取消 tool run：不动聊天消息，发通知 |
| `src/server/plugins/llm/images/openai.ts` | 上游错误带脱敏后的原文 |
| `src/shared/plugins.ts`、`src/plugins/image-generation/*`（新）、三处注册表 | 插件 |
| `src/client/plugins/host.ts`、`src/client/components/task-notification-row.vue`（新）、`message-item.vue`、`src/client/lib/conversation-export.ts` | 通知渲染 |
| `src/client/views/image-artifact-detail.vue` | tool 来源 artifact 的来源链接 |

---

### Task 1: `task_notification` Part 与模型侧渲染

**Files:**
- Modify: `src/shared/parts.ts`
- Modify: `src/server/plugins/llm/messages.ts`（`userParts` L39–52、`interjectedUserMessage` L230）
- Test: `test/unit/llm-messages.test.ts`（已存在；追加 describe）

**Interfaces:**
- Produces:
  - `TaskNotificationPartSchema`, `type TaskNotificationPart = { type: 'task_notification'; task_id: string; plugin_id: string; tool_call_id: string; status: 'completed' | 'failed' | 'cancelled'; text: string }`
  - `renderTaskNotification(part: TaskNotificationPart): string`
  - `isNotificationOnly(parts: readonly Part[]): boolean`（shared，客户端也用）
  - `interjectedUserMessage(said: Part[], attachments, interrupted: boolean): ModelMessage`（新增第三个参数）

- [ ] **Step 1: Write the failing tests**

在 `test/unit/llm-messages.test.ts` 末尾追加：

```ts
import { renderTaskNotification, interjectedUserMessage } from '@/server/plugins/llm/messages'
import { isNotificationOnly, type TaskNotificationPart } from '@/shared/parts'

const notice: TaskNotificationPart = {
  type: 'task_notification', task_id: 'image_run:12', plugin_id: 'image_generation', tool_call_id: 'call_1',
  status: 'completed', text: 'Generated 1 image(s): /artifacts/31.png',
}

describe('task notifications', () => {
  it('reach the model as a tagged user text block', () => {
    const messages = buildModelMessages({
      protocol: 'responses', systemPrompt: null, attachments: new Map(),
      path: [message({ id: 1, role: 'user', parts: [notice] })],
    })
    expect(messages).toEqual([{ role: 'user', content: [{ type: 'text', text: renderTaskNotification(notice) }] }])
    expect(renderTaskNotification(notice)).toBe([
      '<task-notification>', '<task-id>image_run:12</task-id>', '<status>completed</status>',
      '<summary>Generated 1 image(s): /artifacts/31.png</summary>', '</task-notification>',
    ].join('\n'))
  })

  it('does not claim the person interrupted when only notifications arrived mid-turn', () => {
    expect(interjectedUserMessage([notice], new Map(), false))
      .toEqual({ role: 'user', content: [{ type: 'text', text: renderTaskNotification(notice) }] })
    expect((interjectedUserMessage([{ type: 'text', text: 'hi' }], new Map(), true).content as Array<{ text: string }>)[0]!.text)
      .toBe('[Request interrupted by user]')
  })

  it('tells a notification-only message from one the person wrote', () => {
    expect(isNotificationOnly([notice])).toBe(true)
    expect(isNotificationOnly([notice, { type: 'text', text: 'and also' }])).toBe(false)
    expect(isNotificationOnly([])).toBe(false)
  })
})
```

`message(...)` 若该测试文件没有同名 helper，照文件内已有构造 `Message` 的写法补一个：

```ts
function message(input: Partial<Message> & Pick<Message, 'id' | 'role' | 'parts'>): Message {
  return {
    conversation_id: 1, parent_id: null, seq: input.id, provider_id: null, model_id: null,
    usage: null, status: 'done', error: null, created_at: 0, ...input,
  } as Message
}
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run test/unit/llm-messages.test.ts`
Expected: FAIL（`renderTaskNotification` / `isNotificationOnly` 不存在）

- [ ] **Step 3: Implement**

`src/shared/parts.ts`，在 `ToolResultPartSchema` 之后、`PartSchema` 之前加入，并把它加进 `z.discriminatedUnion('type', [...])` 的数组：

```ts
/**
 * A background task's outcome, delivered to the model inside a user message. User role because a
 * mid-conversation `developer`/`system` message is not accepted by every protocol.
 */
export const TaskNotificationPartSchema = z.object({
  type: z.literal('task_notification'),
  task_id: z.string().min(1).max(200),
  plugin_id: z.string().min(1),
  tool_call_id: z.string().min(1),
  status: z.enum(['completed', 'failed', 'cancelled']),
  text: z.string().max(20_000),
})
export type TaskNotificationPart = z.infer<typeof TaskNotificationPartSchema>

/** A user message made only of notifications was written by the server, not the person. */
export function isNotificationOnly(parts: readonly Part[]): boolean {
  return parts.length > 0 && parts.every(part => part.type === 'task_notification')
}
```

`src/server/plugins/llm/messages.ts`：

```ts
export function renderTaskNotification(part: TaskNotificationPart): string {
  return [
    '<task-notification>',
    `<task-id>${part.task_id}</task-id>`,
    `<status>${part.status}</status>`,
    `<summary>${part.text}</summary>`,
    '</task-notification>',
  ].join('\n')
}
```

在 `userParts` 的分支里、text 分支旁加：

```ts
else if (p.type === 'task_notification') out.push({ type: 'text', text: renderTaskNotification(p) })
```

`interjectedUserMessage` 改为：

```ts
export function interjectedUserMessage(
  said: Part[],
  attachments: ReadonlyMap<number, AttachmentInput>,
  interrupted: boolean,
): ModelMessage {
  const content = userParts(said, attachments)
  return { role: 'user', content: interrupted ? [{ type: 'text', text: INTERRUPT_MESSAGE }, ...content] : content }
}
```

并更新其 JSDoc：说明 `interrupted` 为 false 时（只有通知）不加中断标记，与 `buildModelMessages` 对 `error !== INTERJECTED` 的回复重建结果一致。

更新 `generation.ts` 中唯一的调用点（L385），暂时传 `true`（Task 2 会改）：

```ts
return { messages: [...messages, interjectedUserMessage(said, attachments, true)] }
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run test/unit/llm-messages.test.ts && pnpm typecheck`
Expected: PASS。typecheck 若在客户端 `switch (part.type)` 处报错，按 Task 5 的方式先补最小分支（返回 null / 跳过），不要改行为。

- [ ] **Step 5: Commit**

```bash
git add src/shared/parts.ts src/server/plugins/llm/messages.ts src/server/plugins/hub/generation.ts test/unit/llm-messages.test.ts
git commit -m "feat(parts): add task_notification parts rendered as tagged user text"
```

---

### Task 2: Hub 通知队列与投递

**Files:**
- Create: `src/server/plugins/hub/tasks.ts`
- Modify: `src/server/plugins/hub/index.ts`（新增队列方法、`settleTask`、`[Service.init]` 与 `onAlarm` 恢复）
- Modify: `src/server/plugins/hub/generation.ts`（导出 `deliverTaskNotifications`；`prepareStep`；`generate` 末尾；`handOff` 签名）
- Modify: `src/server/index.ts`（`UserHub.settleTask`）
- Test: `test/unit/hub-tasks.test.ts`（新）、`test/worker/background-tasks.test.ts`（新）

**Interfaces:**
- Consumes: Task 1 的 `TaskNotificationPart`、`isNotificationOnly`、`interjectedUserMessage(…, interrupted)`
- Produces:
  - `interface TaskSettlement { conversation_id: number; origin_message_id: number; notification: TaskNotificationPart }`
  - `MAX_NOTIFICATION_TURNS = 5`
  - 纯函数：`deliveredTaskIds(messages: readonly Message[]): Set<string>`、`originOnPath(path: readonly Message[], originId: number): boolean`、`notificationTurnsSinceHuman(path: readonly Message[]): number`、`awaitsHuman(head: Message | undefined, isHuman: (toolName: string) => boolean): boolean`
  - `Hub.queueTask(s)`, `Hub.queuedTasks(conversationId): Promise<TaskSettlement[]>`, `Hub.dropTask(taskId)`, `Hub.settleTask(s): Promise<void>`
  - `deliverTaskNotifications(hub: Hub, conversationId: number): Promise<void>`（generation.ts 导出）
  - `UserHub.settleTask(userId: number, settlement: TaskSettlement): Promise<void>`

- [ ] **Step 1: 纯函数的失败测试**

`test/unit/hub-tasks.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { awaitsHuman, deliveredTaskIds, notificationTurnsSinceHuman, originOnPath } from '@/server/plugins/hub/tasks'
import type { Message } from '@/shared/models'
import type { Part, TaskNotificationPart } from '@/shared/parts'

const notice = (task_id: string): TaskNotificationPart => ({
  type: 'task_notification', task_id, plugin_id: 'image_generation', tool_call_id: 'c', status: 'completed', text: 'ok',
})
const msg = (id: number, role: 'user' | 'assistant', parts: Part[]): Message => ({
  id, conversation_id: 1, parent_id: id - 1 || null, seq: id, role, parts, provider_id: null, model_id: null,
  usage: null, status: 'done', error: null, created_at: 0,
} as Message)

describe('task delivery rules', () => {
  it('finds tasks already delivered anywhere in the conversation', () => {
    expect(deliveredTaskIds([msg(1, 'user', [notice('image_run:1')]), msg(2, 'assistant', [])])).toEqual(new Set(['image_run:1']))
  })

  it('delivers only while the launching message is still on the current path', () => {
    const path = [msg(1, 'user', [{ type: 'text', text: 'draw' }]), msg(2, 'assistant', [])]
    expect(originOnPath(path, 2)).toBe(true)
    expect(originOnPath(path, 7)).toBe(false)
  })

  it('counts notification-only turns since the person last wrote', () => {
    const path = [
      msg(1, 'user', [{ type: 'text', text: 'draw' }]), msg(2, 'assistant', []),
      msg(3, 'user', [notice('a')]), msg(4, 'assistant', []),
      msg(5, 'user', [notice('b')]), msg(6, 'assistant', []),
    ]
    expect(notificationTurnsSinceHuman(path)).toBe(2)
    expect(notificationTurnsSinceHuman([...path, msg(7, 'user', [notice('c'), { type: 'text', text: 'hi' }])])).toBe(0)
  })

  it('holds delivery while a question to the person is unanswered', () => {
    const asking = msg(2, 'assistant', [{ type: 'tool_call', id: 'q', name: 'ask_user', args: {} }])
    const isHuman = (name: string) => name === 'ask_user'
    expect(awaitsHuman(asking, isHuman)).toBe(true)
    expect(awaitsHuman(msg(2, 'assistant', [
      { type: 'tool_call', id: 'q', name: 'ask_user', args: {} },
      { type: 'tool_result', call_id: 'q', name: 'ask_user', content: {} },
    ]), isHuman)).toBe(false)
    expect(awaitsHuman(msg(2, 'assistant', [{ type: 'tool_call', id: 's', name: 'web_search', args: {} }]), isHuman)).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run test/unit/hub-tasks.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `src/server/plugins/hub/tasks.ts`**

```ts
import type { Message } from '@/shared/models'
import { isNotificationOnly, type TaskNotificationPart } from '@/shared/parts'

/** What a domain hands the hub when a background task it started has finished. */
export interface TaskSettlement {
  conversation_id: number
  /** The assistant message holding the tool call that started the task. */
  origin_message_id: number
  notification: TaskNotificationPart
}

/** Notification-only user messages in a row, counting the one about to be written, before the server stops continuing on its own. */
export const MAX_NOTIFICATION_TURNS = 5

export const TASK_STORAGE_PREFIX = 'task:'

export function deliveredTaskIds(messages: readonly Message[]): Set<string> {
  const ids = new Set<string>()
  for (const message of messages) {
    if (message.role !== 'user') continue
    for (const part of message.parts) if (part.type === 'task_notification') ids.add(part.task_id)
  }
  return ids
}

/** A branch the person left behind never started this task, so its outcome is not news there. */
export function originOnPath(path: readonly Message[], originId: number): boolean {
  return path.some(message => message.id === originId)
}

export function notificationTurnsSinceHuman(path: readonly Message[]): number {
  let count = 0
  for (let index = path.length - 1; index >= 0; index--) {
    const message = path[index]!
    if (message.role !== 'user') continue
    if (!isNotificationOnly(message.parts)) break
    count++
  }
  return count
}

/**
 * A question to the person keeps the floor. Sending on top of it would auto-skip the question
 * (see `resolveSendParent`), so a notification must wait until the question is answered.
 */
export function awaitsHuman(head: Message | undefined, isHuman: (toolName: string) => boolean): boolean {
  if (head?.role !== 'assistant') return false
  const answered = new Set(head.parts.flatMap(part => (part.type === 'tool_result' ? [part.call_id] : [])))
  return head.parts.some(part => part.type === 'tool_call' && isHuman(part.name) && !answered.has(part.id))
}
```

- [ ] **Step 4: Run unit tests**

Run: `pnpm vitest run test/unit/hub-tasks.test.ts`
Expected: PASS

- [ ] **Step 5: Hub 队列方法与 RPC**

`src/server/plugins/hub/index.ts`，在 stash 方法附近加入（`import { TASK_STORAGE_PREFIX, type TaskSettlement } from './tasks'`，`import { deliverTaskNotifications } from './generation'`）：

```ts
  /** Durable: the stash is memory-only, and a settled task must survive the DO restarting. */
  async queueTask(settlement: TaskSettlement): Promise<void> {
    await this.state.storage.put(TASK_STORAGE_PREFIX + settlement.notification.task_id, settlement)
  }

  async queuedTasks(conversationId: number): Promise<TaskSettlement[]> {
    const stored = await this.state.storage.list<TaskSettlement>({ prefix: TASK_STORAGE_PREFIX })
    return [...stored.values()].filter(entry => entry.conversation_id === conversationId)
  }

  async dropTask(taskId: string): Promise<void> {
    await this.state.storage.delete(TASK_STORAGE_PREFIX + taskId)
  }

  /**
   * Queue first, then deliver unless a turn is running: that turn takes it between steps, or
   * delivers it when it ends. Awaits any turn it starts — the caller's request is what keeps the
   * DO alive, the same way `webSocketMessage` awaits a send.
   */
  async settleTask(settlement: TaskSettlement): Promise<void> {
    await this.queueTask(settlement)
    if (this.inflight().some(job => job.conversationId === settlement.conversation_id)) return
    await deliverTaskNotifications(this, settlement.conversation_id)
  }
```

恢复：在 `_recoverInflight()` 之后，若 `storage.list({ prefix: TASK_STORAGE_PREFIX, limit: 1 })` 非空，`await this.state.storage.setAlarm(Date.now())`。`onAlarm` 末尾追加：

```ts
    // Notifications queued behind a turn that died with the previous instance.
    if (this._inflight.size === 0) {
      const queued = await this.state.storage.list<TaskSettlement>({ prefix: TASK_STORAGE_PREFIX })
      for (const conversationId of new Set([...queued.values()].map(entry => entry.conversation_id))) {
        await deliverTaskNotifications(this, conversationId).catch(error => console.error('task delivery failed', error))
      }
    }
```

`src/server/index.ts` 的 `UserHub`，仿照 `publishConversation`：

```ts
  async settleTask(userId: number, settlement: TaskSettlement): Promise<void> {
    const parsed = parseAuthUserId(String(userId))
    if (parsed === null || !(await this.ensureOwner(parsed))) throw new Error('Hub identity mismatch')
    await this.app.hub.settleTask(settlement)
  }
```

- [ ] **Step 6: 投递流程（generation.ts）**

新增导出函数（放在 `runToolContinue` 之后）：

```ts
/**
 * Writes queued notifications for one conversation as a user message under its head and, within
 * `MAX_NOTIFICATION_TURNS`, starts the turn that reads them. Idempotent per task id, so a retried
 * `settleTask` never delivers twice.
 */
export async function deliverTaskNotifications(hub: Hub, conversationId: number): Promise<void> {
  const queued = await hub.queuedTasks(conversationId)
  if (queued.length === 0) return
  if (hub.inflight().some(job => job.conversationId === conversationId)) return
  const conversation = await getConversation(hub.db, conversationId, hub.userId)
  if (!conversation) {
    for (const entry of queued) await hub.dropTask(entry.notification.task_id)
    return
  }
  const messages = (await listMessages(hub.db, conversationId, hub.userId)).map(row => toMessage(row))
  const byId = new Map(messages.map(message => [message.id, message]))
  const path = pathToRoot(byId, conversation.head_message_id)
  const delivered = deliveredTaskIds(messages)
  const deliverable: TaskSettlement[] = []
  for (const entry of queued) {
    if (delivered.has(entry.notification.task_id) || !originOnPath(path, entry.origin_message_id)) {
      await hub.dropTask(entry.notification.task_id)
    } else deliverable.push(entry)
  }
  if (deliverable.length === 0) return
  if (awaitsHuman(path.at(-1), name => hub.app.tools.human(name) !== undefined)) return

  const parts = deliverable.map(entry => entry.notification)
  let written: Message
  try {
    written = await reserveUserMessage(hub, conversation, conversation.head_message_id, parts)
  } catch {
    // Head moved: a send won the race. That turn delivers these when it settles.
    return
  }
  for (const entry of deliverable) await hub.dropTask(entry.notification.task_id)
  if (notificationTurnsSinceHuman([...path, written]) >= MAX_NOTIFICATION_TURNS) return

  const origin = byId.get(deliverable[0]!.origin_message_id)!
  const target = await resolveTarget(hub, {
    conversationId,
    // The per-turn model is chosen by the client; a server-started turn reuses the one that launched the task.
    fallbackModel: { provider_id: origin.provider_id!, model_id: origin.model_id! },
    firstParts: parts,
  })
  const shell = await openReservedAssistantShell(hub, target, written.id)
  await generate(hub, target, shell, written.id)
}
```

需要的 import：`deliveredTaskIds, originOnPath, notificationTurnsSinceHuman, awaitsHuman, MAX_NOTIFICATION_TURNS, type TaskSettlement` from `./tasks`；`pathToRoot` from `./tree`；`getConversation, listMessages, toMessage` from `./conversations`（已导入的不要重复）。

`generate()` 末尾，`closeUnanswerableCalls(...)` 之后追加：

```ts
  // Tasks that settled during this turn but after its last step had nowhere else to go.
  await deliverTaskNotifications(hub, shell.conversation_id)
```

`prepareStep` 改为同时取通知（通知在前，人说的话在后）：

```ts
      prepareStep: async ({ messages }) => {
        const notices = await takeTurnNotifications(hub, target.conversation.id)
        const said = hub.takeStash(shell.id)
        if (notices.length === 0 && said.length === 0) return {}
        const interrupted = said.length > 0
        await handOff([...notices.map(entry => entry.notification), ...said], interrupted)
        for (const entry of notices) await hub.dropTask(entry.notification.task_id)
        return { messages: [...messages, interjectedUserMessage([...notices.map(entry => entry.notification), ...said], attachments, interrupted)] }
      },
```

`takeTurnNotifications`（generation.ts 内部函数）：

```ts
/** Queued notifications this running turn may read between steps; stale ones are dropped here too. */
async function takeTurnNotifications(hub: Hub, conversationId: number): Promise<TaskSettlement[]> {
  const queued = await hub.queuedTasks(conversationId)
  if (queued.length === 0) return []
  const conversation = await getConversation(hub.db, conversationId, hub.userId)
  if (!conversation) return []
  const messages = (await listMessages(hub.db, conversationId, hub.userId)).map(row => toMessage(row))
  const path = pathToRoot(new Map(messages.map(message => [message.id, message])), conversation.head_message_id)
  const delivered = deliveredTaskIds(messages)
  const taken: TaskSettlement[] = []
  for (const entry of queued) {
    if (delivered.has(entry.notification.task_id) || !originOnPath(path, entry.origin_message_id)) await hub.dropTask(entry.notification.task_id)
    else taken.push(entry)
  }
  return taken
}
```

`handOff` 签名改为 `async (said: Part[], interrupted: boolean)`，其中 `finalizeMessage` 与 `message.done` 的 `error` 改为 `interrupted ? INTERJECTED : null`，注释改写为：被人打断时标记 `INTERJECTED`，只有通知时回复是正常结束（以工具结果收尾的回复本来就合法），不能标记，否则重建历史时会给模型加上「被用户打断」。其余不变。

- [ ] **Step 7: Worker 测试**

`test/worker/background-tasks.test.ts`。helper 照抄 `test/worker/hub-generation.test.ts` 的 `seedProvider`（L95–107）、`STREAM`（文件顶部）与 `installMock`（L181–207，只保留 `mockFactory` 参数），另加：

```ts
import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { describe, expect, it } from 'vitest'
import { createDb } from '@/server/db/client'
import { createConversation, insertMessage, listMessages, toMessage, updateConversation } from '@/server/plugins/hub/conversations'
import type { TaskSettlement } from '@/server/plugins/hub/tasks'
import type { UserHub } from '@/server/index'
import type { Part } from '@/shared/parts'

const textModel = () => new MockLanguageModelV4({ doStream: async () => ({ stream: simulateReadableStream({ chunks: STREAM }) }) })

/** A chat where the assistant (id returned as `origin`) called generate_image; head = origin unless `head` says otherwise. */
async function seedChat(providerId: number, assistantParts: Part[] = [{ type: 'tool_call', id: 'call_1', name: 'generate_image', args: { prompt: 'otter' } }]) {
  const db = createDb(env.DB)
  const conversation = await createConversation(db, { user_id: 1, title: 't', provider_id: providerId, model_id: 'mock-1' })
  const user = await insertMessage(db, 1, {
    conversation_id: conversation.id, parent_id: null, seq: 1, role: 'user', parts: [{ type: 'text', text: 'draw an otter' }],
    provider_id: null, model_id: null, usage: null, status: 'done', error: null, created_at: 0,
  })
  const origin = await insertMessage(db, 1, {
    conversation_id: conversation.id, parent_id: user.id, seq: 2, role: 'assistant', parts: assistantParts,
    provider_id: providerId, model_id: 'mock-1', usage: null, status: 'done', error: null, created_at: 0,
  })
  await updateConversation(db, conversation.id, 1, { head_message_id: origin.id })
  return { conversationId: conversation.id, userId: user.id, origin: origin.id }
}

const settlement = (conversationId: number, origin: number, taskId = 'image_run:1'): TaskSettlement => ({
  conversation_id: conversationId, origin_message_id: origin,
  notification: { type: 'task_notification', task_id: taskId, plugin_id: 'image_generation', tool_call_id: 'call_1', status: 'completed', text: 'Generated 1 image(s): /artifacts/1.png' },
})

const settle = (s: TaskSettlement) =>
  runInDurableObject(env.USER_HUB.getByName('1'), (instance: UserHub) => instance.settleTask(1, s))

const rolesOf = async (conversationId: number) =>
  (await listMessages(createDb(env.DB), conversationId, 1)).map(row => [row.role, toMessage(row).parts.map(part => part.type).join(',')])
```

（`createConversation` 的 `kind` 默认为 chat；`updateConversation` 的 patch 支持 `head_message_id`。不要为测试新增生产代码。）

```ts
const queuedKeys = () => runInDurableObject(env.USER_HUB.getByName('1'), async (_i: UserHub, state) =>
  [...(await state.storage.list({ prefix: 'task:' })).keys()])

describe('background task delivery', () => {
  it('continues after writing the notification', async () => {
    const providerId = await seedProvider('bg-continue')
    await installMock(textModel)
    const { conversationId, origin } = await seedChat(providerId)
    await settle(settlement(conversationId, origin))
    expect(await rolesOf(conversationId)).toEqual([
      ['user', 'text'], ['assistant', 'tool_call'], ['user', 'task_notification'], ['assistant', 'text'],
    ])
  })

  it('delivers a task only once', async () => {
    const providerId = await seedProvider('bg-once')
    await installMock(textModel)
    const { conversationId, origin } = await seedChat(providerId)
    await settle(settlement(conversationId, origin))
    await settle(settlement(conversationId, origin))
    expect((await rolesOf(conversationId)).filter(([, kinds]) => kinds === 'task_notification')).toHaveLength(1)
  })

  it('does not deliver to a branch that never started the task', async () => {
    const providerId = await seedProvider('bg-branch')
    await installMock(textModel)
    const { conversationId } = await seedChat(providerId)
    await settle(settlement(conversationId, 999_999, 'image_run:branch'))
    expect(await rolesOf(conversationId)).toHaveLength(2)
    expect(await queuedKeys()).not.toContain('task:image_run:branch')
  })

  it('waits while a question to the person is open', async () => {
    const providerId = await seedProvider('bg-question')
    await installMock(textModel)
    const { conversationId, origin } = await seedChat(providerId, [{ type: 'tool_call', id: 'q', name: 'ask_user', args: { questions: [] } }])
    await settle(settlement(conversationId, origin, 'image_run:question'))
    expect(await rolesOf(conversationId)).toHaveLength(2)
    expect(await queuedKeys()).toContain('task:image_run:question')
  })

  it('holds a notification while a turn runs, then delivers it when that turn is over', async () => {
    const providerId = await seedProvider('bg-running')
    await installMock(textModel)
    const { conversationId, origin } = await seedChat(providerId)
    const stub = env.USER_HUB.getByName('1')
    await runInDurableObject(stub, async (instance: UserHub) => {
      const hub = instance.app.hub
      // Stands in for a turn in progress; only its conversation id matters to delivery.
      const running = { id: -1, conversation_id: conversationId } as Message
      await hub.trackInflight({ message: running, conversationId, controller: new AbortController(), startedAt: Date.now(), parts: [], stash: [] })
      await hub.settleTask(settlement(conversationId, origin, 'image_run:running'))
      expect(await rolesOf(conversationId)).toHaveLength(2)
      await hub.untrackInflight(running.id)
      await deliverTaskNotifications(hub, conversationId)
    })
    expect((await rolesOf(conversationId)).slice(2)).toEqual([['user', 'task_notification'], ['assistant', 'text']])
    expect(await queuedKeys()).not.toContain('task:image_run:running')
  })

  it('stops continuing after MAX_NOTIFICATION_TURNS', async () => {
    const providerId = await seedProvider('bg-cap')
    await installMock(textModel)
    const { conversationId, origin } = await seedChat(providerId)
    for (let index = 1; index <= 5; index++) await settle(settlement(conversationId, origin, `image_run:cap-${index}`))
    const roles = await rolesOf(conversationId)
    expect(roles.at(-1)).toEqual(['user', 'task_notification'])
    expect(roles.filter(([, kinds]) => kinds === 'task_notification')).toHaveLength(5)
  })
})
```

`deliverTaskNotifications` 从 `@/server/plugins/hub/generation` 导入，`Message` 从 `@/shared/models` 导入。生产中「一轮结束后投递」由 `generate` 末尾的调用完成；这里直接调用它，以隔离「在途时只入队」这一规则。

- [ ] **Step 8: Run tests**

Run: `pnpm vitest run test/unit/hub-tasks.test.ts && pnpm vitest run --project worker test/worker/background-tasks.test.ts test/worker/interjection-reaches-model.test.ts test/worker/hub-generation.test.ts && pnpm typecheck`
Expected: PASS（插话相关旧测试必须仍然通过：人插话时仍带 `[Request interrupted by user]`）

- [ ] **Step 9: Commit**

```bash
git add src/server/plugins/hub src/server/index.ts test/unit/hub-tasks.test.ts test/worker/background-tasks.test.ts
git commit -m "feat(hub): queue and deliver background task notifications"
```

---

### Task 3: 工具来源的生图 run

**Files:**
- Create: `src/server/plugins/artifacts/image-model.ts`
- Create: `src/server/plugins/artifacts/notify.ts`
- Modify: `src/server/plugins/artifacts/runs.ts`（抽出校验，新增 `createToolImageRun`）
- Modify: `src/server/plugins/artifacts/workflow.ts`（L92–108：tool run 不写聊天消息）
- Modify: `src/server/plugins/api/artifacts.ts`（L71–92：取消）
- Modify: `src/server/index.ts`（`ArtifactGenerationWorkflow` 加 `notify` step）
- Test: `test/unit/artifact-notify.test.ts`（新）、`test/worker/artifact-workflow.test.ts`（追加）

**Interfaces:**
- Consumes: Task 2 的 `TaskSettlement`、`UserHub.settleTask`
- Produces:
  - `resolveImageModel(db: DB, userId: number, conversation: Pick<ConversationRow, 'image_provider_id' | 'image_model_id'>, settings: UserSettings): Promise<ModelRef | null>`
  - `createToolImageRun(ctx: Context, userId: number, input: ToolImageRunInput): Promise<{ run_id: number }>`，`ToolImageRunInput = { conversationId: number; messageId: number; toolCallId: string; model: ModelRef; prompt: string; params: ImageGenerationParams }`
  - `toolRunNotification(run: Pick<ArtifactRunRow, 'id' | 'status' | 'error' | 'tool_call_id'>, outputs: ReadonlyArray<Pick<ArtifactRow, 'id' | 'mime'>>): TaskNotificationPart`
  - `notifyToolRun(env: Env, userId: number, runId: number): Promise<void>`

- [ ] **Step 1: 失败测试（纯函数）**

`test/unit/artifact-notify.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { toolRunNotification } from '@/server/plugins/artifacts/notify'

describe('toolRunNotification', () => {
  it('lists every output path on success', () => {
    expect(toolRunNotification({ id: 12, status: 'completed', error: null, tool_call_id: 'call_1' }, [{ id: 31, mime: 'image/png' }, { id: 32, mime: 'image/webp' }]))
      .toEqual({
        type: 'task_notification', task_id: 'image_run:12', plugin_id: 'image_generation', tool_call_id: 'call_1',
        status: 'completed', text: 'Generated 2 image(s): /artifacts/31.png, /artifacts/32.webp',
      })
  })

  it('carries the provider error on failure', () => {
    const error = 'Images API request failed: 400 at /images/generations (moderation_blocked): Your request was rejected by the safety system.'
    expect(toolRunNotification({ id: 12, status: 'failed', error, tool_call_id: 'call_1' }, []))
      .toMatchObject({ status: 'failed', text: `Image generation failed: ${error}` })
  })

  it('reports a cancellation', () => {
    expect(toolRunNotification({ id: 12, status: 'cancelled', error: null, tool_call_id: 'call_1' }, []))
      .toMatchObject({ status: 'cancelled', text: 'Cancelled by the user.' })
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run test/unit/artifact-notify.test.ts` → FAIL

- [ ] **Step 3: 实现 `notify.ts`**

```ts
import { and, asc, eq, isNull } from 'drizzle-orm'
import { createDb } from '@/server/db/client'
import { artifactRuns, artifacts, type ArtifactRow, type ArtifactRunRow } from '@/server/db/schema'
import { disposeRpcStub } from '@/server/rpc'
import type { TaskNotificationPart } from '@/shared/parts'

export const IMAGE_GENERATION_PLUGIN_ID = 'image_generation'
const EXTENSION: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }

export function toolRunNotification(
  run: Pick<ArtifactRunRow, 'id' | 'status' | 'error' | 'tool_call_id'>,
  outputs: ReadonlyArray<Pick<ArtifactRow, 'id' | 'mime'>>,
): TaskNotificationPart {
  const base = { type: 'task_notification' as const, task_id: `image_run:${run.id}`, plugin_id: IMAGE_GENERATION_PLUGIN_ID, tool_call_id: run.tool_call_id ?? '' }
  if (run.status === 'completed') {
    const paths = outputs.map(output => `/artifacts/${output.id}.${EXTENSION[output.mime] ?? 'png'}`)
    return { ...base, status: 'completed', text: `Generated ${outputs.length} image(s): ${paths.join(', ')}` }
  }
  if (run.status === 'cancelled') return { ...base, status: 'cancelled', text: 'Cancelled by the user.' }
  return { ...base, status: 'failed', text: `Image generation failed: ${run.error ?? 'unknown error'}` }
}

/** Hands a settled tool run's outcome to the conversation. A run that is not a settled tool run is left alone. */
export async function notifyToolRun(env: Env, userId: number, runId: number): Promise<void> {
  const db = createDb(env.DB)
  const run = await db.query.artifactRuns.findFirst({ where: and(eq(artifactRuns.id, runId), eq(artifactRuns.user_id, userId)) })
  if (!run || run.source !== 'tool' || run.conversation_id === null || run.message_id === null) return
  if (run.status !== 'completed' && run.status !== 'failed' && run.status !== 'cancelled') return
  const outputs = await db.select({ id: artifacts.id, mime: artifacts.mime }).from(artifacts)
    .where(and(eq(artifacts.run_id, run.id), isNull(artifacts.deleted_at))).orderBy(asc(artifacts.output_index))
  const hub = env.USER_HUB.getByName(String(userId))
  try {
    await hub.settleTask(userId, { conversation_id: run.conversation_id, origin_message_id: run.message_id, notification: toolRunNotification(run, outputs) })
  } finally { disposeRpcStub(hub) }
}
```

（`ArtifactRow` / `ArtifactRunRow` 若 schema 未导出同名类型，用 `typeof artifacts.$inferSelect` 在 schema.ts 中导出，命名与已有 `ModelRow` 等一致。）

- [ ] **Step 4: Run** `pnpm vitest run test/unit/artifact-notify.test.ts` → PASS

- [ ] **Step 5: `resolveImageModel` 与 `createToolImageRun`**

`src/server/plugins/artifacts/image-model.ts`：

```ts
import type { DB } from '@/server/db/client'
import type { ConversationRow } from '@/server/db/schema'
import { getModel, getProvider } from '../hub/conversations'
import type { ModelRef } from '@/shared/model-ref'
import type { UserSettings } from '@/shared/models'

/** The conversation's own image model, else the user's global image slot; null when neither is usable. */
export async function resolveImageModel(
  db: DB, userId: number,
  conversation: Pick<ConversationRow, 'image_provider_id' | 'image_model_id'>,
  settings: UserSettings,
): Promise<ModelRef | null> {
  const candidates: ModelRef[] = []
  if (conversation.image_provider_id !== null && conversation.image_model_id !== null) {
    candidates.push({ provider_id: conversation.image_provider_id, model_id: conversation.image_model_id })
  }
  if (settings.service_models?.image) candidates.push(settings.service_models.image)
  for (const ref of candidates) {
    const provider = await getProvider(db, ref.provider_id, userId)
    const model = provider ? await getModel(db, provider.id, ref.model_id, userId) : undefined
    if (provider?.enabled && model?.enabled && model.supports_image_output) return ref
  }
  return null
}
```

`runs.ts`：把 `createImageRun` 中从 `const provider = await getProvider(...)` 到 `references.some(...)` 的校验抽成

```ts
async function resolveImageTarget(db: DB, userId: number, ref: ModelRef, referenceIds: readonly number[]) {
  // (moved verbatim) → returns { provider, model, selected }
}
```

`createImageRun` 改为调用它，行为不变。新增：

```ts
export interface ToolImageRunInput {
  conversationId: number
  messageId: number
  toolCallId: string
  model: ModelRef
  prompt: string
  params: ImageGenerationParams
}

/**
 * A run started by the Agent inside a chat. Unlike Studio it writes no messages and never moves
 * the head: the assistant message holding the call stays exactly as the turn left it.
 */
export async function createToolImageRun(ctx: Context, userId: number, input: ToolImageRunInput): Promise<{ run_id: number }> {
  const db = ctx.db.orm
  const clientRequestId = `tool:${input.messageId}:${input.toolCallId}`
  const existing = await db.query.artifactRuns.findFirst({ where: and(eq(artifactRuns.user_id, userId), eq(artifactRuns.client_request_id, clientRequestId)) })
  if (existing) return { run_id: existing.id }
  const { provider, model, selected } = await resolveImageTarget(db, userId, input.model, [])
  const workflowId = `artifact-${userId}-${clientRequestId.replaceAll(':', '-')}`
  const [run] = await db.insert(artifactRuns).values({
    user_id: userId, client_request_id: clientRequestId, kind: 'image_generation', source: 'tool', operation: 'generate',
    status: 'queued', conversation_id: input.conversationId, message_id: input.messageId, tool_call_id: input.toolCallId,
    provider_id: provider.id, provider_name: provider.name, interface_id: selected.id, interface_protocol: selected.protocol,
    credential_version: provider.credential_version, model_id: model.model_id, model_name: model.metadata_resolved.name ?? model.model_id,
    prompt: input.prompt, params: input.params, workflow_instance_id: workflowId, created_at: Date.now(),
  }).returning()
  try {
    disposeRpcStub(await ctx.env.ARTIFACT_WORKFLOW.create({ id: workflowId, params: { userId, runId: run!.id } }))
  } catch {
    await db.update(artifactRuns).set({ status: 'failed', error: 'Could not start image generation', completed_at: Date.now() })
      .where(and(eq(artifactRuns.id, run!.id), eq(artifactRuns.user_id, userId)))
    throw new Error('Could not start image generation')
  }
  return { run_id: run!.id }
}
```

检查 workflow instance id 允许的字符集（Cloudflare Workflows 要求 `^[a-zA-Z0-9_][a-zA-Z0-9-_]*$`，长度 ≤ 100）；`replaceAll(':', '-')` 即为此。

- [ ] **Step 6: workflow 与取消路由**

`workflow.ts`：把两处写 `messages` 的代码（成功时 `set({ parts: imageParts })`、失败时 `set({ status: 'error' ... })`）各自包在 `if (run.source !== 'tool')` 里，并加注释：tool run 的 `message_id` 是聊天里发起调用的 assistant 消息，它的内容属于那一轮，绝不能被生图结果覆盖；结果经通知回到对话。`artifactLinks` 照常写。

`api/artifacts.ts` 取消路由：`if (run.message_id !== null && run.conversation_id !== null)` 更新消息的分支改为额外要求 `run.source !== 'tool'`；在 `instance.terminate()` 的 `finally` 之后追加：

```ts
      // The Workflow is gone, so its notify step never runs; a cancelled tool run reports itself.
      if (run.source === 'tool') await notifyToolRun(ctx.env, userId, run.id).catch(error => console.error('cancel notify failed', error))
```

`src/server/index.ts` 的 `ArtifactGenerationWorkflow.run`：

```ts
    await step.do('generate image artifact', {
      retries: { limit: 0, delay: '1 second' },
      timeout: '30 minutes',
    }, async () => executeImageRun(await createApp({ env: this.env, side: 'workflow' }), event.payload.userId, event.payload.runId))
    // Delivery may start the Agent's next turn and waits for it, hence the long timeout. Retries are
    // safe: the hub delivers each task id once.
    await step.do('notify agent', {
      retries: { limit: 5, delay: '5 seconds', backoff: 'exponential' },
      timeout: '15 minutes',
    }, async () => notifyToolRun(this.env, event.payload.userId, event.payload.runId))
```

- [ ] **Step 7: Worker 测试**

在 `test/worker/artifact-workflow.test.ts` 追加一个用例，沿用该文件已有的 provider/model 播种方式（第二个用例 `sends the model extra body…` 可作模板），把对话建为 `kind: 'chat'` 并插入一条 assistant 消息作为 `message_id`：

```ts
  it('keeps the chat message untouched and records the outputs for a tool run', async () => {
    // seed user, provider, interface, image model (as in the extra-body test)
    // seed a chat conversation + assistant message with parts [{ type:'tool_call', id:'call_1', name:'generate_image', args:{} }]
    const startApp = await createApp({
      env: { ...env, ARTIFACT_WORKFLOW: { create: async ({ id }: { id: string }) => ({ id, dispose() {} }) } } as unknown as Env,
      side: 'worker',
    })
    const { run_id } = await createToolImageRun(startApp, userId, {
      conversationId, messageId: assistantId, toolCallId: 'call_1', model: { provider_id: provider!.id, model_id: 'image-model' },
      prompt: 'An otter', params: { count: 1, size: null },
    })
    vi.stubGlobal('fetch', async () => Response.json({ data: [{ b64_json: btoa(String.fromCharCode(...png)) }] }))
    await executeImageRun(await createApp({ env, side: 'workflow' }), userId, run_id)

    expect(await db.query.messages.findFirst({ where: eq(messages.id, assistantId) }))
      .toMatchObject({ parts: [{ type: 'tool_call', id: 'call_1' }] })
    expect(await db.query.artifactRuns.findFirst({ where: eq(artifactRuns.id, run_id) }))
      .toMatchObject({ status: 'completed', source: 'tool', tool_call_id: 'call_1', client_request_id: `tool:${assistantId}:call_1` })
  })
```

`createToolImageRun` 只用到 `ctx.db.orm` 与 `ctx.env.ARTIFACT_WORKFLOW`，所以 worker side 的 app 足够。聊天对话与 assistant 消息用 `createConversation(db, { user_id: userId, title: 't', provider_id: null, model_id: null })` 与 `insertMessage(...)` 播种（`@/server/plugins/hub/conversations`）。

再追加 Review Focus 4 的取消用例：通过 `startApp.api.request('/api/artifact-runs/<id>/cancel', { method: 'POST', headers: { cookie } })` 取消一个 queued 的 tool run（`env` 中 stub `ARTIFACT_WORKFLOW.get` 返回 `{ terminate: async () => {}, dispose() {} }`），断言：run `cancelled`；assistant 消息 `status` 仍为 `done`；以及 `USER_HUB` 收到 settle —— 用 `runInDurableObject` 读该对话消息，出现一条 `task_notification`（`status: 'cancelled'`）。

- [ ] **Step 8: Run tests**

Run: `pnpm vitest run test/unit/artifact-notify.test.ts && pnpm vitest run --project worker test/worker/artifact-workflow.test.ts && pnpm typecheck` → PASS

- [ ] **Step 9: Commit**

```bash
git add src/server/plugins/artifacts src/server/plugins/api/artifacts.ts src/server/index.ts src/server/db/schema.ts test/unit/artifact-notify.test.ts test/worker/artifact-workflow.test.ts
git commit -m "feat(artifacts): run Agent-started image jobs and notify their conversation"
```

---

### Task 4: `image_generation` 插件（服务端）

**Files:**
- Modify: `src/shared/plugins.ts`（ID 常量与 `BuiltInPluginId` / `BuiltInToolId` 联合）
- Create: `src/plugins/image-generation/manifest.ts`、`shared.ts`、`server/index.ts`
- Modify: `src/shared/plugin-manifests.ts`、`src/client/plugins/loaders.ts`（Task 5 补 client 模块，这里先注册 loader 指向将创建的 `client/index.ts`）、`src/server/app.ts`
- Test: `test/worker/image-generation-tool.test.ts`（新）

**Interfaces:**
- Consumes: Task 3 的 `createToolImageRun`、`resolveImageModel`、`IMAGE_GENERATION_PLUGIN_ID`
- Produces:
  - `IMAGE_GENERATION_PLUGIN_ID = 'image_generation'`、`GENERATE_IMAGE_TOOL_ID = 'generate_image'`（`src/shared/plugins.ts`；`notify.ts` 改为从这里导入）
  - `GenerateImageInputSchema = z.strictObject({ prompt: z.string().trim().min(1).max(4000), count: z.number().int().min(1).max(10).optional(), size: z.strictObject({ width: z.number().int().min(256).max(4096), height: z.number().int().min(256).max(4096) }).optional() })`
  - 工具结果 `GenerateImageStarted = { task_id: string; status: 'started'; count: number; model: string }` 或 `{ error: string }`

- [ ] **Step 1: 失败测试**

`test/worker/image-generation-tool.test.ts`，沿用 `test/worker/workspace-files-tools.test.ts` 的 `seedProvider` / `installModel` / `callTool`（L45–117）写法：聊天模型 `metadata_resolved: { tool_call: true }`，用户 `settings.plugins['image_generation'] = true`，对话 `tools` 包含 `generate_image`；另播种一个图片模型（`supports_image_output: true`，接口协议 `responses`）并写入 `users.settings.service_models.image`；`env.ARTIFACT_WORKFLOW` 无法在 DO 内替换时，改为断言结果与 `artifact_runs` 行（run 状态可为 `queued` 或 `failed: Could not start image generation`，二者都证明走到了创建）。

```ts
  it('starts a background run and returns at once', async () => {
    const { result } = await callTool(providerId, 'generate_image', { prompt: 'an otter', count: 2 })
    expect(result?.content).toMatchObject({ status: 'started', count: 2, task_id: expect.stringMatching(/^image_run:\d+$/) })
    const runId = Number((result!.content as { task_id: string }).task_id.split(':')[1])
    expect(await createDb(env.DB).query.artifactRuns.findFirst({ where: eq(artifactRuns.id, runId) }))
      .toMatchObject({ source: 'tool', prompt: 'an otter', params: { count: 2, size: null } })
  })

  it('explains the missing image model instead of failing the turn', async () => {
    // clear settings.service_models.image first
    const { result } = await callTool(providerId, 'generate_image', { prompt: 'an otter' })
    expect(result?.content).toEqual({ error: 'No image model is configured. Ask the user to choose one in Settings → Service models or in Image Studio.' })
  })
```

- [ ] **Step 2: Run** `pnpm vitest run --project worker test/worker/image-generation-tool.test.ts` → FAIL

- [ ] **Step 3: 实现**

`src/shared/plugins.ts`：新增两个常量并加入 `BuiltInPluginId` / `BuiltInToolId`。

`src/plugins/image-generation/shared.ts`：导出 `GenerateImageInputSchema`（见 Interfaces）与输出类型。

`src/plugins/image-generation/manifest.ts`：

```ts
import { GENERATE_IMAGE_TOOL_ID, IMAGE_GENERATION_PLUGIN_ID, type PluginManifest } from '@/shared/plugins'

const manifest = {
  id: IMAGE_GENERATION_PLUGIN_ID,
  name: '生成图片',
  description: '让模型在后台生成图片，完成后自动回到对话。使用会话或全局设置的生图模型。',
  tools: [{ id: GENERATE_IMAGE_TOOL_ID, name: '生成图片', description: '在后台生成一张或多张图片' }],
} satisfies PluginManifest
export default manifest
```

`src/plugins/image-generation/server/index.ts`：

```ts
import type { Context } from 'cordis'
import { tool } from 'ai'
import { createToolImageRun } from '@/server/plugins/artifacts/runs'
import { resolveImageModel } from '@/server/plugins/artifacts/image-model'
import { getConversation } from '@/server/plugins/hub/conversations'
import { GENERATE_IMAGE_TOOL_ID, IMAGE_GENERATION_PLUGIN_ID } from '@/shared/plugins'
import { UserSettingsSchema } from '@/shared/models'
import { GenerateImageInputSchema } from '../shared'

const DESCRIPTION = [
  'Generate images in the background with the image model the user configured.',
  'Returns immediately with a task_id. The result arrives later as a <task-notification> message listing the image paths;',
  'do not wait, poll, or call again for the same request. Tell the user it is on its way, or continue with other work.',
  'Write the prompt as a detailed visual description in the language that best suits the image model.',
].join(' ')

export const ImageGenerationServerPlugin = {
  name: 'image-generation',
  inject: ['tools', 'db', 'env'] as const,
  apply(ctx: Context) {
    ctx.tools.register(IMAGE_GENERATION_PLUGIN_ID, GENERATE_IMAGE_TOOL_ID, toolCtx => tool({
      description: DESCRIPTION,
      inputSchema: GenerateImageInputSchema,
      execute: async (input, { toolCallId }) => {
        const conversation = await getConversation(toolCtx.db, toolCtx.conversationId, toolCtx.userId)
        const user = await toolCtx.db.query.users.findFirst({ where: (row, { eq }) => eq(row.id, toolCtx.userId) })
        if (!conversation || !user) return { error: 'Conversation not found.' }
        const model = await resolveImageModel(toolCtx.db, toolCtx.userId, conversation, UserSettingsSchema.parse(user.settings ?? {}))
        if (!model) return { error: 'No image model is configured. Ask the user to choose one in Settings → Service models or in Image Studio.' }
        try {
          const count = input.count ?? 1
          const { run_id } = await createToolImageRun(ctx, toolCtx.userId, {
            conversationId: conversation.id, messageId: toolCtx.assistantMessageId, toolCallId, model,
            prompt: input.prompt, params: { count, size: input.size ?? null },
          })
          return { task_id: `image_run:${run_id}`, status: 'started' as const, count, model: model.model_id }
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) }
        }
      },
    }))
  },
}
```

`users` 表 settings 的读取方式、`UserSettingsSchema` 解析以 `src/server/plugins/hub/service-model.ts` / `hub/index.ts` 中的现有写法为准（照抄其读取 user settings 的那几行）。

三处注册：`plugin-manifests.ts` 导入并加入数组；`server/app.ts` 在 hub 分支 `await ctx.plugin(DatetimeServerPlugin)` 之后 `await ctx.plugin(ImageGenerationServerPlugin)`（并在其后断言 `ctx.get` 的模式与相邻插件一致）；`loaders.ts` 加 `[IMAGE_GENERATION_PLUGIN_ID]: () => import('@/plugins/image-generation/client/index') as Promise<ClientPluginModule>`。为了 typecheck 通过，本任务先建一个最小 `src/plugins/image-generation/client/index.ts`：`export const setup: ClientPluginSetup = () => {}`（Task 5 填充）。

`notify.ts` 删除本地 `IMAGE_GENERATION_PLUGIN_ID`，改从 `@/shared/plugins` 导入。

- [ ] **Step 4: Run** `pnpm vitest run --project worker test/worker/image-generation-tool.test.ts && pnpm vitest run test/unit/artifact-notify.test.ts && pnpm typecheck` → PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/plugins.ts src/shared/plugin-manifests.ts src/plugins/image-generation src/server/app.ts src/client/plugins/loaders.ts src/server/plugins/artifacts/notify.ts test/worker/image-generation-tool.test.ts
git commit -m "feat(plugins): add the image-generation plugin with a background generate_image tool"
```

---

### Task 5: 客户端——通知行、工具卡片、查看器来源

**Files:**
- Modify: `src/client/plugins/host.ts`（`notifications.register`、`ensureNotificationRenderer`）
- Create: `src/client/components/task-notification-row.vue`
- Modify: `src/client/components/message-item.vue`（L123–148 user 分支）
- Modify: `src/client/lib/conversation-export.ts`（L9–13）
- Create: `src/plugins/image-generation/client/index.ts`、`generate-image-card.vue`、`image-notification.vue`
- Modify: `src/client/views/image-artifact-detail.vue`（来源链接）
- Test: `test/unit/client-conversation-export.test.ts`（若存在则追加，否则新建）、`test/unit/client-plugin-host.test.ts`（若存在则追加）

**Interfaces:**
- Consumes: Task 1 的 `TaskNotificationPart`、`isNotificationOnly`；Task 4 的 ID 常量与 `GenerateImageStarted`
- Produces:
  - `ClientPluginContext.notifications: { register(renderer: NotificationRenderer): () => void }`，渲染器 props `{ notification: TaskNotificationPart }`
  - `ClientPluginHost.ensureNotificationRenderer(pluginId: string): Promise<NotificationRenderer | undefined>`

- [ ] **Step 1: 失败测试**

导出：`partMarkdown`（`src/client/lib/conversation-export.ts:7–15`）把未识别的 part 一律当成「工具结果」。在 `test/unit/client-conversation-export.test.ts` 追加（`conversation` / `message` 构造沿用该文件已有 fixture）：

```ts
  it('exports a task notification as its summary, not as a tool result', () => {
    const markdown = conversationExporters.markdown.serialize({
      conversation, attachmentUrl: id => `/a/${id}`,
      messages: [{ ...message, role: 'user', parts: [{
        type: 'task_notification', task_id: 'image_run:1', plugin_id: 'image_generation', tool_call_id: 'c',
        status: 'completed', text: 'Generated 1 image(s)',
      }] }],
    })
    expect(markdown).toContain('> 后台任务（completed）：Generated 1 image(s)')
    expect(markdown).not.toContain('工具结果')
  })
```

Host：追加用例——插件 setup 里 `ctx.notifications.register(X)` 后，`host.ensureNotificationRenderer('image_generation')` 解析为 `X`；未注册的 plugin id 解析为 `undefined`。照该文件测试 `tools.register` / `ensureToolRenderer` 的现有写法。

- [ ] **Step 2: Run** 对应 unit 测试 → FAIL

- [ ] **Step 3: 实现**

`host.ts`：仿照 `tools` 的注册表，新增 `export type NotificationRenderer = unknown`、上下文字段 `notifications`（按 setup 所属插件 id 记录）与 `ensureNotificationRenderer(pluginId)`（懒加载该插件后返回）。

`task-notification-row.vue`（Pug，与 `message-item.vue` 同风格）：

```vue
<script setup lang="ts">
import { onMounted, shallowRef } from 'vue'
import { BellIcon, CircleAlertIcon, CircleSlashIcon } from '@lucide/vue'
import { inject, type Component } from 'vue'
import type { ClientPluginHost } from '@/client/plugins/host'
import type { TaskNotificationPart } from '@/shared/parts'

const props = defineProps<{ notification: TaskNotificationPart }>()
// Same injection as tool-part-renderer.vue: absent in isolated component tests, which fall back to text.
const host = inject<ClientPluginHost | null>('clientPluginHost', null)
const renderer = shallowRef<Component | null>(null)
onMounted(async () => {
  if (host) renderer.value = ((await host.ensureNotificationRenderer(props.notification.plugin_id)) ?? null) as Component | null
})
const LABEL = { completed: '后台任务完成', failed: '后台任务失败', cancelled: '后台任务已取消' } as const
</script>

<template lang="pug">
.flex.flex-col.gap-2.rounded-lg.border.border-dashed.px-3.py-2.text-sm.text-muted-foreground(role="status")
  .flex.items-center.gap-2
    CircleAlertIcon(v-if="notification.status === 'failed'" class="size-4 text-destructive")
    CircleSlashIcon(v-else-if="notification.status === 'cancelled'" class="size-4")
    BellIcon(v-else class="size-4")
    span {{ LABEL[notification.status] }}
  component(v-if="renderer" :is="renderer" :notification="notification")
  p.whitespace-pre-wrap.text-xs(v-else) {{ notification.text }}
</template>
```

`message-item.vue`：user 分支中，`isNotificationOnly(message.parts)` 时不渲染 `Bubble`，改为 `TaskNotificationRow(v-for=… :notification="part")`，且对齐改为 `start`、不显示编辑等用户消息操作；混合消息时在气泡上方渲染通知行，气泡里仍只渲染 text/image。

`conversation-export.ts` 的 `partMarkdown` 在 `tool_call` 分支之后加：

```ts
    if (part.type === 'task_notification') return `> 后台任务（${part.status}）：${part.text}`
```

插件客户端 `src/plugins/image-generation/client/index.ts`：

```ts
import type { ClientPluginSetup } from '@/client/plugins/host'
import { GENERATE_IMAGE_TOOL_ID } from '@/shared/plugins'
import GenerateImageCard from './generate-image-card.vue'
import ImageNotification from './image-notification.vue'

export const setup: ClientPluginSetup = (ctx) => {
  ctx.tools.register(GENERATE_IMAGE_TOOL_ID, GenerateImageCard)
  ctx.notifications.register(ImageNotification)
}
```

`generate-image-card.vue`：props `{ call: ToolCallPart; result: ToolResultPart | null }`。
- `result` 为空：旋转图标 +「正在提交生图任务…」。
- `result.content` 含 `error`：`Alert`（destructive）显示消息。
- 含 `task_id`：解析 run id，`onMounted` 起轮询 `api.artifactRun(id)`（间隔 1.5s，`onBeforeUnmount` 清理），`queued/running` 时显示 `count` 个方形 `Skeleton` 与「取消」按钮（`api.cancelArtifactRun(id)`）；终态后 `api.artifacts({ run_id: id })` 取输出，按 `output_index` 排序渲染缩略图网格（`api.artifactContentUrl(a.id, 'gallery')`，`RouterLink` 到 `/images/a/${a.id}`）；`failed` 显示 `run.error`；`cancelled` 显示「已取消」。网格列数规则与 Studio 的 `gridClass` 相同（复制该函数，不要跨组件导入视图内部函数）。

`image-notification.vue`：props `{ notification: TaskNotificationPart }`；从 `task_id` 取 run id，`api.artifacts({ run_id })` 渲染一排小缩略图（`size-16`），失败/取消时只显示 `notification.text`。

`image-artifact-detail.vue`：来源链接改为

```ts
const sourcePath = computed(() => {
  const value = artifact.value
  if (!value?.conversation_id) return null
  return value.source === 'tool' ? `/c/${value.conversation_id}` : `/images/s/${value.conversation_id}`
})
```

模板中 `RouterLink(:to="sourcePath")`，`v-if="sourcePath"`。

- [ ] **Step 4: Run** 相关 unit 测试 + `pnpm typecheck` → PASS

- [ ] **Step 5: 浏览器验证（本地 dev，Mock Image）**

前置：`pnpm seed:mock`；在设置里启用「生成图片」插件；全局服务模型的「图片」选 Mock Image；聊天模型选 `mock-tools`。用 mock 的 `/tool_call generate_image {"prompt":"an otter","count":2}` 指令触发工具调用。

逐项确认并截图：
1. 工具卡片立刻出现并显示 2 个骨架格；本轮回复正常结束。
2. 约 2–3 秒后出现通知行「后台任务完成」+ 缩略图，随后 Agent 自动开始新一轮回复。
3. 刷新页面后通知行、卡片缩略图仍在。
4. 点击缩略图进入查看器，「来源」链接跳回该聊天。
5. 再次触发后在卡片上点「取消」：卡片变「已取消」，出现「后台任务已取消」通知行，原 assistant 消息不被标成 aborted。

- [ ] **Step 6: Commit**

```bash
git add src/client src/plugins/image-generation test/unit
git commit -m "feat(client): render task notifications and the generate_image card"
```

---

### Task 6: 上游错误原文（脱敏后）

与其他任务无依赖，可最先执行。

**Files:**
- Modify: `src/server/plugins/llm/images/openai.ts`（`UPSTREAM_CODE` / `upstreamCode` / `readResponse`，L48–73）
- Test: `test/unit/images-api-error.test.ts`

**Interfaces:**
- Produces: 失败时 `Error.message` 形如 `Images API request failed: <status> at <path>[ (<code>)][: <redacted message>]`，写入 `artifact_runs.error`，经 Task 3 的 `toolRunNotification` 到达 Agent。
- Consumes: 无。

- [ ] **Step 1: 改写测试**

`test/unit/images-api-error.test.ts`：第一个用例改为断言原文**出现**：

```ts
  it('names the endpoint, the upstream code and what the provider said', async () => {
    respondWith(400, JSON.stringify({ error: { code: 'moderation_blocked', message: 'Your request was rejected by the safety system.' } }))
    const client = createOpenAIImagesClient(BASE, 'key')

    const failure = await client.generate(request()).catch((error: Error) => error.message)

    expect(failure).toBe('Images API request failed: 400 at /images/generations (moderation_blocked): Your request was rejected by the safety system.')
  })
```

新增：

```ts
  it('redacts credentials a provider echoes back', async () => {
    const key = 'sk-live-0123456789abcdefghij'
    respondWith(401, JSON.stringify({ error: { message: `Incorrect API key ${key}; header was Bearer ${key}. Try ak_9f8e7d6c5b4a3210 or token abcdefghijklmnopqrstuvwxyz0123456789ABCD.` } }))
    const client = createOpenAIImagesClient(BASE, key)

    const failure = await client.generate(request()).catch((error: Error) => error.message)

    expect(failure).toContain('Incorrect API key')
    expect(failure).not.toContain(key)
    expect(failure).not.toContain('ak_9f8e7d6c5b4a3210')
    expect(failure).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789ABCD')
  })

  it('caps the provider text at 500 characters', async () => {
    respondWith(400, JSON.stringify({ error: { message: 'too long '.repeat(200) } }))
    const failure = await createOpenAIImagesClient(BASE, 'key').generate(request()).catch((error: Error) => error.message)
    expect(failure.length).toBeLessThanOrEqual('Images API request failed: 400 at /images/generations: '.length + 500)
  })
```

其余三个用例保留：`reports the edits endpoint…`、`still reports the endpoint when the body is not the shape we expect`（非 JSON 仍不带原文）、`drops a code that is not a short token…`（`code` 字段仍只接受短 token；该用例的 `sk-abc123` 在 `code` 里，不在 `message` 里，断言不变）。

- [ ] **Step 2: Run** `pnpm vitest run test/unit/images-api-error.test.ts` → FAIL

- [ ] **Step 3: 实现**

`openai.ts`：`upstreamCode` 改为 `upstreamError(response, apiKey): Promise<{ code: string | null; message: string | null }>`，在同一次 `JSON.parse` 里取 `error.code`（规则不变）与 `error.message ?? message`（字符串才取），`message` 经 `redact`：

```ts
const MAX_UPSTREAM_MESSAGE = 500

/**
 * A provider's error text tells the person — and an Agent retrying the request — why it was
 * refused, so it travels into `artifact_runs.error`. It is also free text that may quote the
 * request back, credentials included, so it is redacted first: the key this request used, bearer
 * tokens, key-shaped tokens, and any long unbroken token. Do not pass it through unredacted.
 */
function redact(text: string, apiKey: string): string {
  let out = apiKey ? text.split(apiKey).join('[redacted]') : text
  out = out.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
  out = out.replace(/\b(?:sk|ak|pk|key)[-_][A-Za-z0-9_-]{8,}/gi, '[redacted]')
  out = out.replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]')
  return out.trim().slice(0, MAX_UPSTREAM_MESSAGE)
}
```

`readResponse` 需要 `apiKey`：把它加为参数，由 `createOpenAIImagesClient` 的 `generate` 传入。错误组装：

```ts
    const { code, message } = await upstreamError(response, apiKey)
    throw new Error(`Images API request failed: ${response.status} at ${path}${code === null ? '' : ` (${code})`}${message ? `: ${message}` : ''}`)
```

同时改写 `UPSTREAM_CODE` 上方那段注释：`code` 仍只接受短 token；`message` 走 `redact` 后可以进入 `artifact_runs.error`。

- [ ] **Step 4: Run** `pnpm vitest run test/unit/images-api-error.test.ts test/unit/llm-images.test.ts` → PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/plugins/llm/images/openai.ts test/unit/images-api-error.test.ts
git commit -m "feat(images): keep the provider's redacted error text on failed runs"
```

---

## 收尾

- [ ] 全量：`pnpm typecheck && pnpm test`
- [ ] 推送分支：`git push`
- [ ] 计划 2（投影挂载、读图、`reference_images`）在本计划合并后另写。
