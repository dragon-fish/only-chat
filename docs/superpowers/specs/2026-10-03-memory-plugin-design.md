# 记忆插件与插件 system 段

## 1. 范围

让模型跨对话记住用户与 Project 的信息，形态对标 Claude Code 的 auto memory：一批记忆文件 + 一份由元信息生成的 catalog，catalog 在对话开头注入，模型按需读写正文。

| 层 | 提供 |
|---|---|
| 核心 | 插件 system 段注册与渲染（§2）；`GenerationTurn.preamble` 与首条用户消息注入（§5） |
| `workspace_files` 插件 | `/memory/user`、`/memory/project` 两个挂载点（§3） |
| `memory` 插件（依赖 `workspace_files`） | `memory_save` 工具、`memories` 元信息表、catalog 快照、system 段 |

记忆正文就是工作区文件：读用 `read_file`，改用 `edit_file` / `write_file`，删用 `delete_file`，改名或换作用域用 `rename_file`，版本历史、回收站、文件面板全部沿用。记忆插件只替代 Claude Code 中「手写 MEMORY.md 索引 + frontmatter」的部分。

不做：catalog 的对话内刷新；UI 内编辑 type / description；独立的记忆管理页；记忆专用的读、改、删工具。

## 2. 插件 system 段（核心）

### 2.1 注册

hub 侧新增服务 `promptSections`（声明于 `cordis.d.ts`）：

```ts
interface PromptSectionInput {
  /** 本轮提供的工具，含 requires 级联。 */
  toolIds: readonly string[]
}
type PromptSection = (input: PromptSectionInput) => string | undefined

ctx.promptSections.register(pluginId, section): () => void   // 随注册方插件生命周期释放
```

- `section` 是同步纯函数，唯一输入是本轮工具集。拿不到配置、用户、对话、时间或数据库，因此写不出不稳定的内容。
- 一个插件最多注册一段；重复注册抛错。
- 需要按对话或按轮变化的内容不得进 system 段，走用户消息（§5）或工具结果。

### 2.2 渲染

在 `generation.ts` 组装 `BeforeSendPayload` 之前计算最终 system prompt：

1. 用户自己的 system prompt（Project 与会话拼接，现有逻辑）在最前。
2. 按 `pluginManifests` 的顺序遍历已注册的段，调用 `section(input)`；返回 `undefined` 或空串的插件不留任何痕迹。
3. 每段包为 `<plugin id="<pluginId>">\n…\n</plugin>`，段之间以一个空行分隔，接在用户 prompt 之后（同样空一行）。
4. 用户 prompt 为空且没有任何段时，不发 system 消息（现有行为）。

顺序只由 `pluginManifests` 决定，与 `ctx.parallel` 完成顺序、插件加载顺序、注册顺序无关。

### 2.3 缓存

system 段的唯一输入是工具集，而工具定义在 Anthropic 缓存前缀中排在 system 之前：会改变 system 段的变化，本来就已让缓存失效。system 段不引入新的失效维度。

## 3. 工作区挂载点 `/memory`

### 3.1 路径

- `/memory/user/<relative>`：归属用户，所有对话共享。
- `/memory/project/<relative>`：归属对话所在的 Project，与 `/project` 是两个互不相干的命名空间。
- `/memory` 本身是只含 `user`、`project` 两个子项的目录，不能直接存文件。
- 挂载点集合变为 `project | conversation | memory/user | memory/project`；路径解析与格式化支持两段式挂载点。
- 对话不属于 Project 时，`/memory/project` 报 `MOUNT_UNAVAILABLE`，与 `/project` 一致。
- 跨挂载点 `rename_file` 照常是移动，包括在 `/memory/*` 与其他挂载点之间。

### 3.2 存储

`workspace_files` 新增列 `mount TEXT NOT NULL`，取值与路径中的挂载点相同：`project | conversation | memory/user | memory/project`，存储与解析之间无需转换。挂载点一律读 `mount`，不再从 `project_id` / `conversation_id` 推断。

