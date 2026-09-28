# 会话文件：附件、文件读取与文件理解

## 1. 范围与分层

核心只提供纯粹的对话：开箱即用，没有任何与文件工具相关的干扰。文件能力由插件提供，插件之间以依赖串联。

| 层 | 提供 |
|---|---|
| 核心 | 附件上传链路（图片、PDF、音频、视频、文本）、上传策略、把附件交给模型或替换为不可读说明 |
| `file_reader` 插件 | `read_file`；`asset:` 引用、可见集合、附件标注；供其他插件扩展的引用解析服务 |
| `workspace_files` 插件（依赖 `file_reader`） | `vfs:` 与路径引用、带版本的文本读取、二进制工作区文件、`copy_file` 等写入工具 |
| `file_understanding` 插件（依赖 `file_reader`） | `analyze_file` 与用户级文件理解服务模型 |
| `image_generation` 插件（依赖 `file_reader`） | `generate_image` 的参考图引用、产物的 asset 通知 |

另含模型选择器的能力图标与模型详情（§11.4）。

不做：Office 文件、本地 OCR、转写、音视频转码、抽帧、PDF 转图片；供应商专有协议适配（百炼走 chat-completions，保留现有 `dashscope-audio` 请求改写）；插件启停与 cordis 加载生命周期的统一（另立 spec）。

## 2. 插件依赖

### 2.1 声明

- 代码层：插件以 cordis `provide` / `inject` 表达服务依赖。`file_reader` 提供服务 `fileReader`；依赖它的插件 `inject: ['fileReader', …]`。核心的 `cordis.d.ts` 不声明任何文件引用相关的服务或事件。
- 开关层：`PluginManifest.requires?: readonly string[]` 列出被依赖插件的 id。设置页与工具选择器只读 manifest，不加载插件。
- 两层必须一致：一个插件的服务端 `inject` 了另一插件提供的服务，其 manifest 必须 `requires` 该插件。由测试逐插件核对。

### 2.2 语义

- 用户级插件开关：开启一个插件同时开启其依赖（递归）；关闭一个插件同时关闭依赖它的插件（递归）。界面提示连带变化了哪些插件。
- 会话工具选择：选中某插件的工具同时选中其依赖插件的全部工具；取消依赖插件的工具同时取消依赖它的插件的工具。
- 生成开始时，服务端按 `requires` 补齐有效工具集：选中了某插件的工具即补上其依赖插件的工具。不信任存量数据或客户端请求已满足依赖。

## 3. 核心：附件链路

### 3.1 上传

- `file` part `{ type: 'file', attachment_id, mime, filename?, source_encoding? }` 承载 PDF、音频、视频与文本；`image` part `{ type: 'image', attachment_id, artifact_id?, filename? }` 语义不变，composer 上传图片时带原始文件名，粘贴的图片没有文件名。D1、DO 快照与 WebSocket 帧只携带 attachment id。
- 图片沿用现有预处理，大小限制在压缩之后检查；非图片原件存 R2，宽高为空。
- 服务端校验：二进制按文件签名核对声明的 MIME；文本按严格 UTF-8 解码核对。拒绝空文件、类型不符和超限文件。
- 发送消息时校验每个 `file` / `image` part 的 attachment 属于该用户，且 `file` part 的 `mime` 与 attachment 记录一致。
- 附件下载接口支持 `Range` 请求（`206`），供音视频播放与拖动。

### 3.2 文本文件

- 允许的文本 MIME：`text/plain`、`text/markdown`、`text/html`、`text/css`、`text/javascript`、`application/json`、`text/csv`。
- 代码与其他纯文本文件以扩展名为准：浏览器报告的 MIME 不在上述列表时，按扩展名白名单（如 `.py`、`.ts`、`.vue`、`.go`、`.rs`、`.java`、`.sh`、`.yaml`、`.toml`、`.xml`、`.sql`）规范为 `text/plain`；原始扩展名保留在 `filename` 中。
- 编码在浏览器中统一转为 UTF-8 后再上传与计算 sha256，依次：BOM → 文件自身声明（HTML `<meta charset>`、CSS `@charset`）→ 严格 UTF-8 → GB18030。发生转换时 `source_encoding` 记录原编码，附件卡片注明「已从 <编码> 转为 UTF-8」。服务端只接受合法 UTF-8，不做检测。

### 3.3 上传策略

