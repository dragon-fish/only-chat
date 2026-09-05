# Projects、聊天 UI 与 reasoning 完整性设计

## 1. 背景与目标

only-chat 的实时多设备聊天 MVP 已可用。本轮在不引入账号系统的前提下完成一次完整功能改造：

- 增加 Projects，让同一项目内的会话共享可选提示词、默认模型和生成参数。
- 让新会话在发送第一条消息前即可配置 system prompt、模型与 reasoning。
- 重做侧栏和 Composer 的信息层级，并修复页面、弹层与长列表缺少滚动的问题。
- 为首 token 前的等待阶段提供明确反馈，并展示供应商实际返回的 reasoning summary。
- 完整保存并回传供应商 reasoning 元数据，满足多轮推理、质量与前缀缓存要求。

本轮继续使用 Cloudflare Access 作为外部门禁，`user_id` 仍固定为 `1`。

## 2. 范围

### 包含

- Project 创建、重命名、编辑和删除。
- 会话归入 Project、在 Projects 间移动、移回无项目 Chats。
- Project 的可选提示词、默认模型和参数。
- Project 动态继承与 session 逐字段覆盖。
- `Project → chats` 可折叠侧栏树。
- Composer 内的会话设置弹层和 reasoning 离散滑块。
- 首 token 前的“正在思考”状态与 reasoning summary 展示。
- 四种协议的 reasoning 内容及供应商元数据回传修复。
- 页面、侧栏、弹层、选择器和长列表的滚动规则。
- 移动端侧栏关闭按钮与设置按钮重合修复。

### 不包含

- 账号、登录与权限模型。
- Project 共享文件、工具 / MCP、知识库和跨会话记忆；只保留自然扩展位置。
- 从消息 fork 为新 session；它是后续独立功能，届时复用现有消息树。
- Project 分享、协作成员、置顶、搜索和归档。
- 自动从模型名称推断完整能力，或接入 models.dev。

## 3. 产品语义

### 3.1 Project 是可选容器

Project 只有名称必填。提示词、默认模型和所有参数均可为空。无 Project 的会话继续存在于独立的 Chats 区域。

Project 删除时不删除会话；数据库通过 `ON DELETE SET NULL` 将所属会话移回 Chats，UserHub 再广播更新后的会话。

### 3.2 动态继承

Project 配置不复制到 session。每次开始生成时，服务端从最新持久状态计算有效配置：

- system prompt：Project prompt 后追加 session prompt；两者之间固定使用两个换行，任何一方都不 trim 或改写。
- 模型：session override → Project default → 当前发送命令携带的客户端选择。
- 普通参数：session 中存在的字段 → Project 中存在的字段 → provider / model 默认。
- reasoning 开关与强度分别继承和覆盖。

修改 Project 后，项目内已有会话从下一次生成开始使用新配置。已经开始的流式生成使用启动时的配置快照，不在中途改变。

移出 Project 只移除 Project 层，不把继承值复制进 session。所有配置合并均为纯函数，并维持相同输入产生逐字节相同模型消息的前缀一致性。

### 3.3 reasoning 开关与强度

存储层将“是否开启 reasoning”和“reasoning 强度”分开。UI 将它们合并为一个模型相关的离散滑块：

`立即（关闭） → 自动（开启但不传强度） → 极低 → 低 → 中 → 高 → 超高 → Max → Ultra`

- “立即”表示显式关闭 reasoning；只在模型能力声明支持关闭时显示。
- “自动”表示开启 reasoning，但不发送 effort，让模型或供应商自行决定；DeepSeek 等模型依赖此语义。
- 其他档位开启 reasoning 并发送相应 effort。
- 滑块只显示模型能力声明支持的档位，不能选择无效值。
- reasoning 模型未声明档位时至少显示“自动”；为兼容已有 `reasoning: true` 模型，可显示基础的 Low / Medium / High，但不会仅凭模型名猜测 XHigh、Max 或 Ultra。
- 模型即使未正确标记 reasoning 能力，只要供应商实际返回 reasoning，系统仍保存、同步和回传，不以能力标签过滤数据。