| mount | `project_id` | `conversation_id` |
|---|---|---|
| `project` | 有 | null |
| `conversation` | null | 有；回收站孤儿为 null |
| `memory/user` | null | null |
| `memory/project` | 有 | null |

- 迁移回填：`project_id` 非空为 `project`，其余为 `conversation`。
- 唯一索引：`workspace_files_project_path_uq` 改为 `(project_id, mount, relative_path)`；新增 `(user_id, relative_path) WHERE deleted_at IS NULL AND mount = 'memory/user'`。
- Project 删除时 `memory/project` 文件随 `project_id` 级联；`detachConversationFiles` 与分叉复制只处理 `conversation`。

以下各处改按 `mount` 判断（现状均从两个 id 推断）：

- `service.ts`：`scopeOf`、`whereScope`、`FileRecord` 格式化（`FileRecord` 增加 `mount` 字段）。
- 回收站：孤儿 = `mount = 'conversation' AND conversation_id IS NULL`。`listTrash` 包含两种记忆挂载点的已删除文件；`undelete` 只对孤儿报 `MOUNT_UNAVAILABLE`，记忆文件可正常还原；「清空孤儿」不会触及记忆文件。
- 预览：`PreviewTicket` 携带 `mount`；`memory/user` 的 `scopeId` 为 `userId`。`previewUrlFor` 与票据路由按 `mount` 重建 scope。票据只在记忆已开放时签发（§3.3），之后不再复查开关，随 TTL 过期。

### 3.3 开放与门禁

`/memory/*` 默认不可用。门禁位于 service 层，而不是工具入口：`WorkspaceScope` 增加必填字段 `memory: boolean`，为 false 时两种记忆挂载点报 `MOUNT_UNAVAILABLE`，`list_files /` 不列出 `/memory`。

- hub 侧：workspace-files 导出 `openMemoryMounts(state)` 与 `memoryOpen(state)`（`src/plugins/workspace-files/server/memory.ts`）。记忆插件在 `generation/prepare` 中、本轮生效时调用前者；workspace 工具与 `vfs:` 解析器（`read_file`、`analyze_file`、生图参考图共用）一律以 `memoryOpen(turn.state)` 填写 scope。依赖方向是记忆 → workspace。
- `vfs:` 解析失败时沿用现有的错误码转换：错误码为 `FILE_NOT_FOUND`，消息为 `MOUNT_UNAVAILABLE` 的说明文字（与无 Project 时访问 `/project` 一致）。
- Worker 侧：REST 路由以用户的 `memory` 插件开关填写 `memory`。

### 3.4 文件面板与打包下载

- `GET /conversations/:id/files` 的响应增加 `memoryFiles: { user, project }`，与 `files`、`projectFiles` 并列；未开启记忆时不返回该字段。
- 打包下载每个挂载点各一个路由：`/memory/archive`（用户记忆）与 `/projects/:id/memory/archive`（Project 记忆），与既有的 `/projects/:id/files/archive`、`/conversations/:id/files/archive` 并列，避免 `/project/a.md` 与 `/memory/project/a.md` 混在一起。
- 客户端 `api.ts` 契约与 `workspace-file-panel.vue` 增加「记忆」分组，内含用户与 Project 两个子组。

## 4. 记忆插件

### 4.1 Manifest

- id `memory`，`requires: [workspace_files]`，工具 `memory_save`，无配置项。
- 这项依赖是工具层面的，不是服务注入：`test/worker/plugin-requirements.test.ts` 以 `TOOL_REQUIREMENTS` 登记它。
- 三处注册清单照常各加一项：`plugin-manifests.ts`、`client/plugins/loaders.ts`、`server/app.ts`。

本轮生效 ⇔ `turn.toolIds.includes('memory_save')`。`requires` 级联保证文件工具同时在场。

### 4.2 `memories` 表

