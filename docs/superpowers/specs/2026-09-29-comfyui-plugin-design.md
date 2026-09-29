# ComfyUI 插件

## 1. 范围

内置插件 `comfyui` 让模型驱动用户自己的远程 ComfyUI 实例出图。只依赖标准 ComfyUI HTTP API；模板与提示词指南是可选增强，从 ComfyUI 的 userdata 目录读取，目录名由用户配置。

| 做 | 不做 |
|---|---|
| 查询模型文件、节点输入规格 | 把工作流写回 ComfyUI |
| 模板模式出图：模板 + 提示词/尺寸/采样参数/LoRA 覆盖 | 图生图、上传参考图 |
| 原始模式出图：模型直接提交 API 格式工作流 | 访问控制、限流、提示词过滤 |
| 出图作为后台任务，产物进 R2 与画廊 | Image Studio 入口（执行层已为其预留，见 §5） |
| 读取已配置目录中的模板与 markdown 指南 | 取消时中断 ComfyUI 上正在执行的任务 |

## 2. 插件结构

目录 `src/plugins/comfyui/`，沿用 `manifest.ts` + `shared.ts` + `client/` + `server/`。

- `server/index.ts`：hub 侧，注册 5 个工具。
- `server/backend.ts`：workflow 侧，向 `imageBackends` 注册 `comfyui` 执行器（§5）。
- `server/client.ts`：ComfyUI HTTP 客户端，两侧共用。
- `server/template.ts`：模板识别与覆盖的纯逻辑（§6）。
- 两个 server 插件分属不同 cordis 根，分别登记。按 AGENTS.md 同时登记到 `src/shared/plugin-manifests.ts`、`src/client/plugins/loaders.ts`、`src/server/app.ts`。
- manifest：5 个工具同属一个工具组，选择器里是一个开关。服务端不注入其他插件的服务，因此没有 `requires`。

## 3. 配置

每用户插件配置（`configSchema` + `config`），由通用插件配置表单呈现。

| key | 类型 | 说明 |
|---|---|---|
| `base_url` | text，必填 | ComfyUI 地址。必须 `https:`；开发环境另允许 `http://localhost`、`http://127.0.0.1`。拼接请求路径时去掉末尾 `/` |
| `cf_access_client_id` | secret，可选 | Cloudflare Access Service Token |
| `cf_access_client_secret` | secret，可选 | 与上一项必须同时填写或同时留空 |
| `workflows_dir` | text，可选 | userdata 下存放 API 格式模板的目录，留空即无模板 |
| `guides_dir` | text，可选 | userdata 下存放 markdown 指南的目录，留空即无指南 |

目录名只允许 `[A-Za-z0-9_-]` 组成的单段或多段相对路径（段间 `/`），不允许 `..`、开头 `/`。

`configIntro` 说明：目录里的 JSON 必须是 ComfyUI **Workflow → Export (API)** 导出的 API 格式；可由自定义节点自动保存，也可手动放到 ComfyUI 的 `user/default/<目录>/`。

## 4. HTTP 客户端

每个请求附带：
- 两个 CF Access 头（已配置时）：`CF-Access-Client-Id`、`CF-Access-Client-Secret`；
- `User-Agent: only-chat`：没有 UA 的请求会被 Cloudflare Browser Integrity Check 拦截。

单个请求超时 30 秒。错误分类 `error_type`：

| 类型 | 条件 |
|---|---|
| `network` | 连接失败、超时 |
| `auth` | 401/403，或 CF Access 返回的 HTML 登录页 |
| `validation` | `POST /api/prompt` 返回 400，附 ComfyUI 的 `error` 与 `node_errors` |
| `comfyui_error` | 其他非 2xx，或执行结果 `status_str = error` |
| `not_found` | 404（模板、指南、模型目录、节点类不存在） |

使用的端点：

| 端点 | 用途 |
|---|---|
| `GET /api/userdata?dir=<dir>&recurse=true&full_info=true` | 列目录 |
| `GET /api/userdata/<urlencoded path>` | 读文件，路径中的 `/` 编码为 `%2F` |
| `GET /api/models`、`GET /api/models/<folder>` | 模型目录、模型文件 |
| `GET /api/object_info/<class>`、`GET /api/object_info` | 单个节点规格、全量（仅用于搜索） |
| `POST /api/prompt` | 提交，返回 `prompt_id` 或 400 校验错误 |
| `GET /api/history/<prompt_id>` | 执行结果；未完成时为 `{}` |
| `GET /api/view?filename=&subfolder=&type=` | 取图 |

## 5. 执行链路

### 5.1 `imageBackends` 注册表（核心）