配置中的 `reasoning_enabled` 为可选布尔值；缺失表示继承。`reasoning_effort` 为可选且可空：缺失表示继承，`null` 表示显式 Auto，字符串表示显式强度。

## 4. 数据模型

### 4.1 projects

新增 D1 表：

- `id`
- `user_id`
- `name`
- `system_prompt`（nullable）
- `provider_id`（nullable）
- `model_id`（nullable）
- `params`（nullable JSON）
- `created_at`
- `updated_at`

索引：`(user_id, updated_at)`。

### 4.2 sessions

新增 `project_id`，可空，引用 `projects.id`，删除策略为 `SET NULL`。增加 `(project_id, updated_at)` 索引。

现有字段改为以下语义，不改变列名：

- `system_prompt`：session 对 Project prompt 的补充。
- `provider_id` / `model_id`：session 模型覆盖；为空时继承 Project。
- `params`：session 参数覆盖，只存用户明确覆盖的字段。

### 4.3 SessionParams

保留 `temperature`、`top_p`、`max_tokens`，并调整 reasoning 字段：

- `reasoning_enabled?: boolean`
- `reasoning_effort?: null | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'`

### 4.4 ModelCapabilities

在现有 `vision / reasoning / tools` 基础上增加：

- `reasoning_can_disable?: boolean`
- `reasoning_efforts?: ReasoningEffort[]`

能力仍由用户配置或 preset 提供。远端 `/models` 只返回模型 ID 时不得根据名字猜测高级能力。

### 4.5 Part 供应商元数据

`providerOptions` 不再只允许出现在 reasoning part。assistant 的 text、reasoning 和 tool-call part 均可保存供应商元数据；user parts 不需要此字段。

流累积器以 stream part ID 关联持久 part，同一 part 最后一个非空 `providerMetadata` 胜出。D1、DO inflight storage、WebSocket 和重新组装的模型消息必须原样保留该数据。

## 5. 实时协议与服务端数据流

### 5.1 Project 命令和事件

新增客户端命令：

- `project.create`
- `project.update`
- `project.delete`
- 扩展 `session.update` 支持 `project_id`

新增服务端事件：

- `project.created`
- `project.updated`
- `project.deleted`

Project 与 session 的所有写操作继续经过 UserHub。D1 是唯一持久真相源；写成功后再广播。REST 提供初次加载所需的 Projects 只读列表。

删除 Project 时，先取得受影响 session ID，再删除 Project；外键在同一数据库语句内将它们的 `project_id` 置空。之后广播 `project.deleted` 和对应的 `session.updated`。

### 5.2 第一条消息原子创建

新会话页面使用客户端 draft，不在用户打开页面或设置弹层时创建空 session。

`send` 命令在 `session_id = null` 时额外携带 session 初始化数据：

- `project_id`
- session prompt
- session params overrides
- 可选模型 override

命令仍携带本次生成实际使用的 `provider_id / model_id`。UserHub 在持久化第一条 user message 前创建 session 并写入 draft；创建失败时不产生消息。对于已有 session，设置变更继续通过 `session.update` 实时同步。

### 5.3 有效配置解析

生成流程在“组装上下文”之前加载 session 及其 Project，调用纯函数计算：

- 合成 system prompt
- 有效模型与来源
- 合并后的普通参数
- reasoning 开关、Auto 或显式 effort

如果显式 session override 或 Project default 指向已删除 / 停用模型，发送按钮禁用并显示“模型不可用”，不静默换用其他模型。只有两层都未指定模型时才使用客户端当前选择。

### 5.4 reasoning provider options

reasoning 开启与 effort 分别映射：