| 列 | 说明 |
|---|---|
| `file_id` | 主键，FK → `workspace_files.id`，ON DELETE CASCADE |
| `user_id` | FK → `users.id`，ON DELETE CASCADE；所有查询带它 |
| `type` | `user` / `feedback` / `project` / `reference` |
| `description` | 一行摘要，1–200 字符 |
| `updated_at` | 元信息最后修改时间 |

路径与作用域不存，从文件行推出。由此文件生命周期无需任何钩子：

| 文件事件 | 结果 |
|---|---|
| rename（含 `/memory/user` ↔ `/memory/project`） | `file_id` 不变，元信息随行 |
| 软删除（工具或面板） | catalog 只取未删除文件，自动隐藏 |
| 回收站还原 | 自动重现，元信息完好 |
| 彻底清除 | FK 级联删除元信息 |
| 移出 `/memory` | catalog 不再列出；移回即重现 |
| `write_file` / `copy_file` / `restore_file` 在 `/memory` 下新建 | 新 `file_id`，无元信息，catalog 标为未描述（§4.4） |

### 4.3 `memory_save`

```ts
{
  path: string          // 必须位于 /memory/user/ 或 /memory/project/ 之下
  type: 'user' | 'feedback' | 'project' | 'reference'
  description: string   // 1–200 字符，单行
  content?: string      // 正文
}
```

带 `content`：

1. 调用 workspace-files 导出的 `writeWorkspaceFile`，即 `write_file` 本身的执行逻辑（同文件写入排队、已见账本、`staleReadVersion`）：新建或整篇覆盖，覆盖不要求先读，旧版本保留。目标是二进制文件时报 `BINARY_FILE`。
2. `WriteResult` 增加返回 `fileId`。元信息以该 `fileId` 做条件 upsert：仅当该文件的 `current_version` 仍等于刚写入的版本时才写入。条件不成立，说明别的对话在此期间改了正文，此时正文已写入、元信息未写入，返回 `METADATA_CONFLICT`，提示重新读取后再保存描述。
3. 新版本记入本轮已见账本，与 `write_file` 一致。

不带 `content`：

- 文件必须已存在，否则报 `FILE_NOT_FOUND`。
- 只 upsert 元信息，文本与二进制文件均可。不读正文，因此不计入已见账本。

通用规则：

- 路径不在 `/memory/*` 下：报 `INVALID_PATH`，提示改用 `write_file`。
- 返回值：`write_file` 的字段原样透传（`operation: created | updated | replaced`、`version`、`replacedVersion`、`staleReadVersion`，仅带 `content` 时有），另加 `path`、`type`、`description`、`metadata: 'created' | 'updated'`。

已见账本的跨轮重建：workspace-files 的 `seenInResult` 也识别 `memory_save` 的结果。带 `content` 的结果含 `version`，视为一次写入；不带 `content` 的结果没有 `version`，不计入。工具 id 取自 `src/shared/plugins.ts`。

工具卡片显示路径、type、description 与操作结果，沿用现有紧凑卡片样式。

### 4.4 catalog

查询本用户的 `memory/user` 文件与当前 Project 的 `memory/project` 文件（未删除），LEFT JOIN `memories`。每个作用域按文件 `updated_at` 倒序，最多 200 条：

```
<memory-catalog>
Snapshot taken when this conversation started; memories saved since then are not listed.
<scope name="user">
- /memory/user/terse-replies.md (feedback) — 用户偏好简短回答
- /memory/user/notes.md — undescribed: give it a type and description with memory_save
</scope>
<scope name="project">
…
… and 12 more: list_files /memory/project
</scope>
</memory-catalog>
```

- 对话不属于 Project 时无 project 段；某作用域为空时该段写 `(empty)`。
- 面向模型的文字用英文，最终措辞在实现时定。

### 4.5 快照

插件自有表 `memory_snapshots`：

