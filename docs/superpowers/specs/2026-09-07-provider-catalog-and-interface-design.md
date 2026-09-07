# only-chat 供应商接口与模型目录设计

## 1. 背景与目标

当前供应商记录同时承担供应商身份、API Key、协议、Base URL 和 Files API 能力，因而一个供应商只能使用一种接口格式。模型名称、能力和价格又依赖手工录入，聚合网关一次导入数百个模型后仍无法直接使用。OpenAI Responses 适配器还会丢弃 DeepSeek 等开放 Responses 实现返回的完整 reasoning。

本轮将供应商身份与接口格式分离，引入 models.dev 目录作为模型事实来源，并恢复统一 UI 重构中丢失的全局侧边栏元素。

目标：

- 一个供应商共享名称、API Key 和启用状态，并配置多个接口格式和一个默认接口。
- 模型可选择该供应商已配置的接口，但不能覆写 API 地址或 API Key。
- Responses 使用开放协议适配器，完整保存并回放上游返回的 reasoning。
- models.dev 提供供应商预设、模型名称、能力、模态、限制、价格和 Lab 信息。
- KV 保存外部目录；D1 只保存用户模型、用户覆写、解析结果和可索引的热点筛选字段。
- 原生 Files API 的上传、复用、过期和远端删除形成完整生命周期。
- 所有常用模型筛选使用索引，避免 D1 全表扫描。

本文取代 `2026-09-06-unified-ui-redesign.md` 中以下结论：

- §2.2“不增加供应商多端点、默认端点或单模型协议覆盖”。
- §2.2“不自动推断模型能力、供应商品牌或模型协议”。
- §5 和 §9“模型搜索只使用已经同步到 Pinia 的数据，不增加服务端搜索接口”。
- §6.2 仅按供应商分组和仅读取手工 `capabilities`。
- §7.1 单协议供应商表单和现有模型字段。

其余路由、响应式布局、主题、Project 和聊天 UI 决策继续有效。

## 2. 范围

### 2.1 包含

- 固定的全局 Sidebar Header 和 Footer，以及 WebSocket 状态指示。
- 供应商多接口、默认接口和模型接口选择。
- `responses`、`chat-completions`、`anthropic` 和 `vertex-compatible` 四种接口格式。
- 统一 Open Responses reasoning 的接收、存储与回放。
- OpenAI-compatible Files API、Anthropic Files API 和远端文件清理。
- models.dev provider/model catalog 的定时和手动刷新。
- 模型 metadata fallback、用户覆写、Lab 分组、服务端筛选和分页。
- D1 schema 与现有数据迁移。

### 2.2 不包含

- 不动态安装 models.dev 推荐的 AI SDK 包。
- 不支持原生 Google Vertex Service Account 接口。
- 不实现完整的模型市场或跨全部 models.dev 供应商的分析页面。
- 不为无法唯一匹配的模型做模糊推断。
- 不增加登录与账户体系；Sidebar 用户状态栏暂用静态占位数据。
- 不改变 R2 原始附件的生命周期。

## 3. 核心不变量

1. API Key 只属于供应商，接口和模型不能保存独立 Key。
2. API 地址属于接口；同一供应商的同一种格式只能配置一次。
3. 模型接口为空时跟随供应商默认接口；非空时必须引用同一供应商的接口。
4. Reasoning 开关只控制本轮请求参数，不过滤上游响应或历史消息。
5. 上游返回的 reasoning 正文和 provider metadata 均完整持久化。
6. 过期文件指针永远不能参与推理，即使远端删除尚未成功。
7. models.dev 是 fallback，不是用户配置；用户覆写始终优先。
8. Catalog 刷新失败不得破坏上一份可用目录或模型解析结果。
9. 常用模型过滤不得依赖 D1 模型表全量扫描。

## 4. 数据模型

### 4.1 Providers

`providers` 调整为供应商身份与共享认证：

