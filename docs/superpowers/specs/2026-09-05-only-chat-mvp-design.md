# only-chat MVP 设计

## 1. 背景与目标

现有桌面/自托管 AI 聊天客户端（Cherry Studio、LobeHub、OpenWebUI）在多设备同步、部署复杂度、工具调用设计上各有硬伤。only-chat 是一个部署在 Cloudflare 上的个人 Web 聊天平台，目标是：

- 任何设备打开浏览器就能聊，历史、会话列表、**正在生成中的回复**全设备实时一致（体验对标 QQ 多端同时在线）。
- 主流供应商随便接：协议只有四种，供应商只是"协议 + 预填 endpoint"。
- 存储与协议解耦，为 presets、agents、知识库等后续子项目留好挂点，但 MVP 本身只做聊天。

## 2. 范围

### MVP 包含

- 多租户数据模型（所有表带 `user_id`），但 MVP 阶段 `user_id` 硬编码为 `1`，无登录。
- 供应商与模型管理：四种协议、预制供应商模板、手填模型、从 `/models` 拉取模型。
- 会话与消息：树状分支（编辑/重生成产生兄弟节点）、分支切换器、停止生成。
- 消息内容：文本（markdown 渲染）、图片（粘贴/拖入，存 R2）、reasoning 折叠展示。
- 多设备实时同步：每用户一条 WebSocket，进行中的生成在服务端跑完，任意设备可随时接上。
- 会话级 system prompt 与采样参数。

### MVP 不包含（后续子项目）

- 用户系统 / passkey 登录（上线前必做；临时上线用 Cloudflare Zero Trust 挡门）。
- presets、agents、tools / MCP、知识库（AutoRAG）。
- 成本估算、models.dev 价格同步（但 `models.pricing` 列现在就留）。
- 附件删除与"我的文件"页面（但 `attachments` 表和路由结构现在就按此设计）。
- 上下文裁剪、消息搜索、导入导出、虚拟滚动、数学公式以外的富媒体。

## 3. 技术栈

- 运行时：Cloudflare Workers + Durable Objects + D1 + R2。KV 在 MVP 中不使用。
- 后端：Hono 4（HTTP 路由）+ cordis 4（DI / 插件 / 事件总线，rc 线，锁版本）+ Drizzle ORM 0.45（D1 driver；不用 1.0-RC）+ Vercel AI SDK 7 core（协议层）。
- 前端：Vue 3（pug 模板 + scss）+ Vite 8 + vue-router 5 + Pinia 4 + shadcn-vue 2（Tailwind 4）+ markstream-vue 2。
- 一体化：`@cloudflare/vite-plugin`，本地 `vite dev` 与线上 Worker 行为一致，一条 `wrangler deploy` 同时发布前端与 API。
- 测试：Vitest 4（锁 4.1.x，5 与 CF 插件不兼容）；DO 集成测试用 `@cloudflare/vitest-plugin`（`vitest-pool-workers` 的新名字）。
- TypeScript 用 6.0.x（7.x 破坏 vue-tsc；不用 `baseUrl`）。包管理：pnpm。
- 各库的核实笔记（版本、签名、坑）在 plan 中随任务引用。

## 4. 架构

### 4.1 运行时拓扑

```
浏览器 ──HTTP──▶ Worker (Hono)
   │               ├─ /api/*   REST：读会话/消息、供应商/模型配置、附件
   │               ├─ /ws      升级后转发给 UserHub DO
   │               └─ /*       静态前端（SPA 回退到 index.html）
   └───WS────▶ UserHub DO（每用户一个，id = idFromName(String(user_id))）
                    ├─ 持有该用户所有在线设备的 socket（Hibernation API）
                    ├─ 执行生成：AI SDK streamText → 广播 delta → 完成后写 D1
                    └─ storage 只放进行中的生成缓冲
D1：唯一持久真相源
R2：图片原件
```

