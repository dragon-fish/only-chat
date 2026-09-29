# MCP 客户端

## 1. 范围

内置插件 `mcp` 让模型调用用户自己配置的远程 MCP 服务。模型面对的永远是三个固定工具，服务与工具在调用时按需发现，因此接入多少服务都不改变发给模型的工具列表。

| 做 | 不做 |
|---|---|
| 远程 MCP：Streamable HTTP（默认）与 SSE | stdio：Worker 与 Durable Object 不能启动子进程 |
| 任意服务地址、自定义请求头、OAuth 2.1 授权 | MCP 的 prompts、resources、sampling、elicitation |
| 用户级服务清单，按工具屏蔽 | 按对话选择服务、调用前人工确认 |
| 模型经三个固定工具发现并调用 MCP 工具 | 把 MCP 工具注册成独立的直接工具 |

实现基于 `@ai-sdk/mcp`（`createMCPClient`、`OAuthClientProvider`、`auth`）。

## 2. 插件结构

目录 `src/plugins/mcp/`，沿用 `manifest.ts` + `shared.ts` + `client/` + `server/`。

- `server/index.ts`：hub 侧，注册三个工具，负责连接与调用。
- `server/api.ts`：Worker 侧，服务清单的增删改查、连接测试、刷新、OAuth 路由，经 `ctx.pluginApi.register` 挂在会话校验之后，路径 `/api/plugins/mcp/…`。
- 两半分属不同的 cordis 根，注册为两个插件。按 AGENTS.md 同时登记到 `src/shared/plugin-manifests.ts`、`src/client/plugins/loaders.ts`、`src/server/app.ts`。
- manifest：三个工具放在同一个工具组，选择器里是一个开关；`settingsEntry` 为「MCP」，设置页是插件注册的 `settingsPanel`。

## 3. 数据

### 3.1 表 `mcp_servers`

| 列 | 说明 |
|---|---|
| `id` | 自增主键 |
| `user_id` | 所属用户，一切查询以它为范围 |
| `key` | 8 位随机字母数字，创建时生成、永不改变；即模型看到的 `service_id`；`(user_id, key)` 唯一 |
| `name` | 显示名 |
| `url` | 服务地址 |
| `transport` | `http` \| `sse` |
| `headers` | JSON 数组 `[{ name, value, secret }]`；`secret` 为真时 `value` 是密文 |
| `enabled` | 全局开关 |
| `disabled_tools` | JSON 字符串数组，被屏蔽的工具名 |
| `oauth` | 加密后的 JSON：tokens、客户端注册信息、授权服务器信息；无 OAuth 时为空 |
| `status` | `ok` \| `needs_auth` \| `error` \| `unknown` |
| `last_error` | 最近一次失败的说明 |
| `config_version` | 整数，每次改变连接行为（地址、传输、请求头、授权、手动刷新）时加一 |
| `created_at` / `updated_at` | 时间戳 |

加密复用 `llm/crypto.ts` 的 `encryptSecret` / `decryptSecret` 与 `KEY_ENCRYPTION_SECRET`。每个用户最多 20 个服务。`test/worker/tenant-isolation.test.ts` 覆盖此表。

### 3.2 KV

| key | 内容 | TTL |
|---|---|---|
| `mcp-tools:<userId>:<key>:<config_version>` | 服务的 `tools/list` 结果与握手时的 `instructions` | 1 小时 |
| `mcp-oauth:<state>` | `{ userId, key, codeVerifier }` | 10 分钟 |

工具列表缓存靠 `config_version` 失效，不依赖删除，因此不受 KV 最终一致性影响。

## 4. 请求头