| 字段 | 说明 |
| --- | --- |
| `id` | 主键 |
| `user_id` | 所属用户 |
| `name` | 用户可见名称 |
| `api_key` | AES-GCM 密文；不返回客户端 |
| `enabled` | 供应商总开关 |
| `models_dev_provider_id` | 可空的 models.dev provider ID |
| `models_dev_provider_source` | `manual` 或 `endpoint`；决定后续保存时是否自动重新匹配 |
| `default_interface_id` | 默认接口；创建过程可短暂为空 |
| `credential_version` | Key 变更时递增，用于阻止旧文件指针复用 |
| `created_at` | 创建时间 |

移除 `protocol`、`base_url`、`extra` 和供应商级 `native_files`。原生 Vertex 的 Project、Location 和 Service Account 语义随协议删除。

### 4.2 Provider interfaces

新增 `provider_interfaces`：

| 字段 | 说明 |
| --- | --- |
| `id` | 主键 |
| `provider_id` | 所属供应商，删除供应商时级联 |
| `protocol` | 四种支持格式之一 |
| `base_url` | 该格式的 API Base URL |
| `native_files` | 是否启用此格式对应的原生 Files API |
| `created_at` | 创建时间 |

约束：

- 唯一索引 `(provider_id, protocol)`。
- `responses` 和 `chat-completions` 的 Files family 为 `openai`。
- `anthropic` 的 Files family 为 `anthropic`。
- `vertex-compatible` 没有 Files family，`native_files` 必须为 false。
- 删除默认接口前必须先选择替代接口；不能让已启用供应商处于无默认接口状态。

### 4.3 Model metadata

共享 `ModelMetadataSchema` 使用 models.dev 字段名与嵌套结构：

- `name`、`description`、`family`。
- `attachment`、`reasoning`、`reasoning_options`、`tool_call`、`structured_output`、`temperature`。
- `modalities`、`limit`、`cost`、`interleaved`。
- `knowledge`、`release_date`、`last_updated`、`open_weights`、`status`。
- `license`、`links`、`weights`、`benchmarks`。

模型表保留关系与用户行为字段，并用 typed JSON 保存完整 metadata：

| 字段 | 说明 |
| --- | --- |
| `id` | 主键 |
| `provider_id` | 所属供应商 |
| `model_id` | 运营商实际接受的模型 ID |
| `interface_id` | 可空；为空时跟随供应商默认接口 |
| `metadata_override` | `Partial<ModelMetadata>`；仅保存用户覆写 |
| `metadata_resolved` | 当前 catalog 与覆写合并后的可重建缓存 |
| `catalog_model_id` | 命中的 provider-agnostic ID，可空 |
| `catalog_provider_model_id` | 命中的供应商模型 ID，可空 |
| `catalog_match_source` | 实际 metadata fallback 来源：`provider`、`model` 或空 |
| `catalog_match_kind` | `exact`、`basename` 或空 |
| `search_name` | 有效人类可读名称的规范化搜索文本 |
| `lab_id` | 有效 Lab ID，可空 |
| `supports_image_input` | 物化筛选字段 |
| `supports_reasoning` | 物化筛选字段 |
| `supports_tools` | 物化筛选字段 |
| `supports_image_output` | 物化筛选字段 |
| `context_limit` | 物化筛选字段，可空 |
| `output_limit` | 物化筛选字段，可空 |
| `enabled` | 用户启用状态 |
| `sort` | 用户排序 |

移除 `display_name`、`capabilities` 和 `pricing`。字段缺失表示继承 fallback；显式 false、0 或 null 必须保留其覆写语义。

### 4.4 File pointers

`attachment_provider_files` 改为一次上传一行，不再用 upsert 覆盖旧指针：

| 字段 | 说明 |
| --- | --- |
| `attachment_id` | R2 原始附件 |
| `provider_id` | 共享认证所属供应商 |
| `credential_version` | 上传时使用的供应商凭据版本 |
| `file_family` | `openai` 或 `anthropic` |
| `base_url` | 上传所用的规范化文件服务地址 |
| `provider_reference` | SDK 返回的 opaque 引用 |
| `expires_at` | 本地可复用截止时间 |
| `cleanup_after` | 下一次允许尝试远端删除的时间 |
| `cleanup_attempts` | 删除失败次数 |
| `last_cleanup_error` | 可空的截断错误摘要，不含密钥 |
| `created_at` | 上传时间 |