### 4.2 写路径规则

**所有改变会话/消息状态的操作都经过 DO**：发消息、重生成、编辑、停止、切换分支、改标题/模型/system prompt、删除会话。DO 写 D1 后向全部 socket 广播事件。REST 只承担纯读和与会话无关的配置（供应商、模型、附件）。多设备一致性只在 DO 这一处保证。

### 4.3 真相源分层

- D1：唯一持久真相源。
- DO storage：仅存"进行中"的生成状态（缓冲的 parts、开始时间），生成结束即删除。DO 被驱逐重建最多丢失约 1 秒的缓冲；alarm 兜底把超时任务收尾为 `aborted`。
- 无生成任务且客户端静默时 DO 休眠；alarm 只在有进行中生成时设置。

### 4.4 cordis 的用法

cordis 是后端的骨架，不是风味 DI。要用足的三项能力：

- **依赖解析**：每个插件用 `inject` 声明依赖的服务（如 hub 依赖 `llm` 与 `database`，llm 依赖 `database`），装载顺序由 cordis 解析，代码里不写任何"等待某服务就绪"的轮询。
- **生命周期与副作用回收**：插件注册的事件监听、定时器、路由等副作用全部挂在自己的 scope 上，`dispose` 时由 cordis 统一回收。插件不得持有需要手动清理的全局状态。
- **运行时热插拔**：核心插件（database、assets、llm、hub、api）常驻；功能插件可由用户在设置中开关，开关状态存于用户设置，DO 侧根据它 `ctx.plugin` / `dispose` 对应插件，无需重新部署。MVP 只搭这套机制并提供开关入口，不附带任何功能插件。DO 侧根据 `settings.plugins` 实际 `ctx.plugin` / `dispose` 功能插件尚未实现，settings 目前只存储开关状态、UI 只是个空白的开关列表（实现阶段调整）。

能通过换插件解耦的：`Database`（Drizzle 驱动无关）、`Assets`（R2 / 本地 / S3）、`LlmProtocol` 注册表（每种协议一个插件）。**不解耦的**：UserHub 直接依赖 DO API（Hibernation WebSocket、alarm、单实例串行写），自部署时需重写 Hub 插件而非换配置；MVP 不为其抽象通用接口。

**生成流程分阶段**：hub 内的生成流程拆成独立函数，阶段间传递明确的数据结构：接收命令 → 校验与分派 → 组装上下文（取路径、system prompt、模型）→ `buildModelMessages` → 流式生成 → 落库与广播。事件在阶段边界发出；未来新增钩子只是在某个边界多一行 `emit`。

**已知坑**：cordis 用 Proxy 包装 Context 与 Service，被托管的类里不能用 ES `#private` 字段（brand check 在 Proxy 上失败，同 Vue3 reactive）。统一用 TypeScript `private`。

Workers 的 `env` 只在请求 / DO 构造函数内可得，因此 cordis 根 Context 建两份：

- Worker 侧：首个请求时懒初始化，装载 database、assets、api 插件，服务 REST。
- DO 侧：构造函数内创建，在 `blockConcurrencyWhile` 中 `await` 全部核心插件装载完成（cordis 插件激活永远是异步的），装载 database、assets、llm、hub 插件。

两侧共享同一组插件定义，仅装载清单不同。两侧都必须注册 `ctx.logger.exporter` 把日志转到 `console`，否则 cordis 会把插件加载错误吞进内存缓冲。

### 4.5 事件

命名沿用 `域/动作` 风格，MVP 至少定义：`session/created`、`session/updated`、`session/deleted`、`message/before-send`（参数：即将交给 `buildModelMessages` 的 system prompt 与路径消息数组，插件可修改）、`message/done`。事件不限制插件改什么；项目自身插件遵守"只动即将发送的最后一条"的约定，以免破坏第 7 节的前缀一致性。

## 5. 仓库结构