- 只约束聊天消息的附件上传；项目图标、Studio 参考图等以 `purpose=image` 上传，沿用固定的图片规则，不受策略影响。
- 管理员在站点设置中配置允许的 MIME 列表与单文件大小上限，默认全部已支持格式、20 MiB，上限不超过 50 MiB；空列表关闭聊天上传。
- 存于 `site_settings`，经 `/site-config` 下发。存储值中无法识别的格式被忽略，不导致 `/site-config` 或上传接口失败。
- 前端使用已缓存的站点配置显示限制；后端在每次上传与附件去重时独立校验当前配置。

### 3.4 能力判定

文本任何模型都能读。二进制文件能否交给某模型，同时取决于模型声明的输入模态与协议适配器实际能编码的类型（`canReadFile(metadata, protocol, mime)`）；未声明的模态视为不支持：

| 协议 | 可交付 |
|---|---|
| `responses`、`anthropic` | image、pdf |
| `chat-completions` | image、pdf、audio（mp3 / wav）、video |
| `vertex-compatible` | image、pdf、audio、video |

音视频内联传输，不走原生 Files 上传。发给供应商的文件名由插件决定（§4.5）；无插件时不带文件名，图片以外的内联文件以 `file.<ext>` 命名。

### 3.5 交给模型

`buildModelMessages` 对每个 user 附件：

- 能读的二进制：文件 part。
- 不能读的二进制：一句不可读说明，含文件名与 MIME，不发送字节或供应商指针。历史回放按同一判定，切换模型后不重放不受支持的文件。
- 文本：内联为 `<file name="page.html">` + 原文 + `</file>`，不设阈值；超出模型上下文时由供应商报错并如实展示。

模型直接生成的图片不回放像素，也不输出任何文本。

「不可用附件」在附件输入类型中是独立分支，不以空字节表示。

`BuildInput` 可选接收插件提供的文件标注器（§4.5）；未提供时按本节输出，提供时由标注器决定标注、文本内联方式与工具附件包装。

## 4. `file_reader` 插件

插件 id `file_reader`，目录 `src/plugins/file-reader/`。hub 端提供服务 `fileReader` 并注册 `read_file`；Worker 端提供附件列表路由。默认不启用。

### 4.1 asset 标识

asset 对外（模型、标注、工具结果、面板提示）的标识是其 attachment `sha256` 的前 8 位小写十六进制，如 `3f9a2c1e`。自增 attachment id 只在内部使用（外键、下载 URL、WebSocket 帧、Part 字段），不出现在模型可见的任何文本中，包括发给供应商的文件名。

按前缀查找使用 `(user_id, sha256)` 唯一索引上的范围条件 `sha256 >= prefix AND sha256 < next(prefix)`，不用 `LIKE`，且不加 `LIMIT`；结果在内存中按可见集合过滤。

### 4.2 可见集合

Agent 只能引用它在上下文中见过的 asset。本轮工具含 `read_file` 时，生成开始时从当前路径（root → leaf）构建可见集合：

| 来源 | 路径上的位置 |
|---|---|
| 上传 | user 消息中的 `image` / `file` part |
| 模型直接生成 | assistant 消息中的 `image` part |
| `generate_image` 产物 | `task_notification` part 的 `attachments` |
| 工具交付的文件 | `tool_result` part 的 `attachments` |

附件摘要按 id 分批查询，每批不超过 D1 的 100 个绑定参数。本轮内新交付的文件加入集合。其他分支上的 asset 不在集合中。

### 4.3 引用

引用是无 authority 的 URI：

- `asset:<前缀>`：前缀 8–64 位小写十六进制。由 `file_reader` 在可见集合中解析；无匹配返回 `FILE_NOT_FOUND`，多个匹配返回 `AMBIGUOUS_ASSET` 并列出各自更长的前缀。可见集合是 `asset:` 的唯一权限边界，集合外的 asset 一律 `FILE_NOT_FOUND`，不泄露存在性。
- 其他 scheme：由注册了该 scheme 的插件解析（§4.4），自行负责权限校验。无人注册或本轮未启用返回 `UNSUPPORTED_SCHEME`。
- 裸绝对路径（`/project/a.md`）：交给声明认领裸路径的插件（至多一个）；无人认领返回 `INVALID_FILE_REF`。

错误码：`INVALID_FILE_REF`、`UNSUPPORTED_SCHEME`、`FILE_NOT_FOUND`、`AMBIGUOUS_ASSET`、`UNSUPPORTED_FILE`、`READ_RANGE_TOO_LARGE`。