复用索引覆盖 `(attachment_id, provider_id, credential_version, file_family, base_url, expires_at)`；清理索引覆盖 `(cleanup_after, expires_at)`。同一附件和作用域可以同时存在一条新指针与多条待清理历史指针。

## 5. 接口解析与 LLM 适配器

有效接口解析顺序：

1. 模型 `interface_id`。
2. 供应商 `default_interface_id`。
3. 任一引用不存在、跨供应商或被删除时 fail-fast，不猜测替代协议。

四种协议映射：

| Protocol | Language model adapter | Files adapter |
| --- | --- | --- |
| `responses` | `@ai-sdk/open-responses` | `@ai-sdk/openai` Files API |
| `chat-completions` | `@ai-sdk/openai-compatible` | `@ai-sdk/openai` Files API |
| `anthropic` | `@ai-sdk/anthropic` | `@ai-sdk/anthropic` Files API，加删除扩展 |
| `vertex-compatible` | `@ai-sdk/google-vertex` 的 bearer fetch 适配 | 无 |

`@ai-sdk/openai` 不再代表用户可选的语言协议。它只为 OpenAI-compatible Files API 提供客户端。

## 6. Reasoning 语义

DeepSeek 实测返回独立 `reasoning` item，完整正文位于 `content[].reasoning_text`。`@ai-sdk/openai` 只消费 OpenAI reasoning summary 事件，导致正文为空；`@ai-sdk/open-responses` 已实测能接收完整正文并在第二轮请求中回放。

处理规则：

- `reasoning_enabled` 和 `reasoning_effort` 只映射到当前请求参数。
- 无论请求参数如何，只要 SDK 产生 reasoning part 就完整进入 `PartAccumulator`、WebSocket 增量和 D1。
- 保存明文正文以及 item ID、签名、summary、encrypted content 等 provider metadata。
- Reasoning、工具调用和正文维持上游顺序，不按类型重新排序。
- 同一接口格式继续会话时，适配器回放完整 wire 语义。
- 切换接口格式时，明文 reasoning 继续作为历史上下文；只有目标适配器能识别的 metadata 会发送。签名和 opaque state 不跨不兼容接口伪造。
- `chat-completions` 使用 `reasoning_content` 接收与回放相同的明文内容。
- 不因 UI 折叠、思考开关关闭或模型能力 metadata 缺失而删除已经收到的 reasoning。

## 7. Files 生命周期

### 7.1 上传与复用

- OpenAI family 上传请求设置七天过期；供应商返回的实际 `expiresAt` 优先。
- Anthropic API 支持 `expires_in_seconds`，但当前 AI SDK 未暴露；仅对 Files 客户端使用 fetch 包装，在 multipart 上传中加入七天过期字段。
- Anthropic AI SDK 未实现 `FilesV4.deleteFile`；Files adapter 增加官方 `DELETE /v1/files/{file_id}` 实现。
- 文件作用域由 `provider_id + credential_version + file_family + normalized base_url` 决定。
- 同一供应商的 Responses 与 Chat Completions 在 Base URL 相同时共享 OpenAI 文件指针。
- 查询复用时只返回最新、凭据版本一致且未过期的指针。
- 过期行保留到远端删除完成或确认已不存在；新上传插入新行，不能覆盖旧行。
- 无原生 Files API 时继续使用 R2 URL 或 inline data。

### 7.2 每日远端清理

现有 daily cron 同时运行 catalog 刷新和文件清理，两项独立捕获错误，任一失败不能阻止另一项。

文件清理：

1. 使用 `cleanup_after` 索引分页读取到期行。
2. 按文件作用域复用 Files 客户端，并以有限并发调用远端删除。
3. 远端成功或返回 404/410 时删除 D1 指针。
4. 网络错误、429、5xx、401 或 403 时保留行，递增次数并将 `cleanup_after` 延后到下一次 cron。
5. 其他不可恢复响应记录后删除本地行，避免永久重试无效引用。
6. 每次运行设置上限，超出部分留给下一次 cron。