| 列 | 说明 |
|---|---|
| `conversation_id` | 主键，FK → `conversations.id`，ON DELETE CASCADE |
| `project_id` | 渲染时对话所属的 Project；**不设外键** |
| `text` | 渲染好的 catalog |
| `created_at` | 渲染时间 |

- 读取：存在且 `project_id` 与对话当前 Project 相同（同为 null 亦算）时原样使用。编辑首条消息、重新生成均不刷新。
- 初始化：无记录时渲染并 `INSERT … ON CONFLICT DO NOTHING`；记录的 `project_id` 不符时渲染并 `UPDATE … WHERE conversation_id = ? AND project_id IS <读到的旧值>`。两种情况都随后读回，使用实际持久化的值，并发时以先写入者为准。
- 换 Project（移入、移出、换一个）无需任何钩子：下一轮发现 `project_id` 不符即重新渲染。Project 变化本身已改变 Project 级 system prompt，缓存本就失效。`project_id` 不设外键正是为此：Project 被删除时对话的 `project_id` 置 null，而快照保留旧 id，二者不符即重新渲染；若级联置 null，已删 Project 的 catalog 会被当作仍然有效。
- 分叉：插件监听 `conversation/forked`，把源对话的快照复制给新对话。分叉复制了同一条消息路径，继承快照使其前缀保持一致。
- 本轮不生效时不注入；快照保留，重新生效后继续使用。
- 快照存在插件自己的表里，核心的 `conversations` 表与对话更新逻辑不感知记忆。

### 4.6 system 段

本轮生效时返回静态说明（英文），内容：

- 记忆是什么；`/memory/user` 跨所有对话、`/memory/project` 限当前 Project。
- 四种 type 的含义与各自适合记录的内容；不该记的内容（代码或文件里已有的、只与当前对话有关的、密钥）。
- 何时主动保存：用户表达偏好、纠正做法、给出长期背景时。
- 维护方式：新建用 `memory_save` 带 `content`；改正文先 `read_file` 再 `edit_file`；改描述用不带 `content` 的 `memory_save`；过时或错误的记忆用 `delete_file`；合并重复项。
- 首条消息中的 catalog 是对话开始时的快照；依据记忆行事前先读正文。

## 5. 首条用户消息注入（核心）

- `GenerationTurn` 新增 `preamble?: string`，与 `labeler` 相同，至多由一个插件设置。
- `BuildInput` 新增 `preamble: string | null`；`buildModelMessages` 将其作为首条用户消息的第一个 text part。快照已持久化，函数保持「同样输入 → 逐字节相同输出」。
- 记忆插件在 `generation/prepare` 中、本轮生效时：调用 `openMemoryMounts(turn.state)`，以 `memoryPreamble` 初始化或读取快照（§4.5），设置 `turn.preamble`。

## 6. 测试

unit：

- system 段渲染：同样输入两次输出逐字节相同；打乱注册顺序输出不变；返回 `undefined` 的插件不留痕迹；无用户 prompt 且无段时不产生 system 消息。
- catalog 渲染：未描述文件的标注；超过 200 条的溢出行；无 Project 时无 project 段；空作用域。
- `buildModelMessages`：preamble 落在首条用户消息最前，与中断提示（`pending`）共存时顺序正确。

worker：

- 路径与隔离：`/memory/project` 与 `/project` 同名文件互不干扰；用户级记忆在不同 Project 的对话中均可见；无 Project 时 `/memory/project` 报 `MOUNT_UNAVAILABLE`；`tenant-isolation` 覆盖 `memories` 与新挂载点。
- 门禁：未开放时 `/memory/*` 经工具与 `vfs:` 解析器（`read_file`、`analyze_file`）均不可达。
- 迁移：既有文件回填的 `mount` 正确。
- 回收站：删除的 `memory/user` 文件出现在回收站而非孤儿列表，可还原；「清空孤儿」不触及它。
- 预览：`/memory/project/a.html` 与 `/project/a.html` 并存时，预览打开的是前者。
- 生命周期：`memory_save` 新建、只改元信息、给二进制文件补描述；对不存在的文件只改元信息时报错；rename 后元信息随行；删除后隐藏、还原后重现、清除后级联删除。
- 并发：`memory_save` 写正文后、upsert 元信息前，另一写入推进了版本，返回 `METADATA_CONFLICT`，元信息不变。
- 已见账本：上一轮带 `content` 的 `memory_save` 之后，下一轮直接 `edit_file` 成功。
- 快照：首轮写入；另一对话新增记忆后，本对话下一轮的首条消息不变；并发初始化只持久化一份，两次生成使用同一值；换 Project 后重新生成；分叉继承。