### 4.4 `fileReader` 服务

```ts
interface FileReaderService {
  /** 解析引用。`turn` 携带 userId、conversationId、projectId、本轮工具 id 与可见集合。 */
  resolve(turn: FileTurn, ref: string): Promise<Result<ResolvedFile>>
  /** 把二进制文件交给当前模型（§4.6）。 */
  deliver(turn: FileTurn, file: ResolvedBinary): Result<DeliveredFile>
  /** 插件注册 scheme 解析器；`barePaths` 表示同时认领裸绝对路径。返回注销函数，随注册方 dispose。 */
  registerScheme(scheme: string, resolver: SchemeResolver, options?: { barePaths?: boolean }): () => void
}

type ResolvedFile = ResolvedBinary | ResolvedText
interface ResolvedBinary { kind: 'binary', attachmentId, sha256, ref, mime, size, width, height, filename }
interface ResolvedText {
  kind: 'text', ref, mime, filename, attachmentId?, sha256?
  /** 读取一段；提供方可返回 version 与 unchanged（§5.2）。 */
  read(range: { offset?: number, limit?: number }): Promise<Result<TextRead>>
}
```

`ref` 在二进制结果中始终为 `asset:` 形式；文本结果为调用方所用的引用。`sha256` 只在服务端内部使用。

### 4.5 标注

本轮工具含 `read_file` 时，`file_reader` 向 `buildModelMessages` 提供文件标注器：

- 用户上传的二进制：`[image asset:3f9a2c1e "cat.png"]`、`[file asset:b41d07a9 "report.pdf" application/pdf]`，无文件名时省略引号部分；后接文件 part 或不可读说明。本轮工具含 `analyze_file` 时，不可读说明提示用它。
- 用户上传的文本：不超过 32 KiB 时内联为 `<file asset="3f9a2c1e" name="page.html">` + 原文 + `</file>`；更大时只放 `[file asset:3f9a2c1e "page.html" text/html, 18432 lines — read it with read_file]`。
- 模型直接生成的图片：`[generated image asset:5c2e8f10]`。
- 工具交付的文件：tool 消息后紧跟 user 消息，每个结果一组 `<tool_attachment call_id="…" asset="3f9a2c1e">`、文件 part 或不可读说明、`</tool_attachment>`；该批工具结果全部返回后再追加。本轮由 `prepareStep` 追加，历史由同一构造器重建，两者逐字节一致。只被工具结果引用的附件在轮次持久化前可能被清理，缺失时包装内说明文件已不存在，不抛错；其他缺失的附件照常报错。
- 发给供应商的文件名为 `asset-<前缀>.<ext>`。

标注随 `read_file` 的启用而出现或消失；会话中途切换时历史渲染随之变化，前缀缓存失效一次。

### 4.6 `read_file`

`read_file({ file, offset?, limit? })`，`file` 接受 `asset:`、其他已注册 scheme 与裸路径：

- 文本：带行号的内容（`cat -n` 格式），`offset` / `limit` 分段；asset 文本无版本。
- 二进制：当前模型能读时返回回执 `{ file: 'asset:<前缀>', mime, message }`，以保留键 `__attachments` 交出 attachment id，文件随后按 §4.5 交付，并加入本轮可见集合；`offset` / `limit` 不适用。不能读时返回 `UNSUPPORTED_FILE`；本轮工具含 `analyze_file` 且文件理解模型能读该 MIME 时，建议 `analyze_file` 并给出原引用。

### 4.7 附件列表

Worker 端路由 `GET /api/plugins/file_reader/conversations/:id/assets` 列出本会话所有分支的 asset：`{ attachmentId, ref, source: 'upload' | 'generated', mime, size, width, height, filename, createdAt }`。来源为 user 消息的 `image` / `file` part、assistant 消息中不带 `artifact_id` 的 `image` part、`artifact_runs.conversation_id` 为本会话且未删除的产物；消息 part 用 `json_each(parts)` 在 SQL 中匹配。

## 5. `workspace_files` 插件

`requires: ['file_reader']`，服务端 `inject` `fileReader`。

### 5.1 引用与挂载

- 挂载只有 `/conversation` 与 `/project`；不存在只读投影挂载。
- 注册 scheme `vfs`（`vfs:/project/a.md`）并认领裸绝对路径；只在本轮工具含本插件工具时解析，按挂载作用域校验权限。
- 本插件工具的路径参数同时接受裸路径与 `vfs:` 写法；结果中的路径为裸路径。