删除供应商、删除接口、修改 Key 或修改 API 地址前先 best-effort 清理受影响的远端文件。配置操作不因远端清理失败永久阻塞；失败必须记录且旧指针不得继续复用。

R2 原始附件不受 provider 文件清理影响。

## 8. models.dev Catalog

### 8.1 数据来源

每日和手动刷新均下载 `https://models.dev/catalog.json`。该文件同时包含：

- Provider 名称、推荐 SDK、API 地址和文档链接。
- Provider-specific 模型、实际服务能力、reasoning options 和价格。
- Provider-agnostic 模型事实。

推荐 SDK 只用于推断新建供应商的初始接口，不动态加载代码，也不视为该供应商支持的完整接口集合。已知映射可在本地维护；无法映射时要求用户选择格式。

models.dev 永远不是运营商模型可用性的权威来源。只有运营商 `/models` 返回或用户手工添加的模型才进入 D1；catalog 中单独存在的模型不能自动显示、导入、启用或删除运营商模型。

### 8.2 KV 布局

KV 使用不可变版本分片：

```text
models-dev:{version}:providers
models-dev:{version}:models
models-dev:{version}:provider:{providerId}
models-dev:{version}:manifest
models-dev:active
```

- `providers` 是轻量供应商索引。
- `models` 是完整 provider-agnostic map，不按 Lab 再拆分。
- Provider-specific catalog 每个供应商一个分片。
- `version` 包含抓取时间和内容 hash；内容 hash 未变化时不生成新版本。
- Manifest 记录分片、抓取时间、上游 hash 和 schema version。
- `active` 保存当前与上一成功版本。
- 所有分片和 D1 物化结果成功后才激活新版本。
- 读取当前版本缺失时回退上一版本。
- 当前与上一版本不清理；其他超过 48 小时的版本和失败 staging 由 daily cron 删除。

### 8.3 刷新行为

- 下载、JSON 解析和最小 schema 校验全部成功后才写新版本。
- KV 写入或 D1 物化失败时不切换 active。
- 手动刷新与 cron 使用同一服务函数，操作幂等；并发刷新通过内容 hash 和不可变 key 不会互相覆盖分片。
- 设置页显示上次成功时间、当前版本和最近一次错误。
- 从未成功缓存时，供应商和模型功能仍工作，metadata 使用保守默认值。

### 8.4 供应商关联

`models_dev_provider_id` 有两种来源：

- `manual`：用户从 models.dev Providers 选择供应商。后续修改 endpoint 不自动覆盖该选择；用户可以切回自动识别或清除关联。
- `endpoint`：保存供应商时由服务端根据接口 Base URL 自动识别。后续每次相关 endpoint 变化都重新计算。

Endpoint 自动识别规则：

1. 仅移除 URL 末尾 `/`，不改写 scheme、host、port、`/v1` 或其他 path。
2. 将每个接口的规范化 Base URL 与 models.dev `provider.api` 逐字比较。
3. 所有唯一命中必须指向同一个 provider ID，才保存该 `models_dev_provider_id`。
4. 无命中时保存 null；不同接口命中不同 provider 时不选择任何一方，并向设置 UI 返回非阻塞提示。

模型 metadata 解析只在已保存的 `models_dev_provider_id` 下查 provider-specific catalog；endpoint 不在每次模型读取时重复匹配。

## 9. Catalog 匹配与 metadata 合并

### 9.1 匹配规则

Catalog 查找严格按以下层级执行，命中较高层后不再用较低层替换它：

1. 供应商已有 `models_dev_provider_id` 时，在 `providers[id].models` 中完整 ID 逐字匹配。
2. 该供应商目录未精确命中，且只有一方含斜杠时，在同一 `providers[id].models` 中按 `/` 最后一段匹配。
3. 供应商目录仍未命中时，在全局 `models` 中完整 ID 逐字匹配。
4. 全局目录未精确命中，且只有一方含斜杠时，在全局 `models` 中按 `/` 最后一段匹配。
5. Basename 只能命中一个候选；多个候选视为歧义并继续下一层或最终不匹配。
6. 双方都有斜杠但完整 ID 不同，不做 basename 匹配。
7. 不转换大小写、点号、连字符、下划线或版本号。

