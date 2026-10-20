# Sandbox

给 Agent 一台能执行代码的 Linux 机器：装依赖、跑脚本、处理文件、clone 仓库、构建测试，产物经 vfs 交给用户。
它主要是 Agent 的能力，人类只通过工具卡片旁观。

本文是 [Browser Run spec](2026-09-14-browser-run-workspace-design.md) §Scope 里的第二个子项目，取代那里
"每个 Project 一台、R2 挂载、终端 tab、hydrate/publish"的设想。

**范围**：每用户一台容器、`sandbox_exec`（前台与后台）、`sandbox:` 文件引用、vfs 导入导出、按工作目录单元备份到 R2、
工具卡片。

**不做**：向用户索取密码的工具（需要授权的服务由 Agent 走 OAuth：给出授权链接，自己轮询拿到令牌）、网页终端、Sandbox 文件浏览与预览、端口预览、出站凭据注入、专用编辑工具、已删除单元的恢复界面、
托管版配额。各项的接入点见 §11。

## 1. 平台事实

本设计依赖以下事实（Cloudflare 文档 2026-10-13 版，`@cloudflare/sandbox` 1.0.1）：

- **SDK 1.0 不是 0.x 的升级**。没有 `getSandbox()` / `Sandbox` 类：自己写一个 Durable Object，经
  `this.ctx.container` 驱动容器。0.x 的 session、`startProcess`、代码解释器、`exposePort`、`terminal()` 均已移除。
  0.x 只维护到 2026-12-31，不采用。
- **容器 API**：`start({ image, instance, enableInternet, env, entrypoint })`、`running`、`destroy()`、
  `setInactivityTimeout(ms)`（最长 6 h）、`exec(argv, { stdin, stdout, stderr, cwd, env, pty, signal })`。`exec` 不经
  shell、没有超时；发起它的请求取消不会结束进程。
- **包内辅助**：`Files`（`readFile` 返回流式 Response、`writeFile`、`stat`、`readDirectory`、`mkdir`、`remove`）、
  `DirectoryBackup`。二者需要镜像里有 `sandbox-shim`（从 `cloudflare/sandbox:1.0.1` `COPY --from`），Worker
  需导出 `DirectoryBackupGateway`，compat date ≥ 2025-11-17（本项目 2026-09-05）。
- **`DirectoryBackup`**：`backup({ dir, exclude, gitignore })` → `{ id, dir, size, sha256, format: 'tar+zstd/1' }`，
  每次全量，对象存于 `<prefix><id>.tar.zst`，包内不保存索引；`restore(record, { dir })` 解压到旁边后原子替换并校验
  sha256，需要新旧两份的磁盘空间；目标目录内不能有挂载；同一容器同时只能有一个备份或恢复；备份期间写入会得到
  不一致的归档。
- **磁盘不持久**。容器停止即失去磁盘与进程。容器在其 DO 活跃时运行，之后按 inactivity timeout 停止；容器内的
  工作不算活跃，长任务要靠 alarm 维持。停止时平台不唤醒 DO，SIGTERM 宽限期不可依赖。官方模式是 DO 用 alarm
  检测空闲、先保存再 `destroy`。
- **部署**会重置 DO，不替换正在运行的容器。
- **调度策略**：容器要求 DO 类使用 `scheduling_policy: "durable_object"`（public beta），切换不可逆，连
  `wrangler rollback` 也撤不回。一个 DO 命名空间只能挂一个 Container 应用。
- **实例规格**在 `start()` 时选择：standard-1（1/2 vCPU、4 GiB、8 GB）到 standard-4（4 vCPU、12 GiB、20 GB）；
  `basic` 在该策略下不可用。计费按 10 ms：内存与磁盘按配置量，CPU 按实际用量。
- **隔离**：每个实例是一个 Firecracker microVM；容器内所有进程等同 root。
- **出网**：`enableInternet` 打开时 80/443 以外的端口不经拦截器。`interceptOutboundHttps` 可把指定主机的请求交给
  Worker 处理（§11 凭据注入的接入点）。