### 5.2 读取

- 文本文件解析为带 `read` 的 `ResolvedText`：返回 `version`，记录本轮已读；本轮已完整读过且此后未写入时返回 `unchanged`。`write_file` / `edit_file` 的先读后写校验依赖这一记录。
- 二进制文件解析为当前版本 attachment 的 `ResolvedBinary`。

### 5.3 二进制与只读

- 工作区文件可为二进制，按当前版本的 `mime` 区分（非 `text/*` 即二进制）。
- `write_file` / `edit_file`：目标为二进制时返回 `BINARY_FILE`，包括未读过的目标。
- `preview_file`：二进制文件以其自身类型打开，结果注明。
- 各工具对 `asset:` 的处理：`copy_file` 的 `from` 经 `fileReader.resolve`；`write_file`、`edit_file`、`rename_file`、`delete_file`、`copy_file` 的 `to` 返回 `READ_ONLY` 并提示先 `copy_file` 到工作区；`restore_file`、`list_files`、`preview_file` 返回 `INVALID_PATH`；其他 scheme 在写入类参数中返回 `INVALID_PATH`。

### 5.4 `copy_file`

`copy_file({ from, to })`：`from` 为任意文件引用或路径，`to` 为工作区路径。新文件版本 1 直接指向来源的 attachment，不复制字节；`to` 已存在时返回 `FILE_ALREADY_EXISTS`。文本与二进制均可。

### 5.5 字节回收

附件引用检查（`attachmentInUse`）覆盖工作区版本、产物、run 输入、项目图标、消息 part 的 `attachment_id`，以及 `tool_result.attachments` 与 `task_notification.attachments`，均按 `json_each` 精确匹配。

## 6. `file_understanding` 插件

`requires: ['file_reader']`，服务端 `inject` `fileReader`。

- `analyze_file({ file, question? })`：`fileReader.resolve` → 文件理解服务，只接受二进制。成功结果为 `{ file, mime, model, text, truncated }`，`file` 为 `asset:` 形式。
- 文件理解服务模型只在本轮启用了 `analyze_file` 时解析。
- system 消息只含配置的提示词；user 消息含文件与独立的 `question`。无 `question` 时不捏造意图、不附加压缩指令。
- 错误区分：引用错误（§4.3）、文件类型不被服务模型或其接口支持（`UNSUPPORTED_FILE`）、服务未配置或不可用（`SERVICE_UNAVAILABLE`）、供应商调用失败（`ANALYSIS_FAILED`）。失败作为工具错误返回。
- 随当前生成任务取消；客户端断开不取消。辅助模型不注册工具。
- 分析文本按普通 tool_result 存储，历史回放不重复分析；不做跨调用缓存。

## 7. `image_generation` 插件

`requires: ['file_reader']`，服务端 `inject` `fileReader`。

- `reference_images: string[]`（1..10），每项为文件引用，经 `fileReader.resolve` 解析，必须为图片；带参考图即为改图（`operation = 'edit'`）。
- 引用无效、非图片、生图模型不支持图片输入时返回错误，不创建 run。
- 任务通知：`TaskNotificationPart.attachments?: number[]` 记录产物 attachment id；摘要为 `Generated 2 image(s): asset:5c2e8f10, asset:9a01d3c4`。

## 8. 设置与提示词

- `service_models.file_understanding`：可选 ModelRef，null 关闭。所选模型须支持 text 输入与输出，且至少支持 image / pdf / audio / video 之一；每次调用按文件 MIME 检查对应模态。
- `service_prompts.file_understanding`：默认值为附录 A；对话命名默认模板为附录 B。
- 设置界面只保存与默认值不同的提示词；等于默认值时存为未设置，使默认值更新能生效。各提示词提供恢复默认。
- 服务模型的解析复用 `hub/service-model.ts` 的同一解析函数，按槽位与校验函数参数化。
- 设置界面以能力图标展示所选模型支持的文件类型。

## 9. 迁移

`view_file` 取消，`read_file` 从 `workspace_files` 移到 `file_reader`，文件引用代码从核心移到 `file_reader`。本分支从未部署，不做数据迁移。

## 10. 验证

