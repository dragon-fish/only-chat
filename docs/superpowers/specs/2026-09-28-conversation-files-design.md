# 会话文件：asset、文件引用与文件理解

## 1. 范围

- **asset（核心）**：会话里的每个文件（用户上传的、模型生成的）都是一个不可变的 asset，以 attachment id 编号。
- **文件引用（核心）**：所有接受文件的工具只认 `asset:<id>`；其他协议由提供方插件经钩子翻译为 asset。
- **附件链路（核心）**：上传从图片扩展到 PDF、音频、视频；上传格式与大小由管理员配置。
- **workspace-files 插件**：提供 `vfs:` 协议；工作区可存放二进制文件；新增 `copy_file`。
- **文件理解插件（新）**：`view_file` 与 `analyze_file`，以及用户级文件理解服务模型。
- **模型选择器**：能力图标与模型详情。

不做：Office 文件、本地 OCR、转写、音视频转码、抽帧、PDF 转图片；供应商专有协议适配（百炼走 chat-completions，保留现有 `dashscope-audio` 请求改写）。

## 2. asset

会话的 asset 集合在读取时派生，不另存表：

| 来源 | 条件 |
|---|---|
| 上传 | 本会话任一 user 消息中的 `image` / `file` part（含所有分支） |
| 模型直接生成 | 本会话 assistant 消息中不带 `artifact_id` 的 `image` part |
| `generate_image` 产物 | `artifact_runs.conversation_id` 为本会话、`artifacts.deleted_at` 为空 |

模块 `src/server/plugins/assets/conversation-assets.ts`：

- `listConversationAssets(db, userId, conversationId)` → `ConversationAsset[]`
- `findConversationAsset(db, userId, conversationId, attachmentId)` → `ConversationAsset | null`
- `ConversationAsset = { attachmentId, source: 'upload' | 'generated', mime, size, width, height, filename, createdAt }`

消息 part 的匹配在 SQL 中用 `json_each(parts)` 完成，不把整段会话的 parts 取回内存。`findConversationAsset` 是 `asset:` 的唯一权限边界：id 不属于该用户的该会话时返回 null，不泄露存在性。

`ImagePart` 增加可选 `filename`，composer 上传图片时带上原始文件名；粘贴的图片没有文件名。

## 3. 文件引用

### 3.1 格式

引用是无 authority 的 URI：

- `asset:<id>` —— 核心协议。
- `vfs:<绝对路径>`，如 `vfs:/project/refs/cat.png` —— workspace-files 插件提供。

裸路径（`/project/…`）、未知 scheme、格式错误一律报错，不猜测。裸路径的错误信息给出对应的 `vfs:` 写法。

### 3.2 解析

核心函数 `resolveFileRef(ctx, turn, ref) → Result<ResolvedFile>`，`ResolvedFile = { attachmentId, mime, size, width, height, filename }`：

- `asset:<id>`：核心经 `findConversationAsset` 解析。
- 其他 scheme：`ctx.serial('file/resolve', ref, turn)`，取第一个非空结果；无人认领返回 `UNSUPPORTED_SCHEME`。钩子自行负责其 scheme 的权限校验。

`turn` 携带 `userId`、`conversationId`、`projectId` 与本轮工具 id 列表。接受文件的工具（`view_file`、`analyze_file`、`generate_image.reference_images`、`copy_file` 的来源）全部经此函数解析，不直接依赖任何提供方插件。

错误码：`INVALID_FILE_REF`、`UNSUPPORTED_SCHEME`、`FILE_NOT_FOUND`、`UNSUPPORTED_FILE`。

### 3.3 交付给当前模型

核心函数 `deliverFile(runtime, file)`：

- 当前模型能读该 MIME（§6.3 的判定）：返回工具回执 `{ file, mime, message }`，并以保留键 `__attachments` 交出 attachment id，文件随后作为 user 消息交付（§7.2）。
- 否则返回 `UNSUPPORTED_FILE`；本轮工具含 `analyze_file` 且文件理解模型能读该 MIME 时，错误信息建议 `analyze_file` 并给出原引用。

`view_file` 与 `read_file` 的二进制分支共用它。

## 4. workspace-files 插件

- 挂载只有 `/conversation` 与 `/project`；不存在只读投影挂载。
- 注册 `file/resolve` 钩子：本轮工具含 workspace-files 工具时认领 `vfs:`，解析为该文件当前版本的 attachment，按挂载作用域校验权限；否则返回 undefined。
- 工作区文件可为二进制，按当前版本的 `mime` 区分（非 `text/*` 即二进制）：
  - `read_file`：文本照旧（行号、`offset`/`limit`、`version`、`unchanged`）；二进制经 `deliverFile` 交付，`offset`/`limit` 不适用。
  - `write_file` / `edit_file`：目标为二进制时返回 `BINARY_FILE`。
  - `rename` / `delete_file` / `restore_file`：不区分类型。