`src/server/plugins/artifacts/backends.ts` 提供 cordis 服务 `imageBackends`，在 workflow 侧加载：

```ts
interface ImageBackend {
  pluginId: string
  /** 返回图片字节；可返回新的 backend_state，由核心写回 run。 */
  execute(userId: number, run: ArtifactRunRow): Promise<{ images: Array<{ bytes: Uint8Array, mime: string }>, usage?: ArtifactUsage, state?: unknown }>
  /** 通知给模型的摘要；缺省时用核心的默认文案。 */
  notificationText?(run: ArtifactRunRow, outputs: readonly string[]): string
}
register(protocol: string, backend: ImageBackend): void
get(protocol: string): ImageBackend | undefined
```

- `executeImageRun`：`run.interface_protocol` 在注册表中时调 `backend.execute`，否则走现有 provider 路径。之后的 MIME/大小校验、R2 落盘、`attachments`、`artifacts`、`artifact_links`、状态更新全部共用。
- `notifyToolRun` 改为接收 workflow 侧的 `ctx`，由注册表决定通知的 `plugin_id` 与 `text`；`task_id` 仍为 `image_run:<id>`。
- `ArtifactGenerationWorkflow` 的两步都用 `createApp({ side: 'workflow' })`。

### 5.2 Migration

`artifact_runs` 新增可空 JSON 列 `backend_state`，由 backend 私有。其余列 ComfyUI run 的取值：

| 列 | 值 |
|---|---|
| `kind` / `source` / `operation` | `image_generation` / `tool` / `generate` |
| `provider_id` / `interface_id` | `null` |
| `provider_name` | `ComfyUI` |
| `interface_protocol` | `comfyui`；列的 TS 类型放宽为 `string` |
| `credential_version` | `0` |
| `model_id` | 模板名；原始模式为 `workflow` |
| `model_name` | 模板识别出的主模型文件名；识别不出时同 `model_id` |
| `prompt` | 正向提示词；原始模式为 `(API workflow)` |
| `params` | `{ count: 1, size }`，`size` 为覆盖后的字面宽高，未知时 `null` |
| `backend_state` | `{ prompt_id, seed, template }`；执行后补 `duration_ms` |

画廊与作品详情对 `provider_id = null` 的 run 按「供应商已删除」同样处理，不提供以原参数重新生成。

### 5.3 提交（hub 侧，工具内同步完成）

1. 以 `tool:<messageId>:<toolCallId>` 查已有 run，存在则直接返回其 `task_id`。
2. 构造 API 图（模板模式经 §6 覆盖；原始模式原样）。
3. `POST /api/prompt`。400 时把 `error` 与 `node_errors` 返回给模型，不建 run。
4. 插入 run（状态 `queued`），启动 `ARTIFACT_WORKFLOW`，返回 `{ task_id, status: 'started', prompt_id, seed?, template? }`。

核心提供 `createBackendToolRun(ctx, userId, input)`，与 `createToolImageRun` 共用 workflow id 规则与启动失败处理。

### 5.4 执行（workflow 侧）

`comfyui` backend 的 `execute`：
1. 从插件配置读取连接信息；未配置则失败。
2. 每 2 秒 `GET /api/history/<prompt_id>`，最长 10 分钟，超时失败。
3. `status_str = error` 时以 `messages` 中 `execution_error` 的 `exception_message` 失败。
4. 收集 `outputs` 下所有节点的 `images`（按节点 id、再按数组顺序），`GET /api/view` 取回，最多 10 张，超出的忽略。MIME 取响应 `Content-Type`。
5. `duration_ms` 取 `execution_start` 到 `execution_success` 的时间差，写入 state。

通知文案：`Generated N image(s): asset:…, asset:… (seed 123, 42.3s, template anima)`；失败时为 ComfyUI 的原话。

取消只改 run 状态；ComfyUI 上的任务继续执行，结果被丢弃。

## 6. 模板

移植自 chatbot-sili `src/plugins/comfy-ui/template-loader.ts`（其本身移植自 hermes），去掉文件系统扫描。

识别：
- 正/负向 `CLIPTextEncode`：KSampler 拓扑回溯 → `_meta.title` 关键词 → 负面关键词推断；失败时模板仍列出，标注 `usable_as_template: false` 与原因，只能经 `comfyui_read` 取原图后走原始模式。
- `KSampler`、`EmptyLatentImage`、主模型加载节点（摘要）。
- LoRA：悬空的 `LoraLoader` 为推荐池（名称 + 推荐强度）；主路径上已接线的 `LoraLoader` 使模板 `lora_locked`。