- 插件依赖：manifest `requires` 与服务端 `inject` 一致；开关与工具选择的连带开启、连带关闭；服务端补齐有效工具集。
- 核心：无插件时附件标注、asset 引用、文件工具提示均不出现；文本全文内联；不能读的二进制替换为说明。
- asset 可见集合：别的用户、别的会话、其他分支上的 asset 在 `asset:` 下均为 `FILE_NOT_FOUND`；任务通知产物与本轮交付的文件可引用；前缀冲突返回 `AMBIGUOUS_ASSET`；模型可见文本与供应商文件名中不出现自增 id。
- 引用：未知 scheme、格式错误、本轮未启用工作区时的 `vfs:` 与裸路径均报对应错误；工作区可解析复制进 `/project` 的二进制文件。
- `read_file`：asset 文本、工作区文本（`version`、`unchanged`、先读后写）、二进制交付；本轮与历史重建一致；并行调用顺序；Anthropic 合并相邻 user 消息后工具结果块在前；不能读时的错误与 `analyze_file` 建议条件。
- 工作区：`copy_file` 从 `asset:`、`vfs:`、裸路径复制并共享 attachment；清理副本不删除仍被引用的字节；写入类工具对二进制与 `asset:` 的错误。
- 标注：上传、生成、任务通知的 asset 标注；32 KiB 阈值两侧的文本；清理后缺失的工具附件；模型切换后的历史回放。
- 文本上传：UTF-8、带 BOM、HTML 声明的 GBK、无声明的 GBK 转换；非法 UTF-8 被服务端拒绝；按扩展名规范为 `text/plain`。
- `generate_image` 引用解析与非图片拒绝。
- `analyze_file`：服务模型实际收到原样 system、独立 question 与正确文件；未配置、类型不支持、调用失败、取消。
- 上传：大图压缩后通过、空文件、超限、签名不符、策略关闭、MIME 不一致的 part 被拒；Range 请求。
- 上传策略：只影响聊天上传；损坏的存储值不影响 `/site-config`。
- 设置：等于默认值的提示词不落库；保存不覆盖其他槽位。
- 执行相关定向测试与 `pnpm typecheck`；合并或推送前执行全量测试。

同步更新 README 与 AGENTS.md 的文件支持、插件依赖与工具说明。

## 11. UI

### 11.1 消息

- 图片沿用现有预览；PDF 为文件卡片（类型图标、文件名、大小、打开与下载）；文本为文件卡片（语言图标、文件名、行数、打开与下载，转换过编码的注明）；音频、视频为播放器，浏览器无法播放时显示明确状态并保留下载。多个附件之间保持间距，编辑消息不改变 part 顺序。
- 拖拽遮罩在聊天上传关闭时显示「本站已关闭文件上传」。

### 11.2 文件面板（`workspace_files`）

分组沿用「标题 + 一行说明」样式，不显示挂载路径：

| 分组 | 数据 | 说明 | 操作 |
|---|---|---|---|
| 当前会话 | `/conversation` | 只有这次会话能读到。 | 下载、删除、打包 |
| 本会话的附件 | `file_reader` 附件列表（§4.7） | 你发送的和生成的文件，只读。 | 下载 |
| 当前项目 | `/project` | 这个 Project 下的所有会话都能读到。 | 下载、删除、打包 |

- 附件组为空时不显示；组内平铺，与文件树行同一行样式。
- 行：图片为缩略图，PDF / 音频 / 视频为类型图标，文本为语言图标；名称为原始文件名，生成图为「图片 · 时间」；元信息为大小，图片附尺寸。附件行悬停显示 `asset:<前缀>`，工作区文件行悬停显示 `vfs:<路径>`。
- 预览统一由 `WorkspaceFilePreview` 承担：文本沿用现有渲染；图片直接显示；PDF 用浏览器内置阅读器；音视频用播放器。
- 刷新：本会话 `isStreaming` 状态切换时与手动刷新按钮；不监听消息内容。

### 11.3 工具卡片

- `read_file`：文本显示读取范围；二进制显示文件名与缩略图或类型图标。
- `copy_file`：来源 → 目标。
- `analyze_file`：文件、问题、可展开的完整结果与截断状态。

### 11.4 设置与模型选择器

- 插件开关与工具选择器显示依赖关系，连带开关时提示。
- 能力图标（输入模态、推理、工具）与模型详情悬浮卡。
- 模型编辑器的新建模式保留，列表恢复「手动」与「运营商已移除」徽标。

## 附录 A：文件理解默认系统提示词