Provider-specific 条目是首选 fallback，因为它表达该运营商实际暴露的模型 ID、能力、reasoning options、限制和价格。只有供应商目录没有对应模型时，才使用 provider-agnostic `models` 的通用事实。匹配来源、ID 和种类写入模型解析缓存，方便 UI 解释来源。

例如 DeepSeek 接口已关联 `models_dev_provider_id = deepseek` 时，`providers.deepseek.models.deepseek-v4-flash` 优先于全局 `models["deepseek/deepseek-v4-flash"]`，因此有效 metadata 包含运营商条目提供的 `reasoning_options` 和 `cost`。

### 9.2 合并顺序

从低到高：

1. 保守默认值。
2. 最高优先级 catalog 查找命中的单个 fallback：provider-specific 优先，否则 provider-agnostic。
3. `metadata_override`。

普通对象递归合并；数组和原始值整体替换。缺失表示继承，显式 false 和 0 不得被 truthiness 覆盖。Nullable 字段允许显式 null 清除值。

### 9.3 物化筛选字段

从有效 metadata 生成：

- `supports_image_input`：`modalities.input` 含 `image`。
- `supports_image_output`：`modalities.output` 含 `image`。
- `supports_reasoning`：`reasoning === true`。
- `supports_tools`：`tool_call === true`。
- `context_limit`：`limit.context`。
- `output_limit`：`limit.output`。
- `lab_id`：唯一匹配的 provider-agnostic ID 第一段。
- `search_name`：有效 name、model ID、Lab 名称组成的搜索文本。

模型 metadata fallback 与 Lab 识别是两条独立链路。Provider-agnostic 模型命中时，其 ID 第一段是 Lab ID；provider-specific 模型命中或模型完全未匹配时，如果运营商模型 ID 的第一段能逐字匹配已知 Lab ID，仍可仅用它确定分组、Lab 名称和图标。精确 Lab 前缀不能触发模型名称、能力、限制或价格 fallback。

Lab 人类可读名称优先取同 ID 的 models.dev provider 名称；没有对应 provider 时将 Lab ID 转为标题格式。图标直接使用 models.dev 的 `/logos/labs/{lab_id}.svg`，加载失败时回退供应商占位头像，不抓取或解析 `/labs/` HTML 页面。

Reasoning UI 直接读取 `reasoning_options`；是否可关闭和可用 effort 不再由手写字段维护。

Catalog 刷新、模型新增、metadata override 修改或接口调整时重新解析。只有解析结果或物化字段发生变化才 UPDATE D1。

## 10. 查询与 D1 成本

模型 API 支持按供应商、启用状态、接口、Lab、可识图、推理、工具、图片输出、最小上下文和搜索词筛选，并使用 cursor pagination。

最低索引集合根据实际 SQL 建立：

- 供应商、启用状态和排序。
- 启用状态与可识图。
- 启用状态与推理。
- 启用状态与上下文长度。
- 模型接口外键。

供应商内筛选使用以 `provider_id` 开头的复合索引；跨供应商模型选择使用以 `enabled` 和筛选字段开头的索引。任意子串名称搜索使用 FTS5，不使用前导 `%` 的 `LIKE`。

每个新增查询必须：

- 用 `EXPLAIN QUERY PLAN` 确认热点路径为 `SEARCH ... USING INDEX`，不是模型表全量 `SCAN`。
- 在测试或诊断脚本中检查 D1 `meta.rows_read` 与返回行数的比例。
- 只为产品实际提供的筛选建立索引，避免无意义的 rows written 和索引存储。

## 11. API 与状态

### 11.1 Provider API

Provider DTO 返回共享字段、`has_key`、默认接口、接口列表和 models.dev 关联及其来源，绝不返回密文或明文 Key。创建与更新输入允许原子提交供应商字段、接口列表、默认接口，以及手动关联或自动识别模式。Endpoint 模式的匹配只在服务端执行，客户端不能直接提交推断结果。