- **本地开发**：`wrangler dev` / `vite dev` 用 Docker 运行容器；需要 wrangler ≥ 4.141。`vite dev` 拉不到
  Cloudflare 仓库的镜像。`@cloudflare/vitest-pool-workers` 写死 `enableContainers: false`。
- **DO RPC**：消息上限 32 MiB，`ReadableStream` 可以流式越过；`AbortSignal` 不能经 RPC 传递。

## 2. 架构

```
浏览器 ──/ws──▶ UserHub (hub 根)
                 └─ sandbox 插件的工具 ──DO RPC──▶ Sandbox DO (每用户一个实例)
                                                    ├─ ctx.container (microVM)
                                                    ├─ DirectoryBackup ──▶ R2 BUCKET  sandbox-backups/
                                                    ├─ D1 sandbox_backups
                                                    └─ alarm: 空闲 / 检查点 / 后台任务
                                                         └─ 任务结束 ──RPC──▶ UserHub.settleTask
Worker scheduled ──▶ 清扫过期备份 (R2 BUCKET + D1)
```

### 2.1 Sandbox DO

新 DO 类 `Sandbox`，绑定 `SANDBOX`，按用户 id `getByName(String(userId))` 取实例，挂容器并启用
`durable_object` 调度策略。不能挂在 `UserHub` 上：调度策略切换不可逆，且会把 hub 的生命周期与容器绑死。

Sandbox DO 只理解三样东西：**单元**（§4）、**执行请求**、**备份记录**。它不知道对话、模型、vfs 或插件配置；
调用方在每次 RPC 里传入它需要的一切（单元、实例规格、空闲时长、通知回投所需的 id）。它不跑 cordis，
不加载任何插件。

Sandbox DO 只接受来自本 Worker 的 RPC，不暴露 `fetch`。每个 RPC 带 `userId`，与实例名不符即拒绝（同
`UserHub.settleTask` 的 `ensureOwner`）。

RPC 面（名称为示意，签名在 plan 中定稿）：

| 方法 | 作用 |
| --- | --- |
| `exec(req)` | 前台执行，返回输出流与结束信息（§6.1） |
| `kill(execId)` | 停止一次工具调用启动的命令（生成被停止时调用）：未启动的不再启动，前台的结束进程组，刚启动的后台任务一并停止 |
| `startJob(req)` | 后台执行（§6.2） |
| `readFile(unit, path)` / `stat(unit, path)` / `writeFile(unit, path, body)` | `sandbox:` 读取与导入（§7） |
| `dropUnit(unit)` | 运行中则删除该单元目录（§8.2） |

### 2.2 插件

`src/plugins/sandbox/`，惯常的 `manifest.ts` / `shared.ts` / `client/` / `server/` 布局。

- 工具与 `sandbox:` 方案在 **hub 根**注册；第一版没有 HTTP 路由，不需要 Worker 根的那一半。
- manifest：`requires: ['file_reader', 'workspace_files']`，服务端 `inject` 对应服务；默认关闭；**不**声明
  `requiresProject`，所有已持久化的对话都可用。
- 插件负责：对话 → 单元的映射、`sandbox:` 解析与附件化、导入导出、工具卡片的流式事件、清理事件。
- 何时用、哪些东西会保留、预装了什么、如何把产物交给用户，写在插件的系统提示段（`promptSections`，启用 sandbox 工具时出现）；
  工具描述只写各自的调用规则。
- 注册到三处列表：`src/shared/plugin-manifests.ts`、`src/client/plugins/loaders.ts`、`src/server/app.ts`。

## 3. 镜像

仓库根 `sandbox/Dockerfile`，`FROM debian:trixie-slim`。选 Debian：Python 预编译 wheel 依赖 glibc；模型最熟悉
apt 与 Debian 系的路径和报错；平台托管镜像与文档示例同为 Debian Trixie。不基于 Cloudflare 托管镜像，因为
`vite dev` 拉不到它。

