# 后台任务与 generate_image 工具

## 1. 范围

- **后台任务（核心）**：工具发起、在当前回复之外完成的工作。工具立即返回，工作完成后以一条通知消息回到对话，并让 Agent 接着处理。
- **generate_image（插件）**：第一个后台任务。Agent 调用它生成图片，走与 Studio 相同的 Artifact run、Workflow、Gallery。
- 生成的图片以 asset 的形式回到对话，文件引用、读图与改图的引用方式见 [会话文件 spec](2026-09-28-conversation-files-design.md)。

替代 [图片生成 spec](2026-09-09-image-generation-design.md) §Phase 2 Boundary 中「停止当前生成、完成后续写」的方案。

不在范围内：任务面板、由模型取消任务、生图以外的任务类型、Responses 原生生图。

## 2. 后台任务

### 2.1 职责划分

核心不保存任务状态。任务状态归发起它的领域（生图任务即 `artifact_runs`），核心只负责**完成通知的投递**：写入消息、决定是否续写。

### 2.2 启动

后台工具的 `execute` 立即返回，工具结果为：

```json
{ "task_id": "image_run:12", "status": "started" }
```

工具描述必须告诉模型：结果稍后会以 `<task-notification>` 送达，不要等待、不要轮询、不要重复发起；可以先回复用户，或继续做别的事。

### 2.3 通知 Part

新增 Part：

```ts
{
  type: 'task_notification'
  task_id: string          // 领域前缀 + 领域 id，如 "image_run:12"
  plugin_id: string
  tool_call_id: string
  status: 'completed' | 'failed' | 'cancelled'
  text: string             // 给模型看的摘要，由领域生成
}
```

通知存放在 `role: 'user'` 的消息中。一条消息可以包含多条通知；与用户插话同时到达时，通知在前，用户原话在后。

`buildModelMessages` 把每条通知渲染为 user 文本（对话中途的 `developer`/`system` 消息并非所有协议都接受）：

```text
<task-notification>
<task-id>image_run:12</task-id>
<status>completed</status>
<summary>…</summary>
</task-notification>
```

### 2.4 投递入口

领域在任务结束时调用 `UserHub.settleTask(userId, { conversation_id, origin_message_id, notification })`（DO RPC，与 `publishConversation` 同一模式）。`origin_message_id` 是包含该工具调用的 assistant 消息。

- DO 先把通知写入 DO storage 的待投递队列（键前缀 `task:`），再投递。队列必须持久化：插话用的 stash 只在内存里。
- DO 重启后，`Hub[Service.init]` 发现队列非空时立即设置 alarm，由 alarm 投递。
- 幂等：对话中已有消息包含相同 `task_id` 的通知时，丢弃。

### 2.5 投递规则

1. **分支**：`origin_message_id` 必须是当前 head 的祖先或 head 本身。否则不投递给模型（出队丢弃），结果仍显示在工具卡片上。
2. **生成中**：通知留在队列。`prepareStep` 在两个 step 之间取出，与 stash 中的用户插话一起写成 user 消息（复用插话的 handoff），回复在其下继续。只有通知时不标记 `INTERJECTED`，模型侧也不加中断提示。这一轮最后一步之后才到达的通知，由这一轮结束时投递。
3. **空闲**：以 head 为父写入一条只含通知的 user 消息，并按对话的有效配置发起新一轮生成，与 `runSend` 相同，只是由服务端发起。
4. **合并**：同时待投递的多条通知写进同一条消息。
5. **续写上限**：沿当前路径往回数，自最后一条含用户原话的 user 消息以来，只含通知的 user 消息达到 5 条时，只写入通知，不发起生成。
6. **等待人工**：head 上有未回答的人工工具调用（如 `ask_user`）时不投递，留在队列。
7. **模型**：服务端发起的一轮以发起任务那条 assistant 消息的模型作为兜底（每轮的模型本由客户端选择）。

### 2.6 UI

只含通知的 user 消息不渲染为用户气泡，而是一行系统通知：状态图标 +「后台任务完成 / 失败 / 已取消」+ 插件渲染的详情。插件在客户端按 `plugin_id` 注册通知渲染器；未注册时显示 `text`。

## 3. generate_image 插件

### 3.1 注册

插件 id `image_generation`，工具 `generate_image`，默认不启用，按对话选择开启（保持工具列表稳定以利于前缀缓存）。全局设置可让新对话默认开启。

### 3.2 输入

带 `reference_images` 即为改图（run 的 `operation = 'edit'`），工具描述写明「生成或编辑图片」。生图模型不支持图片输入时，工具返回错误，不创建 run。

```ts
{
  prompt: string
  count?: number                 // 1..应用上限，默认 1
  size?: { width: number; height: number }
  reference_images?: string[]    // 文件引用 asset:<id> / vfs:<路径>
}
```

模型与其余参数不由 LLM 选择：模型按「对话生图模型 > 全局 `service_models.image`」解析；extra body 使用模型默认值。

### 3.3 创建 run

`createImageRun` 增加工具来源：

- `source = 'tool'`，`conversation_id` 为聊天对话，`message_id` 为包含工具调用的 assistant 消息，`tool_call_id` 为调用 id。
- 不插入图片对话的消息，不移动 head。
- 幂等键 `client_request_id = tool:<message_id>:<call_id>`。
- 参考图经 `resolveFileRef` 解析为 attachment id（[会话文件 spec](2026-09-28-conversation-files-design.md) §4.3、§7）；解析失败或非图片时工具直接返回错误，不创建 run。

### 3.4 结束

Workflow 结束一个 `source = 'tool'` 的 run 后调用 `settleTask`：

| 状态 | 摘要 |
|---|---|
| completed | `Generated N image(s): asset:5c2e8f10, asset:9a01d3c4`（sha256 前缀），产物 attachment id 记入通知 part 的 `attachments` |
| failed | `Image generation failed: <run.error>` |
| cancelled | `Cancelled by the user.` |

### 3.5 UI

- 工具卡片：运行中轮询 `GET /api/artifact-runs/:id`，显示骨架格与取消按钮；完成后显示缩略图网格，点击进入 `/images/a/:id` 查看器。
- 通知详情：该 run 的缩略图。
- 查看器的来源链接按对话类型跳转：图片对话 `/images/s/:id`，聊天对话进入对应聊天。

## 4. 读图

模型查看生成的图片与用户上传的文件（`read_file`，由 `file_reader` 插件提供）及其交付方式见 [会话文件 spec](2026-09-28-conversation-files-design.md) §4。