服务端验证：

- 至少一个接口。
- 默认接口属于该供应商。
- 协议唯一且 Base URL 合法。
- 模型接口引用属于同一供应商。
- Vertex-compatible 不接受 native Files。

Provider 列表和详情继续使用 AbortSignal/请求序列避免快速切换竞态。

### 11.2 Model API

模型 DTO 返回：

- 关系与用户状态字段。
- `metadata`：有效解析结果。
- `metadata_override`：用户覆写。
- `catalog_match`：provider/global ID 和匹配种类。
- 有效接口摘要。

远端“获取模型列表”始终以运营商 `/models` 响应为准，只同步其中的模型 ID：存在则保留用户状态，不存在则插入最小模型行并立即从当前 catalog 计算解析缓存。它不从 models.dev catalog 增加模型，也不把 catalog 字段写入 `metadata_override`。用户手工添加的模型不会仅因 `/models` 未返回而自动删除。

### 11.3 Catalog API

- `GET /api/model-catalog/status`：当前版本、上次成功时间和最近错误。
- `GET /api/model-catalog/providers`：可搜索的供应商索引。
- `POST /api/model-catalog/refresh`：手动强制刷新；同一刷新服务负责校验、KV 发布和 D1 物化。

刷新 API 只返回状态与计数，不返回整个 catalog。

## 12. 设置与模型 UI

### 12.1 全局 Sidebar

`AppSidebar` 持有固定 Header/Footer：

- Header 始终显示 `Only Chat`。
- Branding 右侧显示 WebSocket 状态点：open 绿色、connecting 黄色、closed 红色；hover/focus 显示文字。
- icon collapse 时状态点叠放在品牌图标右下角。
- Footer 始终显示设置入口和静态用户行 `Only Chat User / 本地账户`。
- 聊天、Project 和设置组件只渲染中间上下文内容。

Session 与 Project 行尾操作使用官方 `SidebarMenuAction`，桌面点击区域 32×32，移动端至少 40×40；图标维持 16px，并为标题预留尾部空间。

### 12.2 新建供应商

- 默认入口搜索 models.dev Providers。
- 选中后填写名称、`models_dev_provider_id`、已知 API 地址和推荐的初始格式，并将关联来源记为 `manual`。
- 推荐 SDK 不能映射时要求用户选择格式。
- 用户可继续添加其他支持格式。
- 保留“自定义供应商”，不要求 catalog 匹配。

### 12.3 供应商详情

- 标题、启用开关与未保存状态保持稳定布局，不因状态 label 出现造成跳动。
- 共享 API Key 只编辑一次。
- 接口列表显示格式、API 地址、Files 开关和默认标记。
- 可添加未配置格式、删除非必要接口和切换默认接口。
- 所有编辑参与统一未保存警告和离开确认。

### 12.4 模型列表与选择器

- 模型列表使用服务端筛选、排序和分页。
- 支持识图、推理、工具、图片输出、Lab、接口和最小上下文筛选。
- 模型可选择供应商已配置的接口或“跟随默认”。
- Metadata 编辑区显示当前有效值、来源和覆写；每个字段或整组可恢复 models.dev 默认。
- 多 Lab 网关按 Lab 分组，使用 `https://models.dev/logos/labs/{lab_id}.svg`。
- 单一 Lab 的官方供应商不显示冗余分组。
- 模型 catalog 未匹配但具有已知精确 Lab 前缀时，仍进入对应 Lab 分组；此时不显示未经匹配的模型 fallback 数据。
- Lab 也无法识别的模型进入“其他”，使用供应商占位头像。
- 模型名称使用有效 `metadata.name`；未提供时显示原始 model ID。

全局模型选择器保留桌面 Popover/手机 Drawer，但搜索和筛选改用新的服务端模型查询。已选择模型的有效 metadata 由 Pinia 缓存，不能因分页而丢失当前选择。

## 13. 错误、并发与安全