单 package，不做 monorepo。

```
only-chat/
├─ src/
│  ├─ client/                 Vue 3 SPA
│  │  ├─ app.vue, main.ts, router.ts
│  │  ├─ stores/              sync.ts, config.ts
│  │  ├─ lib/                 ws-client.ts, image-prep.ts, api.ts
│  │  ├─ views/               chat.vue, settings-providers.vue, settings-provider-edit.vue
│  │  ├─ components/          session-list, message-list, message-item, branch-switcher, composer, model-picker
│  │  └─ ui/                  shadcn-vue 生成的组件
│  ├─ server/
│  │  ├─ index.ts             Worker 入口 + UserHub DO 类导出
│  │  ├─ app.ts               创建 cordis 根、按 side 装载插件
│  │  ├─ plugins/
│  │  │  ├─ database/         Drizzle + D1 driver，暴露 ctx.db
│  │  │  ├─ assets/           R2，暴露 ctx.assets
│  │  │  ├─ llm/              协议注册表、四个协议子插件、messages.ts、usage.ts、presets.ts
│  │  │  ├─ hub/              DO 内：socket 管理、seq 分配、生成执行、事件广播
│  │  │  └─ api/              Hono 路由
│  │  └─ db/schema.ts         Drizzle schema
│  └─ shared/                 parts.ts、ws.ts、api.ts（zod schema + 类型，前后端唯一来源）
├─ migrations/                drizzle-kit 生成的 D1 SQL
├─ docs/superpowers/          specs、plans
├─ drizzle.config.ts
├─ wrangler.jsonc
└─ vite.config.ts
```

`shared/` 是硬边界：parts、WS 事件、API DTO 只在这里定义一次。

## 6. 数据模型（D1，Drizzle）

### users
`id`、`name`、`settings`（JSON：`{ plugins: Record<string, boolean> }`，功能插件开关；MVP 无功能插件，默认 `{}`）、`created_at`。MVP 只有 `id = 1` 一行。

### providers
`id`、`user_id`、`name`、`protocol`（`openai-completions` | `openai-responses` | `anthropic` | `vertex`）、`base_url`、`api_key`（AES-GCM 加密存储，密钥来自 Worker secret `KEY_ENCRYPTION_SECRET`）、`extra`（JSON，协议特有配置，如 Vertex 的 project / location）、`enabled`、`created_at`。

预制供应商不是表数据，而是 `plugins/llm/presets.ts` 中的模板清单 `{name, protocol, baseUrl, models}`；"添加预制供应商"即用模板预填表单后正常插入。

### models
`id`、`provider_id`、`model_id`（发给 API 的字符串）、`display_name`、`capabilities`（JSON：`vision` / `reasoning` / `tools` 布尔）、`pricing`（JSON 可空：`input` / `output` / `cached` 每百万 token 价格）、`enabled`、`sort`。拉取 `/models` 即批量 upsert，手填即插一行。

### sessions
`id`、`user_id`、`title`、`head_message_id`（当前叶子，可空）、`provider_id`、`model_id`（会话默认模型）、`system_prompt`（可空）、`params`（JSON：temperature、top_p、max_tokens 等，可空）、`created_at`、`updated_at`、`archived_at`（可空）。

### messages
`id`、`session_id`、`parent_id`（根为 null）、`seq`（DO 分配，per-session 单调递增）、`role`（`user` | `assistant`）、`parts`（JSON 数组）、`provider_id` / `model_id`（assistant 消息实际使用的模型，user 消息为 null）、`usage`（JSON 可空）、`status`（`done` | `error` | `aborted`；`streaming` 只存在于 DO，不落库）、`error`（文本可空）、`created_at`。

索引：`(session_id, seq)` 唯一、`(parent_id)`。

**排序规则**：当前上下文 = 从 `head_message_id` 沿 `parent_id` 回溯到根。兄弟节点按 `seq` 排序。`created_at` 仅供展示，永不用于排序或重建历史。

