# 插件配置与 Tavily 联网搜索设计

给插件一套「声明配置项 → 渲染表单 → 加密存取 → 注入工具」的通用链路，并用 Tavily 的 `web_search` / `web_extract` 两个工具作为它的第一个使用者。

## 范围

本期只做**第三方搜索**（Tavily）。运营商原生搜索（Anthropic 的 `webSearch_*` / Responses 的 `web_search`）不做——它需要 `provider_interfaces` 新增能力位、`Part` 增加 `provider_executed` 标记、`PartAccumulator` 持久化 `source` 片段，是另一件事。

搜索后端可替换：runner 只依赖 `WebSearchClient` / `WebExtractClient` 两个接口，换一家搜索服务只需换一个文件。

## 一、插件配置声明

`PluginManifest` 增加三样东西。

```ts
/** 校验权威。服务端读写都过它，客户端只做预检。 */
configSchema?: z.ZodObject

/** 纯呈现。不重复 schema 里已有的任何约束。 */
config?: readonly PluginConfigField[]

/** 凭据表单一半是「填什么」，一半是「去哪拿」。 */
configIntro?: { why: string; where?: string; link?: { label: string; href: string } }
```

```ts
export interface PluginConfigField {
  key: string
  label: string
  help: string
  type: 'text' | 'secret' | 'number' | 'boolean' | 'select'
  placeholder?: string
}
```

**校验层与渲染层必须分开。** JSON Schema 能表达「取值来自这个集合」，表达不了「渲染成密码框、带一个『更换』按钮」。同时 `.refine()` 的跨字段规则与自定义 message **不会**在 `z.toJSONSchema()` 转换中幸存，所以服务端永远重新校验，客户端预检永远是子集。

**约束只声明一次。** `select` 的选项、`number` 的 min/max、每个字段的 default，全部由客户端本地对 `configSchema` 跑 `z.toJSONSchema(schema, { io: 'input' })` 读出，不在 `PluginConfigField` 里重写。manifest 是 shared 代码、两端直接 import，schema 又是静态的，所以这份 JSON Schema 不过网。

**哪些字段是密钥由 `type: 'secret'` 决定。** 没有被任何 `PluginConfigField` 提到的 key 一律按 secret 处理——错要错在安全那一侧。

`config` 数组的顺序就是表单的渲染顺序。

### 自定义配置组件

`ClientPluginHost` 的插件上下文增加 `config.register(component)`，与已有的 `tools.register` 平行。插件在 `client/index.ts` 里注册了组件就用它，没注册则用通用表单。宿主不通过 manifest 上的布尔标记判断——注册与否本身就是答案，多一个标记就多一处可以对不上的地方。

### manifest 的发现方式

manifest 现在只被客户端用 `import.meta.glob` 发现。服务端要用同一份声明判断加密字段，改为显式 barrel `src/shared/plugin-manifests.ts`，两端共用一个来源。

### 每个工具有自己的名字

`defaultTools: readonly string[]` 换成：

```ts
tools: readonly { id: string; name: string; description: string }[]
```

不换的话，一个插件带两个工具时，工具选择器会渲染出两行都叫「Tavily」。`ClientPluginHost` 的工具归属表、`tool-selector.ts` 的 `availablePluginRows` / `defaultToolsForSettings` 跟着改。

## 二、配置存储

新表 `plugin_configs`：

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `user_id` | integer NOT NULL | → `users(id)` ON DELETE CASCADE |
| `plugin_id` | text NOT NULL | 命名空间 |
| `key` | text NOT NULL | 字段名 |
| `value` | text NOT NULL | 非 secret 存 JSON 编码值；secret 存 AES-GCM 密文原样，不再 JSON 包一层 |
| `updated_at` | integer NOT NULL | |

主键 `(user_id, plugin_id, key)`。前缀即可覆盖「读某用户某插件的全部配置」和「按 plugin_id 清空」，不额外建索引。

`plugin_id` 与 `key` 分两列而非拼成 `tavily:api_key`：停用插件时能按 plugin_id 直接删，命名空间也伪造不了。

## 三、服务端读写

新 cordis service `PluginConfig`（`provide = 'pluginConfig'`）：

| 方法 | 行为 |
| --- | --- |
| `read(userId, pluginId)` | 取行 → 解密 secret → `configSchema.parse()` → 返回 typed 配置 |
| `write(userId, pluginId, patch)` | 合并到已存值 → `configSchema.parse()` → 加密 secret → upsert |
| `status(userId)` | 给客户端的脱敏视图 |

`write` 收到的是**部分**字段。必须先把 patch 合并到当前已存的值上再整体 `parse`，否则一次只改 `search_depth` 的提交会因为缺 `api_key` 而失败。整体 parse 通过后才落库，半套写入不允许存在。

脱敏视图里非 secret 字段给原值（用户要读回来才能改），secret 字段只出现在 `secrets: Record<string, boolean>` 里表示「是否已存」，明文永不出服务端。每个插件另有一个 `configured: boolean`，回答「它的工具现在能跑吗」——客户端自己算不出来，因为决定它的值正是客户端永远拿不到的那些。

### 路由

```
GET  /api/plugins/config          所有插件的脱敏配置
PUT  /api/plugins/:pluginId/config
```

**不走 WebSocket。** `settings.updated` 会把整个 `UserSettings` 广播给该用户的所有连接，密钥不能进那条链路。

secret 的写入语义：字段不传 = 保持原值，传 `null` = 清除。表单永远不发空串——它对每个可见字段都提交，空串若解释成清除，改一个调用上限就会顺手抹掉没人碰过的 API Key。

## 四、工具注入

`ToolFactory` 从 `() => Tool` 改为接收生成级上下文：