## 7. 文档

更新 `docs/architecture.md`（插件 system 段、首条消息 preamble）、`docs/files.md`（`/memory` 挂载点、回收站与预览规则）、`README.md` 功能列表。

## 8. 记忆管理与分层开关

### 8.1 生效规则

两层记忆各自决定本轮是否开放，规则是同一个纯函数 `memoryScopes`（`src/plugins/memory/shared.ts`），hub 与 Worker 共用：

- 用户记忆 = 插件配置 `user_memory` ∧（对话在 Project 中时）该 Project 的 `use_user_memory` ∧ 会话的 `user_memory`。
- 项目记忆 = 对话属于 Project ∧ 该 Project 的 `project_memory` ∧ 会话的 `project_memory`。
- 所有开关默认开启。

关闭的一层对模型完全不可见：对应挂载点不开放，不进 catalog，`memory_save` 写入它报 `MOUNT_UNAVAILABLE`。catalog 对关闭的层写一行说明（如 `User memory is off in this conversation.`）代替条目，模型不会再去尝试；两层都关时 catalog 仍注入，只含这两行说明。system 段只由工具集决定，不受开关影响。彻底不用记忆的方式是在工具选择里取消「记忆」。

### 8.2 开关存储

| 层级 | 存储 | 界面 |
|---|---|---|
| 用户记忆全局开关 | 记忆插件 `configSchema`：`{ user_memory: boolean = true }`，并在 `config` 中声明该字段 | 记忆数据页顶部；插件配置页同样可改（同一个值） |
| 项目开关 | **新增** `projects.plugin_settings`（JSON，按插件 id 分键）与 manifest 的 `projectConfigSchema`；记忆插件声明 `{ project_memory: boolean = true, use_user_memory: boolean = true }` | Project 设置页的「记忆」标签 |
| 会话开关 | 现有 `conversationConfigSchema`：`{ user_memory: boolean = true, project_memory: boolean = true }`，并声明 `conversationConfig` 字段 | 会话设置（现有渲染；无法按上层状态隐藏，标签注明需上层同时开启） |

Project 级插件设置照会话级的做法实现：

- `projects` 新增列 `plugin_settings TEXT`（JSON，可空）。
- `src/shared/plugins.ts` 新增 `projectConfigOf(manifest, settings)`（套默认值）与 `parseProjectPluginSettings`（拒绝未声明 `projectConfigSchema` 的插件）。
- WS 命令 `project.update` 新增可选字段 `plugin_settings`，hub 按插件 id 合并进现有值，与 `conversation.update` 相同。
- 未来其他插件同样可用；本次只有记忆插件声明。

### 8.3 服务端