### attachments
`id`、`user_id`、`sha256`、`mime`、`size`、`width`、`height`、`r2_key`、`origin`（`upload` | `generated`）、`created_at`。索引：`(user_id, sha256)` 唯一。R2 key 为 `{user_id}/{sha256[0:2]}/{sha256}`。MVP 不做删除。

### parts（`shared/parts.ts`）

```
text        { type: 'text', text }
image       { type: 'image', attachment_id }
reasoning   { type: 'reasoning', text, providerOptions? }   // 存 AI SDK 回放时需要的 providerOptions（由流事件的 providerMetadata 转来）
tool_call   { type: 'tool_call', id, name, args }          // MVP 定义不产生
tool_result { type: 'tool_result', call_id, content }      // MVP 定义不产生
```

assistant 消息的 reasoning、text、tool_call 都是同一条消息的 parts，不拆行。存储格式与协议格式解耦，发送前由 `buildModelMessages` 转换。

### usage（JSON）
`{ prompt?, completion?, cached?, reasoning? }`，`undefined` 表示供应商未报告，`0` 表示报告为 0，二者不可混同。

## 7. LLM 层

### 7.1 结构（`plugins/llm/`）

- 注册表：`ctx.llm.register(protocol, factory)`；四个子插件各注册一个 `factory(providerRow, modelRow) => LanguageModel`，分别基于 `@ai-sdk/openai`（`openai-completions` 用 `.chat()`；`openai-responses` 用 `.responses()`，注意 SDK 7 默认即 responses）、`@ai-sdk/anthropic`、`@ai-sdk/google-vertex/edge`（必须 `/edge` 路径；SDK 不缓存 OAuth token，每请求签一次 JWT，llm 插件内按 provider 缓存 token）、`@ai-sdk/openai-compatible`（必须 `includeUsage: true` 才有流式 usage）。`base_url`、解密后的 key、`extra` 在 factory 内注入，所有凭据显式传参，不依赖 `process.env`。Vertex 的 llm 插件内按 provider 缓存 OAuth token 尚未实现：MVP 每次生成都重新签发 JWT 并换取 access token（实现阶段调整）。
- `messages.ts`：`buildModelMessages(systemPrompt, pathMessages, protocol)` 纯函数，输出 AI SDK 的 `ModelMessage[]`，以及 `result.stream` 事件到本项目 delta / part 的归一化。只消费 `text-delta`、`reasoning-delta`、`reasoning-end`（取 providerMetadata）、`tool-call`、`finish`、`abort`、`error`。
- `usage.ts`：AI SDK 7 的嵌套 usage（`inputTokenDetails.cacheReadTokens` 等）映射为本项目的扁平 `{ prompt, completion, cached, reasoning }`；`undefined` 与 `0` 区分保留。
- `presets.ts`：预制供应商模板。

### 7.2 前缀一致性不变量

同一条路径、同一 system prompt、同一协议，`buildModelMessages` 的输出必须逐字节相同，无论 parts 来自内存还是 D1 读回。目的是命中供应商的前缀缓存。为此：