```ts
export interface ToolContext {
  userId: number
  /** 本插件已解密、已 parse 的配置 */
  config: Record<string, unknown>
  /** 本次 runGeneration 的可变状态，工具自用 */
  turn: Map<string, unknown>
}
export type ToolFactory = (ctx: ToolContext) => Tool
```

`ToolRegistry.resolve()` 因为要解密而变成 async。`generation.ts` 的 `prepareTarget` 为每次生成构造一个 `turn` Map 并注入——「一轮」的边界就是一次 `runGeneration`，也就是一条 assistant 消息。

必填配置缺失时 `resolve()` 直接抛错，不静默降级：核心逻辑层 fail-fast。

## 五、多步工具循环

`streamText` 目前没传 `stopWhen`，AI SDK v7 默认 `stepCountIs(1)`——模型调完工具就结束，永远拿不到结果作答。加：

```ts
stopWhen: [stepCountIs(TOOL_MAX_STEPS), awaitsHumanToolResult(target.tools)]
```

常量 8 放 `src/shared/constants.ts`。

**第二个条件不是可选项。** 没有 `execute` 的工具**仍然会**产出一个 `tool-error` 输出，而这满足 AI SDK 自己的续步判据（实测：`streamText` + `MockLanguageModelV4`，单个 `ask_user` 调用在裸 `stepCountIs(8)` 下跑满 8 步）。只加步数上限会让 `ask_user` 空转到上限，而不是停下来等人回答。`awaitsHumanToolResult` 检查上一步是否调用了没有 `execute` 的工具，是就停轮。

`PartAccumulator` 已在 `start-step` 重置 id 索引，多步安全；`part.totalUsage` 本来就是全部 step 的合计。

## 六、Tavily 插件

`src/plugins/tavily/`

| 文件 | 内容 |
| --- | --- |
| `manifest.ts` | 两个工具 + 配置声明 |
| `shared.ts` | 输入/输出 zod schema，服务端与卡片共用 |
| `server/client.ts` | `TavilyClient`：纯 `fetch` 打两个端点 |
| `server/runners.ts` | `runWebSearch` / `runWebExtract`：纯函数 |
| `server/index.ts` | 注册两个 tool |
| `client/index.ts` | 注册两个卡片 |
| `client/web-search-card.vue` | 结果列表 |
| `client/web-extract-card.vue` | 抓取结果 |

### 配置

```ts
configSchema: z.object({
  api_key: z.string().min(1, '请填写 Tavily API Key'),
  search_depth: z.enum(['basic', 'advanced']).default('basic'),
  search_calls_per_turn: z.number().int().min(1).max(10).default(3),
  extract_calls_per_turn: z.number().int().min(1).max(10).default(2),
})
```

字段名带 `per_turn`：不带的话读起来像整个会话的总额度。

### HTTP 客户端

直接 `fetch` `https://api.tavily.com/search` 与 `/extract`。不用 `@tavily/core`——它依赖 axios 与 https-proxy-agent（node net/http），在 Cloudflare Workers 上跑不了。

`includeAnswer` 关闭：本产品自己就有 LLM，Tavily 的 answer 端点是多余的一次等待。

### Runner 与配额

配额是**防死循环**的机制，不是省钱阀门：搜不到说明搜的方向不对，Agent 应该回来跟人对齐需求，下一轮再搜。计数器存在 `ToolContext.turn` 里，随一次 `runGeneration` 结束而消失。

超额返回单行文本，只报次数与上限，不解释理由：

```
Error: web_search 本轮已调用 3 次，已达上限。
```

计数在**入参校验通过之后**递增：格式错误的调用不消耗配额，网络失败与空结果消耗。

### 工具结果

`execute` 返回结构化 JSON，不是拼好的 markdown：

```ts
// web_search
{ query: string, results: { title: string, url: string, content: string, score?: number }[] }

// web_extract
{ results: { url: string, title?: string, content: string }[],
  failed:  { url: string, error: string }[] }
```

模型侧和渲染侧读同一份数据。换搜索后端不影响卡片。

## 七、界面

| 位置 | 改动 |
| --- | --- |
| `settings-plugins.vue` | 有 `config` 声明的插件行加「配置」入口 |
| `/settings/plugins/:id` | 新页面。页首渲染 `configIntro` 的 why / where / link；表单用 `use-form-changes` + `unsaved-changes-guard` 做脏检查 |
| `plugin-config-form.vue` | 按声明渲染；插件注册了自定义配置组件则优先用它 |
| `tool-selector.vue` | 必填项未配置的工具行置灰，提示去插件设置 |

secret 字段渲染成空的密码框，旁边一个「已配置」徽章，占位文字写「留空则保持不变」。永不回显明文。

搜索卡片列出每条结果的标题（链接）、域名与摘要，可折叠。抓取卡片按 URL 列出成功/失败，正文可展开。

## 八、错误处理

- 配置缺失、解密失败：服务端抛错，走 `generation.ts` 现有的 error 路径。
- 工具内的网络/HTTP 错误：捕获后作为结构化结果返回给模型，不炸整轮生成。
- 客户端卡片解析失败：降级显示原始 JSON。

## 九、验证

- secret 往返：加密写入后 `read` 得到明文，`status` 视图不含明文。
- `configSchema` 校验：非法值被拒，默认值生效。
- `runWebSearch` / `runWebExtract`：假 client 下的入参边界与配额耗尽行为。
- `ToolRegistry.resolve`：必填配置缺失时抛错；插件被全局停用时仍被抑制。

不为 `3` / `2` / `8` 这类常量取值写测试——那是 decision，不是 bug。

## 十、不做

- 运营商原生搜索（`native_search` 能力位、`provider_executed` 标记、`source` 片段持久化）。
- 站点级共享 API Key。
- 正文内的引用角标与来源脚注。