```text
You are a visual description subagent (Vision Subagent). Your output will be provided as text input to another large language model that cannot see the original image and must rely solely on your description for subsequent reasoning. Your description must therefore be objective, detailed, and structured, and must clearly distinguish "observed facts" from "inferences."

## Output Principles

1. **Faithfulness first**: Describe only what is actually visible in the image. Do not add background knowledge or imagined narratives beyond the scene.
2. **Levels of certainty**: Indicate the confidence of each judgment.
   - Clearly visible facts → State them directly ("There is a white cat in the image").
   - High-confidence inferences → Use "looks like / appears to be."
   - Low-confidence inferences → Use "may be / possibly."
   - Cannot determine → Explicitly say "cannot determine" rather than guessing.
3. **Avoid hallucinations**: Do not invent text, people's identities, or place names. If text in the image is blurry, describe it as "blurry text, possibly XXX" rather than presenting it as a definitive transcription.
4. **Neutral tone**: Do not judge beauty or ugliness or add emotional embellishment, except when describing the atmosphere conveyed by the image itself.

## Output Structure

Organize the description in the following order. Sections with no relevant content may be omitted.

**[Image Type]**
Classify the image in one sentence: photograph / landscape painting / portrait / anime illustration / poster / screenshot / meme / chart / comic / hand-drawn sketch, etc. Indicate if it is a composite image or collage.

**[Overall Scene]**
Apparent resolution, color palette, composition, lighting, and placement of the main subject. Summarize "what it looks like" in one or two sentences.

**[Main Content]**

- People: Number, gender presentation, apparent age range, racial features (only when obvious), clothing, posture, facial expression, gaze direction, and objects held. Do not assign a specific identity unless there are clear identifying cues (jersey numbers, name tags, or an extremely well-known public figure); otherwise describe the person as "a person who..."
- Objects: Type, number, material, color, relative position, and condition (intact / damaged / in use).
- Animals: Species, breed (if identifiable), posture, and action.
- Setting: Indoors / outdoors, specific type of place (kitchen, street, forest, office), and apparent time of day (daytime / nighttime / dusk).

**[Location Assessment]**
For landscape or scene images:

- Prioritize describing geographic features (coastline, mountains, desert, urban streetscape, East Asian streets, European-style architecture, etc.).
- Name a specific location only when a clear landmark is present (the Eiffel Tower, Tokyo Tower, the Statue of Liberty, etc.).
- Otherwise, describe it as "stylistically resembles the XX region," explicitly noting that this is an inference based on architecture, vegetation, or signage.
- If authenticity cannot be determined, state "cannot determine whether this is a real location or a fictional setting."

**[Text Content]**
Transcribe all readable text in the image, item by item, preserving its original language, script, and wording. Do not translate, paraphrase, or transliterate the transcribed text. For example, Chinese text in the image must remain Chinese in this section, regardless of the language used for the surrounding description. Preserve each language as written when the image contains multiple languages. Distinguish between:

- Clearly readable → Transcribe directly.
- Partially readable → Transcribe the recognized portions and mark [blurry].
- Completely unreadable → Describe its location and approximate number of characters.
- No text present.

**[Style and Technique]** (art images only)
Artistic style (realism, cartoon, cyberpunk, ukiyo-e, pixel art, etc.), medium (oil painting, watercolor, digital painting, 3D rendering), and any distinctive stylistic traits of a particular artist (mention only when highly confident; otherwise describe the stylistic features alone).

**[Other Clues]** (optional)
Watermarks, logos, signatures, UI elements, timestamps, version numbers, and other details that may be useful for downstream reasoning.

**[Uncertainties]** (optional)
List any elements you noticed but could not determine, so the downstream model can decide whether to ask follow-up questions or disregard them.

## Notes

- Do not answer subjective questions such as "What is this image trying to convey?" unless explicitly requested by the main model; describe only the image itself.
- If the image is of very low quality, too dark, overexposed, or corrupted, state this first, then describe it as best you can.
```

## 附录 B：对话命名默认模板

```text
### Task:

Generate a concise title summarizing the chat history.

### Guidelines:

- The title should clearly represent the main theme or subject of the conversation.
- Keep it short: 2-4 words is best. (Or 4-8 Chinese characters)
- Do not use emojis, quotation marks, or special formatting.
- Write the title in the user's language; default to English if multilingual.
- Prioritize accuracy over creativity.
- Your entire response must consist solely of the title itself, without any introductory or concluding text.
- The output must be a plain text, without any markdown code fences or other encapsulating text.

### Output Examples:

- Stock Trends
- Chocolate Chip Cookies
- Music Streaming
- Remote Work

### Chat History:

<chat_history>
{user_message:1}
</chat_history>
```