- OpenAI Responses：始终 `store: false`；reasoning 开启时请求 `reasoningSummary: 'auto'`，只有显式 effort 才发送 `reasoningEffort`。关闭能力可用时发送协议支持的关闭值。
- OpenAI-compatible：Auto 时不发送 `reasoning_effort`；显式档位才发送。无论是否发送 effort，都接收并回传供应商产生的 `reasoning_content`。
- Anthropic：reasoning 开启时使用 adaptive thinking 和 summarized display；effort 可独立省略。关闭时使用 disabled thinking。
- Vertex：reasoning 开启时设置 `includeThoughts: true`；只有显式 effort 才设置 `thinkingLevel`。支持关闭的模型使用 SDK 对应的关闭配置。

协议映射只发送模型能力允许的值。核心解析不因 UI 标签或模型名称产生隐式行为。

## 6. reasoning 持久化与回传

### 6.1 当前结论

- OpenAI Responses 已能持久化 `itemId` 与 `reasoningEncryptedContent`，并在 `store: false` 时回传加密 reasoning item。线上数据已确认最近回复包含这两个字段，即使展示文本为空。
- Anthropic reasoning signature / redacted metadata 已通过 accumulator 与消息构建器保存和回传。
- OpenAI-compatible 当前错误地在 `buildModelMessages` 中丢弃 reasoning；当前 AI SDK 已支持将 reasoning part 转为 `reasoning_content`。
- Gemini 的 `thoughtSignature` 可能附着于 text、reasoning 或 tool-call；现有 schema 只保存 reasoning metadata，不足以覆盖后续工具调用。

### 6.2 修正规则

- 移除 OpenAI-compatible 的 reasoning 丢弃分支。
- 保存 text、reasoning 和 tool-call 上的供应商元数据。
- 回放时把每个 part 的 `providerOptions` 原样传给 AI SDK，由当前协议适配器生成 `reasoning_content`、thinking signature、encrypted reasoning 或 thought signature。
- 不解析、编辑、拼接、截断或展示加密 reasoning 内容。
- 可展示的 reasoning summary 与用于回传的供应商元数据相互独立；summary 为空不代表没有可回传 reasoning。

## 7. 客户端信息架构

### 7.1 侧栏

桌面采用确认过的可折叠树：

- 顶部：only-chat、新对话、设置。
- Projects：Project 行可展开所属 chats；行菜单用于新建聊天、编辑和删除。
- Chats：列出 `project_id = null` 的会话。

从 Project 行创建新对话时，draft 带该 `project_id`。全局“新对话”创建无 Project draft。会话菜单提供移动到 Project / 移出 Project。

移动端复用相同树并放入 Sheet。Sheet 的通用绝对定位关闭按钮在此场景关闭，侧栏头部使用正常 flex 排布 `设置` 与 `关闭`，确保两个按钮互不覆盖且具备触摸尺寸。

### 7.2 Project 设置页

Project 行菜单进入独立设置页。v1 页面包含：

- 名称
- Project prompt
- 默认模型
- 生成参数
- reasoning 滑块
- 删除 Project

默认模型和所有配置允许为空。页面结构为未来 Sources、Tools / MCP、Memory 增加导航位置，但 v1 不渲染空入口。

### 7.3 Composer 与会话设置

Composer 是一个整体输入面板：

- 上方为文本输入和附件预览。
- 底栏包含附件、会话设置、模型 / reasoning 当前状态、停止或发送按钮。
- 会话设置使用已确认的 Composer 弹层方案，第一条消息前后均可打开。
- 每个字段标注“继承自 Project”或“会话覆盖”，并可逐项恢复 Project 默认。
- 模型与 reasoning 状态在窄屏可换行，不依赖 hover 才能操作。

### 7.4 生成状态

assistant shell 到达后立即产生可见状态：