- 请求级可变信息（时间、设备、随机数）不得进入 messages 或 system prompt。
- `reasoning` part 原样保存供应商附属数据（Anthropic thinking `signature` / `redactedData`、OpenAI responses 的 `itemId` / `reasoningEncryptedContent`）于 `providerOptions`，回放时原样带回。流式累积时以最后一个非空 `providerMetadata` 为准（签名在块末尾到达）。
- `openai-compatible` 协议的 reasoning 没有可回放的元数据，`buildModelMessages` 对该协议**固定剔除** reasoning parts（规则确定，仍满足不变量）。
- OpenAI responses 协议固定 `store: false`，reasoning 靠 `reasoningEncryptedContent` 回放，不依赖服务端状态。
- `text` part 不做任何规范化：不 trim、不改换行。
- image 始终以 base64 内联发送（从 R2 读 bytes），不用 URL。
- MVP 不做上下文裁剪，整条路径全部发送。未来裁剪规则必须单调（只在 turn 边界砍最老的）且实现在此函数内。
- tools 列表（未来）的顺序与 schema 必须确定性。
- Anthropic `cache_control` 断点规则固定：system prompt 一个、路径中最后一条 user 消息一个，通过消息级 `providerOptions` 传递，不影响 messages 内容。为此 system prompt 以 `role: 'system'` 消息放进 `messages` 数组并开启 `allowSystemInMessages`，四种协议统一走这条路径。
- 测试：构造含 text / image / reasoning 的多分支树，取一条路径，内存构建与 D1 round-trip 后构建深比较相等；每种协议一个 golden 快照。

### 7.3 part_index 维护

DO 侧按流事件维护当前 part：连续同类 delta 追加到同一 part，类型切换时开新 part。`message.delta` 事件携带 `part_index`，客户端按 index 追加。

## 8. 实时协议与 UserHub

### 8.1 连接

客户端连 `/ws`，Worker 转发给 `UserHub`。DO 用 Hibernation API 接管 socket。多设备即多个 socket 挂在同一 DO，DO 不区分设备身份，只做广播。

### 8.2 事件类型（`shared/ws.ts`，zod，全部带 `type`；命令可带 `request_id`）

客户端 → DO：

| type | 字段 | 语义 |
|---|---|---|
| `send` | `session_id?`（null 则新建会话）、`parent_id?`、`parts`、`provider_id`、`model_id` | 插入 user 消息并触发生成 |
| `regenerate` | `message_id` | 对 assistant 消息重生成，产生新兄弟节点 |
| `edit` | `message_id`、`parts` | 对 user 消息编辑，产生新兄弟节点并触发生成 |
| `stop` | `session_id` | 中止该会话进行中的生成 |
| `switch_head` | `session_id`、`message_id` | 切换分支 |
| `session.update` | `session_id`、可选 `title` / `provider_id` / `model_id` / `system_prompt` / `params` | 更新元信息 |
| `session.delete` | `session_id` | 删除会话及其消息 |
| `settings.update` | `settings` 的部分字段 | 更新用户设置；若 `plugins` 变化，DO 据此装载 / dispose 功能插件 |

DO → 所有客户端：

| type | 字段 | 语义 |
|---|---|---|
| `snapshot` | `inflight: Array<{message, parts}>` | 连接建立时下发所有进行中的生成 |
| `session.created` / `session.updated` / `session.deleted` | session 或 `session_id` | 会话列表同步 |
| `message.created` | 完整 message | user 消息落库即广播；assistant 消息以 `status: streaming` 空壳广播，`id` / `seq` 已分配 |
| `message.delta` | `message_id`、`part_index`、`kind`（`text` / `reasoning`）、`delta` | 增量文本 |
| `message.part` | `message_id`、`part_index`、`part` | 完整 part（非增量类型） |
| `message.done` | `message_id`、`status`、`usage?`、`error?` | 生成结束 |
| `head.changed` | `session_id`、`message_id` | 当前叶子变更 |
| `settings.updated` | 完整 `settings` | 用户设置同步 |
| `error` | `request_id?`、`message` | 命令失败 |

### 8.3 生成任务生命周期（DO 内）

