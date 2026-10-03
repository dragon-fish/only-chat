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
  /** 本插件解析后的配置；无配置为 {}。 */
  config: Record<string, unknown>
}
type PromptSection = (input: PromptSectionInput) => string | undefined

ctx.promptSections.register(pluginId, section): () => void   // 随注册方插件生命周期释放
```

- `section` 是同步纯函数。输入只有决定工具集的那些量，拿不到用户、对话、时间或数据库，因此写不出不稳定的内容。
- 一个插件最多注册一段；重复注册抛错。
- 需要按对话或按轮变化的内容不得进 system 段，走用户消息（§5）或工具结果。

### 2.2 渲染

在 `generation.ts` 组装 `BeforeSendPayload` 之前计算最终 system prompt：

1. 用户自己的 system prompt（Project → 会话覆盖，现有逻辑）在最前。
2. 按 `pluginManifests` 的顺序遍历已注册的段，调用 `section(input)`；返回 `undefined` 或空串的插件不留任何痕迹。
3. 每段包为 `<plugin id="<pluginId>">\n…\n</plugin>`，段之间以一个空行分隔，接在用户 prompt 之后（同样空一行）。
4. 用户 prompt 为空且没有任何段时，不发 system 消息（现有行为）。

顺序只由 `pluginManifests` 决定，与 `ctx.parallel` 完成顺序、插件加载顺序、注册顺序无关。

### 2.3 缓存

system 段的输入与工具集相同，而工具定义在 Anthropic 缓存前缀中排在 system 之前：凡是会改变 system 段的变化，本来就已让缓存失效。system 段不引入新的失效维度。

## 3. 工作区挂载点 `/memory`

### 3.1 路径

- `/memory/user/<relative>`：归属用户，所有对话共享。
- `/memory/project/<relative>`：归属对话所在的 Project，与 `/project` 是两个互不相干的命名空间。
- `/memory` 本身是只含 `user`、`project` 两个子项的目录，不能直接存文件。
- `WORKSPACE_MOUNTS` 变为 `project | conversation | memory/user | memory/project`；路径解析与格式化支持两段式挂载点。
- 对话不属于 Project 时，`/memory/project` 报 `MOUNT_UNAVAILABLE`，与 `/project` 一致。
- 跨挂载点 `rename_file` 照常是移动，包括在 `/memory/*` 与其他挂载点之间。

### 3.2 存储

`workspace_files` 新增列 `mount TEXT NOT NULL`，取值 `project | conversation | memory_user | memory_project`。挂载点不再从 `project_id` / `conversation_id` 推断，`service.ts` 中 `scopeOf` / `whereScope` / 记录格式化改按 `mount`。

| mount | `project_id` | `conversation_id` |
|---|---|---|
| `project` | 有 | null |
| `conversation` | null | 有（回收站孤儿为 null） |
| `memory_user` | null | null |
| `memory_project` | 有 | null |

- 迁移回填：`project_id` 非空为 `project`，其余为 `conversation`。
- 唯一索引：`workspace_files_project_path_uq` 改为 `(project_id, mount, relative_path)`；新增 `(user_id, relative_path) WHERE deleted_at IS NULL AND mount = 'memory_user'`。
- Project 删除时 `memory_project` 文件随 `project_id` 级联；`detachConversationFiles` 只处理 `conversation`。

### 3.3 按轮开放

`/memory/*` 默认对模型不可用，使用时报 `MOUNT_UNAVAILABLE`。workspace-files 导出 `openMemoryMounts(state: Map<string, unknown>)`，记忆插件在 `generation/prepare` 中、本轮生效时调用；workspace 工具与 `list_files /` 只在本轮已开放时认这两个挂载点。依赖方向是记忆 → workspace，workspace 不引用记忆插件。

Worker 侧 REST 路由（文件面板）在用户开启 `memory` 插件开关时展示并允许操作 `/memory/*`。

## 4. 记忆插件

### 4.1 Manifest

- id `memory`，`requires: [workspace_files]`，工具 `memory_save`，无配置项。
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
| `write_file` / `copy_file` 在 `/memory` 下新建 | 无元信息，catalog 标为未描述（§4.4） |

### 4.3 `memory_save`

```ts
{
  path: string          // 必须位于 /memory/user/ 或 /memory/project/ 之下
  type: 'user' | 'feedback' | 'project' | 'reference'
  description: string   // 1–200 字符，单行
  content?: string      // 正文
}
```

- 带 `content`：按 `write_file` 的语义写正文（新建或整篇覆盖，覆盖不要求先读，保留旧版本），返回 `write_file` 的同名字段（`operation`、`version`、`replacedVersion`、`staleReadVersion`）；随后 upsert 元信息；并像 `write_file` 一样把新版本记入本轮已见账本，使随后的 `edit_file` 不报 `NOT_READ`。
- 不带 `content`：文件必须已存在（否则 `FILE_NOT_FOUND`），只 upsert 元信息。
- 路径不在 `/memory/*` 下：`INVALID_PATH`，提示改用 `write_file`。二进制文件：`BINARY_FILE`。
- 返回 `{ path, type, description, operation: 'created' | 'updated' | 'described', … }`。

工具卡片显示路径、type、description 与操作结果，沿用现有紧凑卡片样式。

### 4.4 catalog

查询本用户的 `memory_user` 文件与当前 Project 的 `memory_project` 文件（未删除），LEFT JOIN `memories`。每个作用域按文件 `updated_at` 倒序，最多 200 条：

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

- `conversations` 新增列 `memory_preamble TEXT`。本轮生效且该列为 null 时渲染 catalog 并写入；之后每轮原样使用，不再刷新。编辑首条消息、重新生成均不刷新。
- 本轮不生效时不注入（快照保留，重新生效后继续使用）。
- 这是「配置每轮从 Project 重算、不复制进对话行」的刻意例外：catalog 位于首条用户消息，变化会使整段对话的缓存前缀失效。

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
- 记忆插件在 `generation/prepare` 中、本轮生效时：调用 `openMemoryMounts(turn.state)`，读取或生成快照，设置 `turn.preamble`。

## 6. 测试

unit：

- system 段渲染：同样输入两次输出逐字节相同；打乱注册顺序输出不变；返回 `undefined` 的插件不留痕迹；无用户 prompt 无段时不产生 system 消息。
- catalog 渲染：未描述文件的标注；超过 200 条的溢出行；无 Project 时无 project 段；空作用域。
- `buildModelMessages`：preamble 落在首条用户消息最前，与中断提示（`pending`）共存时顺序正确。

worker：

- 路径与隔离：`/memory/project` 与 `/project` 同名文件互不干扰；用户级记忆跨不同 Project 的对话可见；无 Project 时 `/memory/project` 报 `MOUNT_UNAVAILABLE`；未开放时 `/memory/*` 不可用；`tenant-isolation` 覆盖 `memories` 与新挂载点。
- 迁移：既有文件回填的 `mount` 正确。
- 生命周期：`memory_save` 新建、只改元信息、对不存在文件只改元信息报错；rename 后元信息随行；删除隐藏、还原重现、清除级联。
- 快照：首轮写入；另一对话新增记忆后，本对话下一轮的首条消息不变。

## 7. 文档

更新 `docs/architecture.md`（插件 system 段、首条消息 preamble）、`docs/files.md`（`/memory` 挂载点）、`README.md` 功能列表。