1. 尚无 text 或 reasoning summary：显示 spinner 与“正在思考…”。
2. reasoning summary 开始流入且正文尚未开始：展开显示摘要并保持 spinner。
3. 正文首 token 到达：隐藏等待提示，将已有摘要折叠为“思考过程”。
4. 生成完成且摘要为空：不留下空 reasoning 容器。

若供应商只报告 reasoning token 数或加密元数据而不返回 summary，等待提示持续到正文开始。UI 不伪造或推导隐藏思维链。

## 8. 滚动与尺寸契约

应用根继续占满 `100dvh` 并禁止整体 body 滚动。每个定高区域必须指定唯一的纵向滚动所有者：

- 聊天页：只滚动消息列表，Composer 固定在内容区底部。
- 桌面 / 移动侧栏：只滚动 Project / chat 树，头部固定。
- Settings 与 Project 设置：route 页面根为 `h-full`，正文 `overflow-y-auto`。
- Dialog / Sheet：外层限制到可用视口高度，固定头尾时只滚动中间内容。
- Select / model list / 其他 popover：使用可用视口高度设置 `max-height` 并在内部滚动。
- 宽表在窄屏使用局部横向滚动，不允许撑破页面或遮住主操作。

任何新增的可能随数据增长的列表都必须在实现时明确回答“谁负责滚动”，不得依赖浏览器 body fallback。

## 9. 错误处理

- Project / session 命令校验失败：广播带 `request_id` 的 error，客户端保留 draft 并显示错误。
- 第一条消息创建失败：不清空 Composer，不创建半成品 session。
- Project 删除失败：不在客户端提前移除 Project 或会话。
- 继承模型不可用：显示来源和不可用状态，禁止发送，直到清除 override / default 或选择有效模型。
- reasoning provider option 被供应商拒绝：保持现有生成 error 流程，不静默重试其他强度。
- 已收到的部分 text / reasoning 在停止或错误时照常持久化。

## 10. 测试与验收

### 数据与协议

- migration：现有数据迁移后全部 session 保持 `project_id = null`。
- Project CRUD、删除后 session 自动脱离、多用户 ownership 校验。
- Project / session 动态继承纯函数：prompt 拼接、模型 fallback、普通参数逐字段覆盖。
- reasoning 三态：继承、显式 Auto、显式档位；reasoning 开关独立继承。
- 第一条 `send` 原子创建 Project session；失败时无孤立消息。
- Project 与 session 事件在两个 WebSocket 客户端一致。

### reasoning round-trip

- OpenAI Responses：空 summary + `itemId` + encrypted content 落库后仍回传。
- Anthropic：thinking signature 和 redacted data 原样回传。
- OpenAI-compatible：reasoning text 转成下一轮 `reasoning_content`。
- Vertex / Gemini：text、reasoning、tool-call 的 `thoughtSignature` 不因序列化丢失。
- 内存数据与 D1 JSON round-trip 后构造的模型消息深比较相等。
- Auto 不发送 effort，但仍启用协议所需的 summary / thoughts 输出选项。

### 客户端

- sync store 正确应用 Project created / updated / deleted 和 session 移动事件。
- draft 首次发送成功后跳转到新 session；失败时内容和配置保留。
- 手动验收空 reasoning、有流式 summary、直接正文三种状态。
- 桌面和手机验收侧栏树、设置弹层、触摸操作与按钮不重合。
- 用超长 provider/model/Project/session 列表验收纵向滚动；窄屏模型表验收横向滚动。

## 11. 参考设计原则

- Project 是共享上下文容器，聊天仍保持独立记录；长期工作通过 Project 组织，单个聊天聚焦一个结果。
- 主聊天界面保持低密度：常用选择紧贴 Composer，完整 Project 配置进入独立设置页。
- 可见 reasoning 只展示供应商返回的摘要；协议回传所需的加密内容和签名作为不可见元数据保存。
- 功能优先于装饰性主题改造；本轮 UI 调整服务于可发现性、状态反馈、移动端可用性和长内容承载。