1. 收到 `send`：zod 校验 → 若新会话则插 `sessions` 并广播 `session.created` → 分配 `seq`、插 user 消息 → 广播 `message.created` → 分配 `seq`、插 assistant 占位行（D1 中 `status: error`，语义为"DO 若死亡则它就是 error"）→ 广播 `status: streaming` 空壳 → 更新 `head_message_id` 并广播 `head.changed`。
2. 将 `{message_id, session_id, parts 缓冲, started_at}` 写入 DO storage 的 `inflight` map；若尚无 alarm 则设置（10 分钟）。
3. 触发 `message/before-send` → `buildModelMessages` → `streamText`。每个 delta 追加到内存缓冲并广播；约每 1 秒把缓冲刷入 DO storage。**整个生成在触发它的 `webSocketMessage` 事件内 `await` 到结束**，不做 fire-and-forget：DO 只在有事件 / 请求在途时保证存活，普通 `fetch()` 子请求本身不续命，`waitUntil` 在 DO 内是空操作。DO 的事件处理是并发的，等待期间其它命令（`stop` 等）照常处理。
4. 结束：完整 parts、usage、`status: done` 一次性 UPDATE 到 D1 → 广播 `message.done` → 触发 `message/done` → 从 `inflight` 删除 → 无其他任务则取消 alarm。
5. `stop`：abort 对应 AbortController，走同样结束路径，`status: aborted`，已生成内容保留。
6. alarm 触发：超过 10 分钟的任务按 `aborted` 收尾。
7. `regenerate` / `edit`：与 `send` 相同流程，区别仅在 `parent_id` 的取值（regenerate 取目标消息的 parent；edit 取目标 user 消息的 parent 并先插入新 user 消息）。

### 8.4 seq 分配

DO 内存 per-session 计数器，冷启动时从 D1 `max(seq)` 初始化，之后只增不重读；同一 session 的首次初始化用 in-flight promise 去重。DO 是该用户的唯一写者，无跨进程竞争。

### 8.5 断线重连

客户端指数退避重连（1s 起，上限 30s）。连上后收 `snapshot`；同时对当前打开的会话 REST 重拉一次消息列表，补齐断线期间已落库的内容。不做事件序号与增量补发。

## 9. REST API（`plugins/api/`）

- `GET /api/me` 当前用户（含 `settings`）
- `GET /api/sessions` 会话列表（不含 archived）
- `GET /api/sessions/:id/messages` 该会话全部消息（含所有分支）
- `GET/POST/PUT/DELETE /api/providers`、`/api/providers/:id`
- `POST /api/providers/:id/fetch-models` 从供应商拉取模型并 upsert
- `GET/POST/PUT/DELETE /api/providers/:id/models`、`.../models/:modelId`
- `POST /api/attachments/check` body `{sha256}` → `{exists, attachment_id?}`
- `PUT /api/attachments/:sha256` 上传（body 为文件 bytes，header 带 mime）→ `{attachment_id}`
- `GET /api/attachments/:id` 读原图（带长 `Cache-Control`）

所有请求/响应 DTO 在 `shared/api.ts` 定义。

## 10. 前端

### 10.1 路由
- `/` → 空白新会话；首次发送后由服务端创建会话，客户端随即跳转到 `/c/:id`（实现阶段决定：不自动跳到最近会话，避免多设备下被别处新建的会话劫持路由）
- `/c/:sessionId` 会话页
- `/settings/providers`、`/settings/providers/:id`
- `/settings/plugins` 功能插件开关（MVP 下列表为空，仅有机制）

移动端与桌面共用布局，窄屏下会话列表变抽屉。

### 10.2 状态
- `useSyncStore`：唯一 WebSocket 持有者。连接、重连、事件 apply、命令发送。状态为 `sessions: Map<id, Session>`、`messages: Map<sessionId, Map<messageId, Message>>`。apply 规则为**幂等 upsert**，使 `snapshot`、REST 重拉与实时事件混合到达也一致。不含 UI 逻辑。
- `useConfigStore`：providers / models 缓存，走 REST。

会话页的当前路径与兄弟计数为 computed（沿 `parent_id` 回溯）。