工具链装在 `/opt` 与 `/usr/local`，**不进 HOME**：HOME 要备份，工具链放进去会让每次备份变成几百 MB。

| 组件 | 安装 |
| --- | --- |
| 系统包 | `git curl ca-certificates zip unzip jq ripgrep tmux procps less file build-essential` |
| uv | `/usr/local/bin/uv`；`UV_PYTHON_INSTALL_DIR=/opt/uv/python` |
| Python 3.12 | `uv python install 3.12 --default`，`python` / `python3` 指向它 |
| 默认 venv | `/opt/venv`，置于 PATH 最前；预装 numpy、pandas、matplotlib、requests、openpyxl、pillow、beautifulsoup4、lxml |
| Node 24 LTS | 官方二进制包，`/usr/local` |
| pnpm、bun | 官方安装方式，可执行文件放 `/usr/local/bin` |
| Playwright 1.63.0 | Python 包进 `/opt/venv`，npm 包全局安装；`--with-deps --only-shell chromium` 装无头 Chromium 到 `/opt/ms-playwright`（`PLAYWRIGHT_BROWSERS_PATH`），供模型自测在 sandbox 里起的网页。版本写在 `sandbox_exec` 的描述里，Node 项目用同一版本才复用这个浏览器 |
| `sandbox-shim` | `COPY --from=cloudflare/sandbox:1.0.1` |
| `job-run` | 本仓库的后台任务包装脚本（§6.2），放 `/opt/sandbox/bin` |

版本号在 Dockerfile 里写死。镜像里不能预先存在 `/workspace` 下的任何目录：`restore` 覆盖镜像自带的目录在本地开发中会以
`EXDEV` 失败，单元目录一律由 `ensureUnit` 创建。

环境变量（镜像级，`exec` 时再显式传入）：

```
HOME=/workspace/home
PATH=/opt/venv/bin:/workspace/home/.local/bin:/workspace/home/.bun/bin:/opt/sandbox/bin:/usr/local/bin:/usr/bin:/bin
UV_TOOL_DIR=/workspace/home/.local/share/uv/tools   UV_TOOL_BIN_DIR=/workspace/home/.local/bin
NPM_CONFIG_PREFIX=/workspace/home/.local            PNPM_HOME=/workspace/home/.local/bin
BUN_INSTALL=/workspace/home/.bun
UV_CACHE_DIR=/tmp/uv-cache  npm_config_cache=/tmp/npm-cache  pnpm_config_store_dir=/tmp/pnpm-store
BUN_INSTALL_CACHE_DIR=/tmp/bun-cache  UV_LINK_MODE=copy
```

包缓存放在 `/tmp`：放在 HOME 下会随每次 `user` 单元备份一起打包。Debian 的 `/etc/profile` 会覆盖 PATH，镜像用
`/etc/profile.d/00-sandbox-path.sh` 在 `bash -lc` 里补回。

于是：`uv pip install x` 装进 `/opt/venv`，关机即失；`uv tool install`、npm / pnpm / bun 的全局包落在 HOME，
随 `user` 单元持久。这条约定写进 `sandbox_exec` 的描述。

## 4. 单元与路径

**单元**是备份与恢复的最小粒度，各对应容器里的一个目录：

| 单元 | 目录 | 谁用 |
| --- | --- | --- |
| `user` | `/workspace/home` | HOME，所有对话共享 |
| `project:<id>` | `/workspace/projects/<id>` | 属于该 Project 的对话的默认工作目录 |
| `conversation:<id>` | `/workspace/conversations/<id>` | 不属于 Project 的对话的默认工作目录 |

- 对话属于哪个单元，由插件在**执行时**按对话当前的 `project_id` 推算。对话被移入或移出 Project 后，默认工作目录
  随之改变；旧单元里的文件留在原处，按 §8.2 的规则清理。
- 模型只看见容器里的绝对路径，不看见"单元"。容器是该用户独占的，模型可以访问任意路径。
- 任何路径参数（`cwd`、`sandbox:` 路径、导入目标）落在 `/workspace/projects/<id>` 或
  `/workspace/conversations/<id>` 下时，先确保该单元已恢复。单元 id 只用来查**当前用户**的备份记录：不存在的
  id 得到一个空目录。
