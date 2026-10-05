# 文件描述（第一期）

让工作区里的任何文件都能带一行描述，模型列目录时不打开文件就知道它是什么；记忆插件的描述改存在这里，不再用独立的 `memories` 表。

第一期范围：描述的存储、写入、展示，以及记忆插件改为读写它。`memory_save` 保留；去掉它属于第二期，另写 spec。

## 1. 数据模型

`workspace_files` 新增三列，挂在文件上，不随版本走：

| 列 | 说明 |
|---|---|
| `description` | 可空。单行，去掉首尾空白后 1–200 字符 |
| `description_sha256` | 可空。写下描述时文件内容的 SHA-256（取当前版本 attachment 的 `sha256`）；为空表示来源未知 |
| `description_updated_at` | 可空。最近一次写描述的时间 |

`description` 为空时另外两列也为空。三列只由服务端写入，模型和客户端都不能直接指定 `description_sha256`。

**是否过时**：描述存在，且 `description_sha256` 为空或不等于当前版本 attachment 的 `sha256`，即为过时（stale）。用内容哈希而不是版本号：写入相同字节不会误报，复制后版本号从 1 重新数也不受影响。过时只是标记，不清空描述——小改动之后旧描述多半仍然准确。

## 2. 写入（`WorkspaceFiles` 服务）

描述的每次写入都和它所依据的内容在同一个 D1 batch 里提交，或带版本比较并交换（CAS），不允许出现"描述记在了别人写的新内容上"。

- **`write` / `edit`**：输入新增可选 `description: string | null`。
  - 字符串：设为新描述，`description_sha256` 取本次写入内容的哈希。
  - `null`：清空三列。
  - 省略：三列不动；内容变了，描述随之变为过时。
  - 描述的更新并入 `commitVersion` 中推进 `current_version` 的那条 `UPDATE`，与版本插入同属一个 batch；比较并交换失败时描述也不写入。新建文件同样走 `commitVersion`。
- **`describe`（新增）**：`{ path, description: string | null, version }`，`version` 必填。在一条 `UPDATE … WHERE id = ? AND user_id = ? AND deleted_at IS NULL AND current_version = ?` 里写入，`description_sha256` 取该版本 attachment 的哈希；`changes = 0` 时，文件已不在则返回 `FILE_NOT_FOUND`，版本已推进则返回 `VERSION_CONFLICT`。文本和二进制文件都可以描述。
- **`rename`**：文件行不变，描述随行。
- **`copy`**：来源是工作区文件时，新文件复制来源的三列（哈希描述的是内容，复制后依然成立）；来源是 asset 时没有描述。
- **`restore`**：新文件只在来源文件的 `description_sha256` 等于被恢复版本的哈希时继承描述，否则没有描述。
- **`copyConversationFiles`（会话分叉）**：显式复制三列。
- **软删除 / 从回收站恢复**：行不变，描述保留。彻底删除随行消失。
- 描述不合法（多行、空串、超长）返回新错误码 `INVALID_DESCRIPTION`。

读取：`current`、`list`、`listRecords`、`listAll` 等返回文件记录的方法带上 `description` 和 `descriptionStale`（服务端联表算出，不落库）。

## 3. 工具

所有新增文字都放在工具结果里，工具描述保持静态（缓存前缀）。

- **`write_file`、`edit_file`**：输入新增可选 `description`（语义同 §2）。结果新增 `description: string | null` 与 `descriptionStale: boolean`。改动了一个有描述的文件、却没有同时给出新描述时，`message` 附一句：这个文件的描述是为之前的内容写的（附上描述原文），只有它不再概括这个文件时才用 `describe_file` 更新。
- **`describe_file`（新增，归 `workspace_files` 插件）**：输入 `{ path, description: string | null, version }`。工具描述说明：描述是一行概括，供以后列目录时判断要不要打开；`version` 填你据以写描述的那个版本，文件之后又变了会返回冲突，需要重新看过再写；`null` 删除描述。它不算读过文件，不写入 `read_file` 的已读记录。
  - 工具按插件分组解析，已有会话选过 `workspace_files` 的会自动获得这个工具，无需迁移选择。