覆盖：
- `prompt`、`negative` 替换对应节点文本；`negative` 省略时保留模板原文。
- 尺寸：`width`+`height` > `aspect_ratio` > 模板默认。**输入是连线时用字面值替换连线**，上游节点随之悬空。预设沿用 hermes 的 NovelAI 风格表（`portrait` 832×1216 等 9 种）。
- `steps`、`cfg`、`seed` 覆盖 KSampler 同名输入；`seed` 省略时随机生成。
- `loras`：按给定顺序串入 model/clip 主路径。名字命中推荐池时复用该节点并以其推荐强度为默认；未命中时新建 `LoraLoader`，默认强度 1。文件是否存在由 ComfyUI 校验。`lora_locked` 的模板拒绝 `loras`。

模板名为文件名去掉 `.json`。非 API 格式（含 `nodes`/`links` 顶层键的 GUI 格式）明确报错。

## 7. 工具

插件未配置时，工具注册表在解析工具时即报错，与其他需要配置的插件一致。ComfyUI 侧的错误以 `{ error, error_type }` 返回给模型。输出超长时截断并注明。

| 工具 | 输入 | 输出 |
|---|---|---|
| `comfyui_list_workflows` | 无 | 模板列表（名称、`usable_as_template`、模型摘要、正负向原文、默认采样参数与尺寸、`suggested_loras`、`lora_locked`）与指南列表。有推荐 LoRA 时附说明：它们是故意不接线的节点，只有在 `loras` 中点名才会接入，省略 `loras` 即不加任何 LoRA。两个目录都未配置时，说明可用 `comfyui_list_models` + `comfyui_node_info` 自行拼图 |
| `comfyui_read` | `path`：`<workflows_dir>/<file>` 或 `<guides_dir>/<file>` | 模板的原始 API JSON 或指南 markdown。只允许已配置目录；单文件上限 256 KB。模板含推荐 LoRA 时附同样的说明，并提示原始模式需自行接线 |
| `comfyui_list_models` | `folder?` | 无参数时目录名列表；否则该目录文件名，最多 500 个 |
| `comfyui_node_info` | `class_types?`（≤20）、`search?` | 按类名返回输入规格；按关键词在类名/显示名/分类中搜索，返回至多 50 条 `{ name, display_name, category }`。候选值列表每项最多 100 个并注明总数。二者至少一个 |
| `comfyui_generate` | 见下 | §5.3 的结果或错误 |

`comfyui_generate` 输入为单个对象，`template` 与 `workflow` 恰好一个：
- 模板模式：`template`、`prompt`（必填）、`negative?`、`aspect_ratio?`、`width?`+`height?`（成对，8 的倍数，256–4096）、`steps?`、`cfg?`、`seed?`、`loras?: [{ name, strength_model?, strength_clip? }]`（≤8）。
- 原始模式：`workflow`（API 格式对象，序列化后 ≤256 KB）。其他字段一律拒绝。

描述需告诉模型：结果以 `<task-notification>` 送达，不要等待或轮询；原始模式下 seed 由自己设置，完全相同的图会命中 ComfyUI 缓存、不产生新图；校验错误里的 `node_errors` 指明了节点与输入名。

## 8. 客户端

- `comfyui_generate` 工具卡片：提交中 / 已开始（模板名、seed）/ 校验错误（逐节点列出）/ 完成后缩略图。
- 通知渲染器：与 `generate_image` 相同的缩略图行。把 `image-generation/client/image-notification.vue` 的实现提取到 `src/client/components/`，两个插件共用。
- 其余 4 个工具用默认工具卡片。

## 9. 测试

unit：
- 模板识别与覆盖：移植 SILI 的解析 / LoRA / applyOverrides 用例；新增连线尺寸被字面值替换、池外 LoRA 新建节点、GUI 格式报错。
- 客户端：错误分类（CF Access HTML、400 校验、404、网络）、base_url 末尾 `/`。
- history 解析：输出图片收集顺序、上限、执行错误提取、耗时计算。

worker：
- `comfyui_generate` 经 mock fetch：校验失败不建 run；成功建出 `interface_protocol = comfyui` 的 run，同一 tool call 重复执行不重复提交。
- `executeImageRun` 分派到注册的 backend，产物进入 `artifacts` 与 `artifact_links`，通知的 `plugin_id` 为 `comfyui`。
- migration 已由 `apply-migrations.ts` 覆盖；`plugin-requirements.test.ts` 自动覆盖 `requires`。

## 10. 文档

- README 功能列表加 ComfyUI。
- `docs/architecture.md` 说明 `imageBackends` 与非 provider 的 artifact run。
- 上线前 `pnpm db:migrate:remote`。