- `/workspace` 下其他路径与容器内其他位置不属于任何单元，关机即失。`/workspace/.units/` 与
  `/workspace/.jobs/` 是 Sandbox DO 的内部目录。

## 5. 生命周期

### 5.1 开机与恢复

任何触及磁盘的 RPC 先执行 `ensureUnit(unit)`：

1. 容器未运行则 `start({ image, instance, enableInternet: true })`，`instance` 取调用方传入的规格；
   `setInactivityTimeout(30 min)` 仅作兜底，正常关机由 alarm 决定（§5.3）。开机后设置 alarm。
2. 先确保 `user` 单元，再确保目标单元。
3. 单元是否已恢复，以**容器内**的标记文件 `/workspace/.units/<kind>-<id>` 为准，不看 DO 内存：部署会重置 DO
   而不替换容器，凭内存判断会让 DO 再恢复一次，用旧备份盖掉之后的改动。
4. 未恢复时：查 D1 该单元最新一条未删除的备份记录；有则 `restore`，无则 `mkdir -p`；成功后写标记文件。
5. 当次恢复了某个单元时，`exec` 的结果附带一条说明：哪个目录从哪个时间的备份恢复，被排除的依赖目录
   （`node_modules`、`.venv` 等）需要重新安装。

同一单元的并发 `ensureUnit` 合并为一次。恢复、备份与执行的互斥见 §5.4。

### 5.2 活跃

Sandbox DO 记录：进行中的前台执行数、进行中的后台任务、最后一次活动时间。`exec`、`startJob`、`readFile`、
`writeFile` 的开始与结束都算活动。

### 5.3 alarm

容器运行期间每 60 s 一次：

1. **后台任务**：检查每个任务的退出文件（§6.2），已退出的投递通知。
2. **检查点**：距上次备份超过 15 min、存在脏单元、且没有进行中的前台执行时，备份脏单元。
3. **空闲关机**：没有进行中的前台执行与后台任务，且距最后一次活动超过 `idle_minutes` 时，备份脏单元，然后
   `destroy()`，不再设置 alarm。
4. 否则设置下一次 alarm。

DO 被重置后（部署、驱逐）的第一次 RPC 或 alarm 中，若发现容器仍在运行，就重新设置 alarm，并把所有带标记
文件的单元视为脏。inactivity timeout 只属于设置它的那个 DO 实例：构造函数里发现容器在运行就重新设置，否则重建后的 DO 一空闲，
平台就会停掉容器。

### 5.4 备份

- **脏单元**：本次开机以来，任何 `exec`、`startJob`、`writeFile` 之后，所有已恢复的单元都标为脏；备份成功后清除。
  不按路径追踪写入：命令可以写任何地方。
- `DirectoryBackup.backup({ dir, gitignore: true, exclude: ['node_modules/', '.venv/', '__pycache__/', '.cache/'] })`，
  前缀 `sandbox-backups/`，使用 `BUCKET`。
- 成功后在 D1 插入记录；每个单元只保留最新的两条未删除记录，更早的记录在新记录写入后删除其 R2 对象和行。
  这是内部轮换，不是删除用户的内容。
- **互斥**：Sandbox DO 内一把锁串行化恢复与备份。备份进行中到达的 `exec` 等待备份结束；检查点在有前台执行时跳过；
  空闲关机只在没有前台执行时发生。后台任务运行期间的检查点可能得到不一致的归档，由任务结束后的下一次备份覆盖。
- 备份失败：记录日志，不 `destroy`，下一次 alarm 重试；连续失败时保持容器运行而不是丢数据。

### 5.5 错误

- 恢复失败（对象不存在、sha256 不符、磁盘不足）不降级为空目录：该次 RPC 失败，错误写明单元与备份记录 id。
  第一版没有"重置单元"的操作。
- 开机失败：工具返回错误原文。
- 所有错误以工具错误的形式交给模型，不在服务端重试执行请求。