- **`list_files`**：文件条目新增可选 `description`，过时时再加 `descriptionStale: true`。工具描述补一句说明这两个字段。
- **`read_file`**：文本读取结果和"未变化"回执都带上 `description` 与 `descriptionStale`（有描述时）。二进制文件以文件本身交付给模型，不附描述。

`ListFilesOutput`、`ReadFileOutput`、`ReadFileUnchangedOutput`、`WriteFileOutput` 是持久化的线格式，新字段只增不改，旧结果照常渲染。

## 4. 界面

- `FileRecord`（`src/shared/workspace-files.ts`）新增 `description: string | null` 与 `descriptionStale: boolean`。
- 文件面板在文件名下方显示描述，单行省略；过时时追加弱化文字"（内容已更新）"。
- 工具卡片：`describe_file` 显示为一行"已更新描述 <文件名>"及描述本身；`write_file` / `edit_file` 卡片不变。

用户在界面上编辑描述不在本期范围内。

## 5. 记忆插件

- **`memory_save`**：`content` 改为必填，内部调用带 `description` 的 `write`，描述与内容原子写入，`METADATA_CONFLICT` 分支随之删除。只改描述的模式取消，改由 `describe_file` 完成。
- **catalog 与提醒**：从 `workspace_files.description` 读描述，不再联表 `memories`。过时的描述行尾标注 `(description may be out of date)`；没有描述的文件提示 `undescribed: describe it with describe_file`。
- **`memory_state.known`**：`KnownMemoryFile` 新增 `descriptionStale: boolean`。`diffKnown` 在描述文字或过时状态变化时都算作更新，提醒里带上新的状态。
- **说明文字（`GUIDANCE`）**：维护方式改为——新建用 `memory_save`，补充或更正用 `edit_file`，描述不再贴切时用 `describe_file`；描述只放在文件描述里，不写进正文 frontmatter。
- **记忆管理页**：`api.ts` 的列表从 `workspace_files.description` 读描述。

## 6. 迁移

两次发布，各带一个迁移。每次都按部署守则在推送 `main` 前执行 `pnpm db:migrate:remote`。

**迁移 A（本期）**：

1. `workspace_files` 加三列。
2. 从 `memories` 回填：`description`、`description_updated_at` 照搬；`description_sha256` 只在 `memories.updated_at` 不早于当前版本的 `created_at` 时，取当前版本 attachment 的哈希，否则为空（来源未知，按过时显示）。
3. `memories` 表保留。本期代码不再读写它。

迁移 A 执行后、新代码部署前，旧 Worker 仍可能写入 `memories`，这部分由迁移 B 补齐。

**迁移 B（下一次发布）**：先把 `memories.updated_at` 晚于对应文件 `description_updated_at`（或后者为空）的行再搬一次，规则同上，然后删除 `memories` 表，并从 schema 中移除。

## 7. 测试

worker 测试覆盖：

- `describe`：版本不符返回 `VERSION_CONFLICT`；文件已删除返回 `FILE_NOT_FOUND`；不合法描述被拒绝；只能描述本人的文件（`tenant-isolation` 覆盖新列与新工具）。
- `write` / `edit` 带描述：与内容原子提交；比较并交换失败时描述未写入；省略时保留旧描述并变为过时；写入相同字节不变为过时；`null` 清空。
- 生命周期：改名保留；复制继承且不过时；从旧版本恢复只在哈希匹配时继承；会话分叉复制；回收站恢复保留。
- `list_files` / `read_file`（含"未变化"回执）返回描述与过时标记。
- 记忆：`memory_save` 原子写入描述；catalog 显示描述与过时标注；描述或过时状态变化在别的会话产生提醒。
- 迁移 A：回填规则——描述晚于当前版本时带哈希，早于时为空。

unit 测试覆盖描述校验与 catalog 渲染。

## 8. 不做

- 去掉 `memory_save`、记忆生效条件与说明文字的迁移：第二期。
- 描述之外的自由字段。
- 给 asset（上传或生成的图片）加描述：要描述先 `copy_file` 进工作区。
- 二进制文件读取时附带描述。
- 界面编辑描述。
- `absorbOwnChanges` 以最新行为准、可能吞掉同一路径上并发外部改动的问题：已有行为，`describe_file` 沿用它，不在本期修正。