- 记忆插件在 `generation/prepare` 中读取插件配置（注入 `pluginConfig`）、对话与 Project 行的 `plugin_settings`，用 `memoryScopes` 得出 `{ user, project }`。
- `WorkspaceScope.memory` 由 `boolean` 改为 `{ user: boolean, project: boolean }`；`openMemoryMounts(state, scopes)` 按层开放，`scopeOf` 按层判断。
- 快照表 `memory_snapshots` 新增列 `scopes TEXT NOT NULL`（如 `user,project`、`user`、空串）。读取时 `project_id` 与 `scopes` 都相同才复用，否则按 §4.5 的条件写入重新渲染。开关变化是用户操作，带来一次缓存失效。
- Worker 侧文件面板（`/conversations/:id/files` 的 `memoryFiles`）按同一 `memoryScopes` 分别返回两组，关闭的层不返回。
- 新增只读接口（Worker，`ctx.pluginApi.register`）：
  - `GET /api/plugins/memory/memories` → 用户记忆列表；
  - `GET /api/plugins/memory/projects/:id/memories` → 该 Project 的项目记忆列表（先校验 Project 归属）。
  - 每项：`{ fileId, path, name, type, description, updatedAt }`，`name` 为文件名去掉扩展名；按 `updatedAt` 倒序。
  - 管理接口不受开关影响：开关关闭时已有记忆仍可查看、删除。
- 查看正文、删除复用 workspace 现有的 `GET /files/:id` 与 `DELETE /files/:id`（删除进回收站）。

### 8.4 管理界面

列表与详情共用一个组件 `memory-browser.vue`：

- 列表按 type 分组：关于你（user）、做事方式（feedback）、项目背景（project）、参考（reference），未描述的文件单列一组；组内每行为名称、description、相对更新时间。
- 点开进入详情视图（带返回）：名称、最后更新时间、摘要（description）、正文（Markdown 渲染，沿用 `workspace-file-preview.vue` 的 `MarkdownRender` 用法）、删除按钮（确认后进回收站）。
- 底部输入框「告诉模型要记住、修改或忘记什么」：提交后新开一个会话执行（§8.5）。
- 不提供手工新建与编辑。

两处入口：

- **用户记忆**：记忆插件声明 `settingsEntry`，数据页（`/settings/plugins/memory/data`）顶部为「用户记忆」开关，下方为 `memory-browser`（scope=user）。
- **项目记忆**：新增 manifest 字段 `projectTab: { label }` 与客户端挂载位 `projectPanel`（照 `settingsPanel` 实现：`ClientPluginContext.projectPanel.register`、`ensureProjectPanel`），`project-settings.vue` 为声明了 `projectTab` 且已启用的插件各加一个标签页并挂载其组件（props：`pluginId`、`projectId`）。记忆插件的标签页含「项目记忆」「在本项目中使用用户记忆」两个开关（后者旁附用户记忆页链接）、`memory-browser`（scope=project）与输入框。开关通过 `project.update` 的 `plugin_settings` 保存。

### 8.5 从管理页开会话

- 输入框提交后跳转到新会话页（用户记忆：`/new`；项目记忆：`/project/:id/new`），经 router history state 传入 `{ prompt, tools }`；`chat.vue` 在挂载时消费一次：工具选择设为记忆插件的工具（服务端照常补齐 `requires` 级联），立即按普通发送流程发出 `prompt`，其余（模型选择、跳转到新会话）沿用现有逻辑。
- `prompt` 原样发送，不加任何要求更新记忆的包装：模型按 system 段的标准自行判断，用户的话不涉及记忆时可以什么都不改。
- 刷新或直接打开该地址时 history state 为空，页面就是普通的新会话。

### 8.6 测试

unit：

- `memoryScopes` 的真值表：全局、Project 两个开关、会话两个开关与有无 Project 的组合。
- `parseProjectPluginSettings` 拒绝未声明 schema 的插件；`projectConfigOf` 套默认值。

worker：

- 关闭用户记忆的轮次：`/memory/user` 经工具与 `vfs:` 均不可达，catalog 只有说明行，`memory_save` 写入报 `MOUNT_UNAVAILABLE`；项目记忆不受影响。
- 开关组合变化后下一轮重新渲染快照，组合不变则复用。
- `project.update` 的 `plugin_settings` 按插件 id 合并、拒绝未声明的插件。
- 记忆列表接口：只返回本人的、指定 Project 的记忆；他人的 Project 返回 404；开关关闭时仍可列出。