- 名称含 `auth`、`token`、`key`、`secret`、`password`、`cookie`、`session`、`credential` 之一（不区分大小写）时，新增的行默认标记为敏感；标记可以手动切换。
- 敏感值加密存储，接口永不返回明文，编辑时输入框提示「已保存，输入新值以替换」，留空表示保持原值。非敏感值明文存储、明文显示。
- 校验：名称必须是合法的 HTTP 头名；不区分大小写不得重名；不得使用由 SDK 设置的头（`Content-Type`、`Accept`、`Mcp-Session-Id`、`Mcp-Protocol-Version`、`Last-Event-ID`），OAuth 服务不得另填 `Authorization`。
- 界面：把 `extra-body-editor.vue` 的行布局抽成通用的 `key-value-editor.vue`（名称、值、增删、错误行，每行末尾一个插槽）。`extra-body-editor.vue` 在其上保留 JSON 解析与保留字校验，行为不变；MCP 请求头编辑器在插槽里放敏感开关。

## 5. 工具

三个工具的描述是固定文本；服务清单等动态内容只出现在工具结果里。

### 5.1 `mcp_list_services()`

返回所有已启用的服务：

```json
{
  "services": [
    { "service_id": "a1b2c3d4", "name": "Notion", "tool_count": 31,
      "tools_preview": ["search", "retrieve_page", "create_page", "…"] },
    { "service_id": "e5f6a7b8", "name": "某服务", "error": "需要用户在设置里重新授权" }
  ]
}
```

- `tools_preview` 是按服务给出的顺序取前 10 个未屏蔽工具的名字，`tool_count` 是未屏蔽工具总数。
- 没有已启用的服务时返回空的 `services`，并说明用户可以在设置的「MCP」里添加。
- 工具列表取自 KV；未命中的服务并行连接拉取，每个服务单独 15 秒超时，失败只影响该服务的条目。

### 5.2 `mcp_list_tools(service_id, query?)`

- 不传 `query`：返回该服务全部未屏蔽工具的名称、描述与 `input_schema`。
- 传 `query`：按英文逗号拆成多个关键词，去除空白；工具名、描述或 `input_schema` 顶层参数名中含任一关键词（不区分大小写的子串）即返回。
- 结果附带服务的 `instructions`（握手时服务给出的使用说明，有则附）。
- 工具描述提示模型：大服务先用 `query` 缩小范围，关键词用英文。

### 5.3 `mcp_call_tool(service_id, tool_name, params)`

- 服务不存在、未启用、工具被屏蔽或不存在时，返回错误并列出可用的 `service_id` 或工具名。
- 参数原样交给服务，由服务校验；服务的校验错误原样返回给模型。
- 结果映射：
  - 文本内容拼接，超过 64 KiB 截断并注明原长度。
  - 图片写入 R2 成为 attachment，结果里只带 `attachment_id`；模型能读工具结果图片时经 `toModelOutput` 作为媒体交给模型（同 `browser_use`）。
  - 音频、资源链接、内嵌资源等其他内容转为 JSON 描述。
  - `isError: true` 作为错误结果交给模型。
  - `structuredContent` 存在时一并返回。

## 6. 连接与执行

- 在 `UserHub` 内执行。某服务在本轮生成中第一次被用到时，用 `createMCPClient({ transport: { type, url, headers, authProvider, redirect: 'error' } })` 建立连接，存于 `turn.state`，本轮后续调用复用。
- 核心新增事件 `generation/settled`（`src/server/cordis.d.ts`），在 `generation.ts` 的收尾处无论成功、失败或中止都触发一次，参数为本轮的 `GenerationTurn`。插件在此关闭本轮建立的所有连接。
- 单次 `tools/call` 超时 60 秒；`ToolContext.signal` 中止时一并取消。
- `authProvider` 是插件实现的 `OAuthClientProvider`，读写 `mcp_servers.oauth`。SDK 在调用中自动刷新过期 token 并经 `saveTokens` 写回。
- 地址只接受 `https://`；开发环境（`import.meta.env.DEV`）另外允许 `http://localhost` 与 `http://127.0.0.1`。

## 7. 错误

所有失败都成为工具结果，不中断生成。

| 情况 | 服务状态 | 模型收到 |
|---|---|---|
| 401 或刷新 token 失败 | `needs_auth` | 该服务需要用户在设置里重新授权 |
| 网络错误、超时、协议错误 | `error`，写 `last_error` | 失败原因 |
| 调用成功 | `ok`，清空 `last_error` | 结果 |