- Catalog、远端模型列表、供应商详情和模型分页各自维护独立 loading/error 状态。
- Catalog 不可用不阻止使用 D1 中已有模型和解析缓存。
- Catalog 数据不得影响 API Key、接口地址或启用状态。
- Provider/model 更新继续使用请求 token 或 AbortController，晚到响应不得覆盖当前选择。
- Catalog 刷新发布不可变分片并最后切换指针；读到缺失当前分片时回退上一版本。
- 远端文件删除错误不得包含 API Key、Authorization header 或完整响应体中的敏感数据。供应商或接口被删除、Key 被替换后无法继续重试的远端清理失败写入安全日志；配置操作完成后不保留旧凭据。
- Provider Reference 继续按 opaque JSON 保存，不由业务代码解析；适配器负责读取自身 namespace。
- 所有 URL 和 catalog 输入在服务端校验，Catalog 中的 SDK 包名只作为展示数据。

## 14. 数据迁移

迁移直接采用新结构，不保留旧协议兼容路由或双写：

1. 为每个旧 provider 创建一个对应 `provider_interface` 并设为默认。
2. 旧 `openai-responses` 映射为 `responses`；旧 `openai-completions` 映射为 `chat-completions`。
3. 旧 `anthropic` 和 `vertex-compatible` 保持对应格式。
4. 原生 `vertex` 记录不自动猜测转换；本地开发数据必须删除或由用户重新配置。
5. Provider API Key、名称和启用状态保留；已知 preset 的 models.dev 关联迁移为 `manual`，其余供应商根据迁移后的 endpoint 计算 `endpoint` 关联。
6. `display_name !== model_id` 时迁移为 `metadata_override.name`。
7. 旧 `capabilities` 映射到对应 models.dev 字段；空对象不产生覆写。
8. 旧 `pricing` 映射为 `metadata_override.cost`；null 不产生覆写。
9. 旧 model interface 为空，使其跟随新建默认接口。
10. 旧文件指针转换为一次上传一行，并按原 provider 协议推导 Files family；不能推导的行仅作本地清理。

完成迁移后删除旧列和旧协议实现。

## 15. 验证

### 15.1 自动测试

- Provider/interface schema、唯一约束、默认接口和跨供应商引用。
- 四种协议的有效接口解析和参数映射。
- DeepSeek 风格 reasoning SSE、非流式 output、完整存储和第二轮回放。
- Chat Completions `reasoning_content` 与工具调用交错顺序。
- OpenAI/Anthropic Files 上传、共享作用域、凭据版本、过期拒绝和删除重试。
- Catalog 分片、hash no-op、失败不激活、previous fallback 和旧版本清理。
- Provider-first、global fallback、exact/basename 和歧义模型匹配。
- Metadata 深合并、false/0/null、物化字段和 Lab 解析。
- Provider/model API 的竞态、分页、筛选和未保存状态。
- SQL query plan 与 D1 rows-read 诊断。
- Sidebar 固定 Header/Footer、状态点和操作按钮命中区域。

外部 DeepSeek 和 models.dev 集成测试使用显式启用的本地脚本，不在默认 CI 中读取私人凭据。测试不得打印 Key 或 reasoning 正文。

### 15.2 人工验收

- 普通聊天、Project 和设置页面始终显示 Branding、连接状态、设置和用户状态栏。
- Sidebar 展开、收起、桌面和手机状态均可操作。
- OpenRouter/ZenMux 导入大量模型后立即获得名称、能力、价格和 Lab 分组。
- 按识图、推理和最小上下文过滤时结果正确、分页稳定。
- 模型接口跟随默认、单独覆写和切回默认行为正确。
- 手动刷新目录成功后 UI 更新；刷新失败仍显示旧目录。
- DeepSeek Responses 显示完整 reasoning，并在后续工具调用和普通对话中正常回放。
- OpenAI 和 Anthropic 过期文件被 cron 主动删除；临时失败能在后续运行重试。
- 长供应商名、长模型名、未知 Lab、无 catalog、无接口和无模型状态均有明确反馈。

提交前运行相关定向测试、`pnpm typecheck`、`pnpm build` 和全量 `pnpm test`。