- `copy_file(from, to)`：`from` 为文件引用（经 `resolveFileRef`），`to` 为 VFS 路径。新文件版本 1 直接指向来源的 attachment，不复制字节；`to` 已存在时返回 `FILE_ALREADY_EXISTS`。
- 附件引用检查（`attachmentInUse`）覆盖 `tool_result.attachments`，与 `attachment_id` 一样按 `json_each` 精确匹配。

## 5. 文件理解插件

插件 id `file_understanding`，目录 `src/plugins/file-understanding/`，hub 端注册工具，不依赖 workspace-files。

- `view_file({ file })`：`resolveFileRef` → `deliverFile`。
- `analyze_file({ file, question? })`：`resolveFileRef` → 文件理解服务。成功结果为 `{ file, mime, model, text, truncated }`。

文件理解服务模型只在本轮启用了 `analyze_file` 时解析。

`analyze_file` 细则：

- system 消息只含配置的提示词；user 消息含文件与独立的 `question`。无 `question` 时不捏造意图、不附加压缩指令。
- 错误区分：引用错误（§3.2）、文件类型不被服务模型或其接口支持、服务未配置或不可用（`SERVICE_UNAVAILABLE`）、供应商调用失败（`ANALYSIS_FAILED`）。失败作为工具错误返回。
- 随当前生成任务取消；客户端断开不取消。辅助模型不注册工具。
- 分析文本按普通 tool_result 存储，历史回放不重复分析；不做跨调用缓存。

## 6. 附件链路

### 6.1 上传

- 通用 `file` part `{ type: 'file', attachment_id, mime, filename? }` 承载 PDF、音频、视频；`image` part 语义不变。D1、DO 快照与 WebSocket 帧只携带 attachment id。
- 图片沿用现有预处理，大小限制在压缩之后检查；非图片原件存 R2，宽高为空。
- 服务端校验文件签名与声明的 MIME 一致，拒绝空文件、类型不符和超限文件。
- 发送消息时校验每个 `file` / `image` part 的 attachment 属于该用户，且 part 的 `mime` 与 attachment 记录一致。
- 附件下载接口支持 `Range` 请求（`206`），供音视频播放与拖动。

### 6.2 上传策略

- 只约束聊天消息的附件上传；项目图标等其他上传不受影响。
- 管理员在站点设置中配置允许的 MIME 列表与单文件大小上限，默认全部已支持格式、20 MiB，上限不超过 50 MiB；空列表关闭聊天上传。
- 存于 `site_settings`，经 `/site-config` 下发。存储值中无法识别的格式被忽略，不导致 `/site-config` 或上传接口失败。
- 前端使用已缓存的站点配置显示限制；后端在每次上传与附件去重时独立校验当前配置。

### 6.3 能力判定

一个文件能否交给某模型，同时取决于模型声明的输入模态与协议适配器实际能编码的类型（`canReadFile(metadata, protocol, mime)`）：

| 协议 | 可交付 |
|---|---|
| `responses`、`anthropic` | image、pdf |
| `chat-completions` | image、pdf、audio（mp3 / wav）、video |
| `vertex-compatible` | image、pdf、audio、video |

音视频内联传输，不走原生 Files 上传。发给供应商的文件名由 attachment id 与 MIME 生成，不使用用户文件名。

## 7. 模型消息

### 7.1 标注

附件标注始终加入，不随本轮工具变化：

- 用户上传：`[image asset:123 "cat.png"]`、`[file asset:124 "report.pdf" application/pdf]`，无文件名时省略引号部分。
- 模型直接生成的图片（不回放像素）：`[generated image asset:130]`。
- 任务通知摘要：`Generated 2 image(s): asset:130, asset:131`。

当前模型不能读的用户附件：保留标注，文件 part 替换为一句不可读说明；本轮工具含 `analyze_file` 时说明中提示用它。历史回放按同一判定，切换模型后不重放不受支持的文件。

「不可用附件」在附件输入类型中是独立分支，不以空字节表示。

### 7.2 工具结果中的文件

- 工具输出用保留键 `__attachments` 交出 attachment id；累加器将其移到 `tool_result.attachments`，不写入 `content`。
- `buildModelMessages` 在含这些结果的 tool 消息后紧跟 user 消息，每个结果一组：`<tool_attachment call_id="…">`、文件 part、`</tool_attachment>`。本轮由 `prepareStep` 追加，历史由同一构造器重建，两者逐字节一致（前缀缓存）。
- 并行调用：该批工具回执全部返回后再追加 user 消息。
- 历史回放时当前模型不能读该文件：包装内以引用、MIME 与不可读说明替代文件 part。

## 8. generate_image