## 6. `sandbox_exec`

输入：

```ts
{
  command?: string      // 交给 bash -lc，可用管道、重定向、&&
  argv?: string[]       // 不经 shell 解析的参数数组
  stdin?: string        // 送入标准输入；写文件时与 ['tee', path] 搭配，内容不经任何转义
  cwd?: string          // 绝对路径；缺省为对话的单元目录
  timeout_ms?: number   // 前台：缺省 default_timeout_ms，上限 600000；后台忽略
  background?: boolean
}
```

- `command` 与 `argv` 必须恰有一个，否则返回参数错误。不用 `string | string[]` 联合：部分供应商的严格模式处理
  不好 `anyOf`。
- `argv` 实际执行 `bash -lc 'exec "$@"' -- <argv…>`：与 `command` 相同的 login 环境与 PATH，参数原样传入。
- `stdin` 上限 1 MiB；`command` 上限 32 KiB。后台执行不接受 `stdin`。
- 每次执行显式传入 §3 的环境变量。
- 进程以新会话启动（`setsid`），外面包 `timeout --kill-after=5s`，超时杀整个进程组。

### 6.1 前台

1. 插件推算单元与 `cwd`，经 RPC 调 `exec`，拿到输出流。
2. 输出边读边经 `hub.broadcastPlugin` 推给卡片（按 100 ms 合并），同时累计结果。
3. 结束后返回：

```json
{
  "exit_code": 0,
  "timed_out": false,
  "duration_ms": 1234,
  "stdout": "…",
  "stderr": "…",
  "truncated": false,
  "log_path": "/tmp/sandbox-logs/<tool_call_id>.log",
  "notes": ["/workspace/projects/3 restored from the backup of 2026-10-14 10:00 UTC; node_modules/ and .venv/ were not kept"]
}
```

- 每个流保留前 4 KiB 与后 16 KiB，中间以一行省略说明代替，`truncated: true`。完整输出（stdout、stderr 按到达顺序
  交错）始终写入 `log_path`，模型可以 `grep` 或 `sed -n`。日志在 `/tmp`，关机即失。
- 输出按 UTF-8 解码，非法字节替换；不做 ANSI 转义清理之外的处理。
- 生成被停止时，插件调用 `kill(execId)`：`AbortSignal` 不能经 RPC 传递。
- 工作目录不跨调用保留：每次都从 `cwd` 或默认目录开始。`command` 经 `eval` 执行后把最终 `pwd` 写到日志旁；
  与起点不同时结果附注说明下次从哪里开始，落在本次未恢复的单元里时再警告那里的写入不会保存。

### 6.2 后台

1. Sandbox DO 分配任务 id，经 `job-run` 启动：`job-run <dir> -- bash -lc …`。`job-run` 在 `<dir>`
   （`/workspace/.jobs/<id>/`）写 `pid`、把输出写入 `log`，进程结束后先写 `exit.tmp` 再改名为 `exit`。
2. 任务元数据存 DO storage：`task_id`（`sandbox_job:<id>`）、`conversation_id`、`origin_message_id`、
   `tool_call_id`、命令摘要、开始时间。
3. 工具立即返回：

```json
{ "task_id": "sandbox_job:7", "status": "started", "pid": 4321, "log_path": "/workspace/.jobs/7/log" }
```

4. alarm 发现 `exit` 后，经 `UserHub.settleTask` 投递通知：退出码、耗时、日志最后 4 KiB、日志路径；随后删除
   元数据。投递规则沿用 [后台任务 spec](2026-09-23-background-tasks-design.md) §2.4–2.5。
5. 容器不在运行而元数据仍在（容器被平台回收、开机失败），投递 `failed`，说明任务随容器一起结束。
6. 工具描述按后台任务 spec §2.2 要求写明：结果稍后以 `<task-notification>` 到达，不要轮询；需要中途查看时
   用 `tail` 读 `log_path`，需要结束时 `kill <pid>`。

## 7. 文件

### 7.1 `sandbox:` 引用