状态只在变化时写库。

## 8. OAuth

1. 添加或测试连接时服务返回 401 且可发现授权元数据，状态记为 `needs_auth`，设置页显示「授权」。
2. 用户点「授权」：Worker 调 `auth(provider, { serverUrl })`。SDK 发现受保护资源与授权服务器元数据，必要时动态注册客户端；注册信息与授权服务器信息经 provider 加密存入 `oauth`。provider 的 `redirectToAuthorization` 把授权地址交回接口，`saveCodeVerifier` 与 `state` 写入 KV `mcp-oauth:<state>`。前端在新窗口打开授权地址。
3. 回调 `GET /api/plugins/mcp/oauth/callback`：在会话校验之后（新窗口同站，带 cookie）。以 `state` 取 KV 记录，校验其 `userId` 与当前用户一致，调 `auth(provider, { serverUrl, authorizationCode, callbackState })` 换取 token 并存储，`config_version` 加一，状态置 `ok`，删除 KV 记录。页面提示「授权完成，可以关闭此窗口」，并以 `BroadcastChannel` 通知设置页刷新。
4. 回调地址由当次请求的 origin 拼出，不来自配置。
5. `state` 缺失、过期或属于别的用户时拒绝，不写任何数据。

## 9. 设置页

插件的 `settingsPanel`，主从布局，选中的服务以查询参数 `?server=<key>` 表示。

- 列表：名称、传输类型、状态、启用开关；「添加」。
- 详情「通用」：名称、地址、传输类型、请求头编辑器、「测试连接」；需要授权时显示「授权」/「重新授权」；删除服务。
- 详情「工具」：实时拉取（经 `config_version` 缓存）的工具列表，每行工具名、简介与启用开关；「刷新」使 `config_version` 加一后重新拉取。
- 保存后自动测试连接并更新状态。

接口（均在 `/api/plugins/mcp` 下）：

| 方法与路径 | 作用 |
|---|---|
| `GET /servers` | 清单（敏感请求头只返回名称与 `secret: true`） |
| `POST /servers` | 新建并测试连接 |
| `PATCH /servers/:key` | 修改并测试连接 |
| `DELETE /servers/:key` | 删除 |
| `GET /servers/:key/tools` | 工具列表（含屏蔽状态） |
| `POST /servers/:key/refresh` | `config_version` 加一并重新拉取 |
| `POST /servers/:key/authorize` | 开始 OAuth，返回授权地址 |
| `GET /oauth/callback` | OAuth 回调 |

## 10. 前端卡片

- `mcp_call_tool`：标题「服务名 · 工具名」，服务名取自设置清单，服务已删除时显示 `service_id`；折叠区显示参数与结果，图片按 attachment 显示。
- `mcp_list_services`、`mcp_list_tools`：显示列出的服务或工具名。

## 11. 测试

- 单元：`query` 拆分与匹配（名称、描述、参数名）；`tools_preview` 截取与计数；请求头敏感默认判定与校验；`key-value-editor` 抽取后 `extra-body-editor` 行为不变。
- Worker：以测试内的最小 Streamable HTTP MCP 服务（或出站请求拦截）为对端，覆盖：
  - 增删改查、敏感请求头加密且不回传、20 个上限；
  - 三个工具的成功路径，屏蔽工具与未启用服务的错误，服务返回 `isError`；
  - 401 后状态变为 `needs_auth`；
  - OAuth 回调：错误或他人的 `state` 被拒绝，正确的 `state` 换得 token 并存储；
  - `generation/settled` 在成功、失败、中止时各触发一次；
  - 租户隔离覆盖 `mcp_servers`。

## 12. 验收

- 添加一个只需 `Authorization` 请求头的服务（如百炼上的在线 MCP），模型在对话中经三个工具完成一次调用。
- 添加 Notion 的远程 MCP，完成 OAuth 授权，模型能搜索并读取页面；token 过期后自动刷新。
- 在「工具」里屏蔽一个工具后，模型既看不到也调不到它。
- 接入多个服务后，发给模型的工具列表不变。