- `reference_images: string[]`（1..10），每项为文件引用，经 `resolveFileRef` 解析，必须为图片；带参考图即为改图（`operation = 'edit'`）。
- 引用无效、非图片、生图模型不支持图片输入时返回错误，不创建 run。
- 任务通知摘要见 §7.1。

## 9. 设置与提示词

- `service_models.file_understanding`：可选 ModelRef，null 关闭。所选模型须支持 text 输入与输出，且至少支持 image / pdf / audio / video 之一；每次调用按文件 MIME 检查对应模态。
- `service_prompts.file_understanding`：默认值为附录 A；对话命名默认模板为附录 B。
- 设置界面只保存与默认值不同的提示词；等于默认值时存为未设置，使默认值更新能生效。各提示词提供恢复默认。
- 服务模型的解析复用 `hub/service-model.ts` 的同一解析函数，按槽位与校验函数参数化。
- 设置界面以能力图标展示所选模型支持的文件类型。

## 10. UI

### 10.1 消息

- 图片沿用现有预览；PDF 为文件卡片（类型图标、文件名、大小、打开与下载）；音频、视频为播放器，浏览器无法播放时显示明确状态并保留下载。多个附件之间保持间距，编辑消息不改变 part 顺序。
- 拖拽遮罩在聊天上传关闭时显示「本站已关闭文件上传」。

### 10.2 文件面板

分组沿用「标题 + 一行说明」样式，不显示挂载路径：

| 分组 | 数据 | 说明 | 操作 |
|---|---|---|---|
| 当前会话 | `/conversation` | 只有这次会话能读到。 | 下载、删除、打包 |
| 本会话的附件 | 核心接口，`listConversationAssets` | 你发送的和生成的文件，只读。 | 下载 |
| 当前项目 | `/project` | 这个 Project 下的所有会话都能读到。 | 下载、删除、打包 |

- 附件组为空时不显示；组内平铺，与文件树行同一行样式。
- 行：图片为缩略图，PDF / 音频 / 视频为类型图标，文本沿用语言图标；名称为原始文件名，生成图为「图片 · 时间」；元信息为大小，图片附尺寸。附件行悬停显示 `asset:<id>`，工作区文件行悬停显示 `vfs:<路径>`。
- 预览统一由 `WorkspaceFilePreview` 承担，入参 `{ kind: 'file', id } | { kind: 'asset', attachmentId }`：文本沿用现有渲染；图片直接显示；PDF 用浏览器内置阅读器；音视频用播放器。
- 刷新：本会话 `isStreaming` 状态切换时与手动刷新按钮；不监听消息内容。
- 附件接口属于核心 API（`GET /api/conversations/:id/assets`），不经 workspace-files 插件路由。

### 10.3 工具卡片

- `read_file`（二进制）/ `view_file`：文件名与缩略图或类型图标。
- `copy_file`：来源 → 目标。
- `analyze_file`：文件、问题、可展开的完整结果与截断状态。

### 10.4 模型选择器

- 能力图标（输入模态、推理、工具）与模型详情悬浮卡。
- 模型编辑器的新建模式保留，列表恢复「手动」与「运营商已移除」徽标。

## 11. 验证

- asset 权限：别的用户、别的会话、已删除产物的 id 在 `asset:` 下均为 `FILE_NOT_FOUND`。
- 文件引用：裸路径、未知 scheme、本轮无 VFS 时的 `vfs:` 均报对应错误；VFS 钩子可解析复制进 `/project` 的二进制文件。
- `copy_file` 从 `asset:` 与 `vfs:` 复制，新文件共享 attachment；删除并清理副本不删除仍被消息引用的字节；`tool_result.attachments` 引用的字节不被清理。
- `read_file` / `view_file` 交付：能读时回执 + 包装 user 消息，本轮与历史重建一致，并行调用顺序正确，Anthropic 合并相邻 user 消息后工具结果块在前；不能读时的错误与 `analyze_file` 建议条件正确。
- `write_file` / `edit_file` 对二进制返回 `BINARY_FILE`。
- 标注：上传、生成、任务通知的 asset 标注；不可读附件的替代文本；模型切换后的历史回放。
- `generate_image` 引用解析与非图片拒绝。
- `analyze_file`：服务模型实际收到原样 system、独立 question 与正确文件；未配置、类型不支持、调用失败、取消。
- 上传：大图压缩后通过、空文件、超限、签名不符、策略关闭、MIME 不一致的 part 被拒；Range 请求。
- 上传策略：只影响聊天上传；损坏的存储值不影响 `/site-config`。
- 设置：等于默认值的提示词不落库；保存不覆盖其他槽位。
- 执行相关定向测试与 `pnpm typecheck`；合并或推送前执行全量测试。

同步更新 README 的文件支持与工具说明。

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