插件向 `fileReader` 注册 `sandbox` 方案，形式 `sandbox:/abs/path`，只在本轮启用了 sandbox 工具时生效。裸的
`/path` 归 workspace-files 解析，不是 sandbox 路径。解析时先确保路径所属单元，再 `stat`。

- **文本**（按扩展名与内容嗅探判定）：返回 `ResolvedText`，`read(range)` 用现有的逐行分页规则，内容经
  `Files.readFile` 取得。
- **二进制**：`fileReader` 要求二进制文件是附件。插件把字节写入 R2 成为附件（复用按 sha256 去重的入库路径），
  以 `asset:` 形式交给模型；同一内容只存一份。上限 `MAX_ATTACHMENT_BYTES`（20 MiB），超过时返回错误并建议
  先压缩或导出。这些附件被工具结果引用，不会被当作孤儿回收。
- 目录、不存在的路径、超限文件返回 `fileReader` 的既有错误类型。

这让能看图的模型直接看到自己用 matplotlib 画出的图，`analyze_file` 也能处理 sandbox 里的 PDF、音频。

### 7.2 `sandbox_import`

```ts
{ from: string /* 任何 fileReader 能解析的引用：vfs 路径、asset: */, to: string /* sandbox 绝对路径 */ }
```

经 `fileReader` 解析来源，文本取全文、二进制取附件字节，`Files.writeFile` 写入（自动建父目录，已存在则覆盖）。
返回 `{ to, size }`。

### 7.3 `sandbox_export`

```ts
{ from: string /* sandbox 绝对路径 */, to: string /* vfs 路径 */, expected_version?: number }
```

读出字节后按类型分两路，都带 conversation、message、tool call 来源：

- **文本**（扩展名是文本类型或内容是合法 UTF-8，且不超过 vfs 文本上限 1 MiB）：走 `write_file` 的同一路径
  （`writeWorkspaceFile`），遵守版本 CAS 与"不覆盖未读版本"的规则。
- **其余**：存为附件后经 `WorkspaceFiles.copy` 发布为二进制文件，上限 20 MiB（字节整块经 DO RPC 传递，单条
  消息上限 32 MiB）。`copy` 从不覆盖，所以二进制只能导出到空闲路径。

超限时返回错误，建议拆分或压缩。

导出的文件与 `write_file` 写入的文件同为普通 vfs 文件，只有来源不同。

## 8. 数据与清理

### 8.1 `sandbox_backups`（迁移 0028）

```
id            integer pk
user_id       integer not null  → users.id on delete cascade
unit_kind     text not null     'user' | 'project' | 'conversation'
unit_id       integer           null 当且仅当 unit_kind = 'user'（CHECK）；不设外键
backup_id     text not null     DirectoryBackupRecord.id
r2_key        text not null
sha256        text not null
size          integer not null
created_at    integer not null
deleted_at    integer
index (user_id, unit_kind, unit_id, created_at)
```

`unit_id` 不设外键：对话或 Project 被删除时由事件标记 `deleted_at`，不靠级联抹掉记录。

### 8.2 清理

- `conversation/before-purge`：该对话单元的备份记录标记 `deleted_at`；容器运行中则 `dropUnit` 删除目录与标记文件。
- `project/deleted`：同上，对 Project 单元。
- Worker `scheduled` 新增一步（与 `sweepTrash` 并列）：`deleted_at` 早于 30 天（`TRASH_RETENTION_MS`）的记录，用
  `BUCKET` 按 `r2_key` 删除对象，再删除行。
- 30 天内数据仍在 R2，但第一版没有恢复界面。

## 9. 配置

插件配置（用户级，经 `plugin-config`）：

| 键 | 取值 | 缺省 |
| --- | --- | --- |
| `instance_type` | `standard-1` … `standard-4` | `standard-1` |
| `idle_minutes` | 5–120 | 10 |
| `default_timeout_ms` | 1000–600000 | 120000 |

`instance_type` 在下一次开机时生效。

## 10. 部署与本地开发