### 10.3 渲染与输入
- `message-item` 按 parts 渲染：`text` 用 markstream-vue（含代码高亮、KaTeX），`reasoning` 折叠块，`image` 缩略图。
- `composer`：文本、图片粘贴/拖入、模型选择器、发送/停止。图片流程：`image-prep` 用 canvas 压长边到 2048 → sha256 → `check` → 必要时 `PUT` 上传 → 持有 `attachment_id` 随 `send` 发出。
- `branch-switcher`：`< n/m >` 切换兄弟节点，发出 `switch_head`。

### 10.4 连接状态
顶栏状态点；断开时 composer 禁用发送，重连后恢复。

## 11. 错误处理

- 供应商请求失败：assistant 消息以 `status: error` + `error` 文本收尾，气泡显示错误与"重试"（= regenerate）。不自动重试，不做供应商 fallback。
- WS 命令校验失败：回 `error` 事件（带 `request_id`），前端 toast，不改状态。
- D1 写失败：DO 内抛出，命令失败并回 `error`。生成结束时的落库失败也会先广播 `message.done`（携带 `error`），再从 inflight 移除并抛出——inflight 不再保留，`stop` / 删除会话依赖 inflight 清空来同步（实现阶段调整）。
- 上传失败：composer 内该图标红可移除。
- 原则：核心逻辑 fail-fast，UI 层优雅降级。

## 12. 测试

- `shared/`：parts 与 WS 事件 schema 的 round-trip。
- `plugins/llm/messages.ts`：前缀一致性测试（内存 vs D1 round-trip 深比较）+ 每协议 golden 快照。
- `plugins/llm/usage.ts`：各协议映射，含 Anthropic 加回 cache 与 undefined vs 0。
- `plugins/hub/`：seq 分配器、路径回溯与兄弟计数纯函数单测；DO 集成用例"send → delta → done"在 `@cloudflare/vitest-plugin` 的 workerd 项目里跑，provider 用 `ai/test` 的 `MockLanguageModelV4`。
- 前端：`useSyncStore` 事件 apply 单测（幂等、混合来源）。组件不写测试。
- 手动验收：四种协议各真跑一次，双设备同时观看同一条流。

## 13. 已核实的版本（2026-09-05）

以下版本均已通过装包读类型 / 实跑验证，plan 中的接口以此为准：

| 库 | 版本 | 关键事实 |
|---|---|---|
| cordis | 4.0.0-rc.9 | v4 API（Fiber、`[Service.init]`、`ctx.effect`、无 optional inject、无 `dispose` 事件）；零 Node 依赖 |
| ai | 7.0.9x | `instructions` / `result.stream` / 嵌套 usage / `responseMessages` 回放 / `MockLanguageModelV4` |
| @ai-sdk/openai · anthropic · google-vertex · openai-compatible | 4.0.5x · 4.0.4x · 5.0.7x · 3.0.4x | vertex 必须 `/edge`；compatible 必须 `includeUsage` |
| @cloudflare/vite-plugin · wrangler | 1.54.x · 4.129.x | `run_worker_first`、`new_sqlite_classes`、`.dev.vars` |
| @cloudflare/vitest-plugin · vitest | 1.1.x · 4.1.x（锁） | `cloudflareTest()`、`runInDurableObject`、`applyD1Migrations` |
| drizzle-orm · drizzle-kit | 0.45.x · 0.31.x（锁） | 迁移布局与 wrangler 默认 glob 兼容；`casing` 两处都要设 |
| markstream-vue · stream-diffs | 2.0.x · 0.0.2 | `final` 是流结束标志；Tailwind 用 `index.tailwind.css` |
| shadcn-vue · tailwindcss | 2.8.x · 4.3.x | `aliases.ui` 可指向 `@/client/ui`；SCSS 不要裸元素选择器 |
| vue · vue-router · pinia | 3.5.x · 5.3.x · 4.0.x | pinia 4 需显式装 `@vue/devtools-api` |
| typescript | 6.0.x | 7.x 破坏 vue-tsc；tsconfig 不用 `baseUrl` |