- wrangler 升到 ≥ 4.141；新增 `@cloudflare/sandbox` 1.0.x。
- `wrangler.jsonc`：`containers: [{ class_name: 'Sandbox', scheduling_policy: 'durable_object', images: { sandbox: { dockerfile: './sandbox/Dockerfile' } } }]`、
  DO 绑定 `SANDBOX`、新的 DO migration tag（`new_sqlite_classes: ['Sandbox']`）。
- `src/server/index.ts` 导出 `Sandbox` 与 `DirectoryBackupGateway`。
- 远程 D1 迁移 0028 在推送 main 之前执行。
- **本地开发**：配置里有 `containers` 时，`vite dev` 与 `wrangler dev` 在没有 Docker 时直接启动失败。
  `vite.config.ts` 经 `cloudflare({ config })` 默认设 `dev.enable_containers: false`，环境变量
  `SANDBOX_DEV=1` 时才启用。容器关闭时 Sandbox DO 的 `ctx.container` 不存在，RPC 以明确的错误失败。
- **部署**：`wrangler deploy` 在本地构建并推送镜像，需要 Docker；Workers Builds 的构建环境支持 Dockerfile。
  非生产分支的 `wrangler versions upload` 不发布镜像。
- **套餐**：Containers 只在 Workers Paid 提供；`deployment.md` 写明部署需要 Workers Paid。
- **测试**：`@cloudflare/vitest-plugin` 固定关闭容器，worker 测试里 `ctx.container` 不存在（§12）。

## 11. 后续接入点

- **出站凭据注入**：`interceptOutboundHttps` 按主机交给 Worker 注入请求头；镜像信任
  `/etc/cloudflare/certs/cloudflare-containers-ca.crt`（git、npm、pip、uv）。
- **网页终端**：`exec({ pty })` 接 `tmux new -A`，非休眠 WebSocket 直连 Sandbox DO；客户端空闲断开复用 Browser Run
  的 `liveViewPhase`，Sandbox DO 侧另做服务端空闲断开。
- **文件浏览与预览**：Worker 根 REST 路由经 `Files` 列目录与流式下载；预览给 `PreviewTarget` 加 `sandbox` 变体。
  浏览不自动开机。
- **端口预览**：路径式 `/previews/<name>/` 或独立泛域名，经 `getTcpPort().fetch()` 转发。

## 12. 测试

worker 测试池不支持容器，按层拆分：

- **unit**（Node，手写的假 `ctx.container` 与假 `Files` / `DirectoryBackup`）：
  - 标记文件决定是否恢复；DO 重置后不重复恢复。
  - alarm：检查点在有前台执行时跳过；空闲关机先备份后 `destroy`；有后台任务时不关机。
  - 后台任务：`exit` 出现后投递一次；容器消失时投递 `failed`。
  - 备份轮换只保留两条；备份失败不 `destroy`。
  - `command` / `argv` 二选一；`argv` 包装不经 shell 解析。
  - 输出截断与 `log_path`。
- **worker**（Sandbox DO 的 RPC 以假对象替换）：
  - 单元推算：Project 对话、普通对话、移入 Project 后。
  - `sandbox:` 文本分页；二进制入库为附件且按 sha256 去重。
  - 导出走版本 CAS；导入接受 vfs 与 `asset:` 来源。
  - `conversation/before-purge` / `project/deleted` 标记 `deleted_at`；清扫只删 30 天前的。
  - `plugin-requirements.test.ts` 覆盖新插件。
- **手动**：本地 Docker 端到端（数据分析、clone 并构建一个仓库、后台任务通知、空闲关机后恢复、导出 zip）；
  部署后在生产上再走一遍（本地与线上在 root 权限、主机名上有差异）。

## 13. 文档

- `docs/architecture.md`：Sandbox DO、容器与单元。
- `docs/deployment.md`：Workers Paid、镜像构建、DO migration、远程迁移。
- `docs/development.md`：Docker 与本地开关。
- `docs/files.md`：`sandbox:` 引用与导入导出。
- `README.md`：功能列表。
