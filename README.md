<div align="center">

<img src="public/logo/only-chat-indigo.svg" alt="only-chat" width="160"/>

only-chat — 跑在 Cloudflare Workers 上的个人 AI 聊天。

</div>

## Features / 特性

- **多家供应商**：OpenAI（Chat Completions / Responses）、Anthropic，以及 Vertex 兼容网关。一个供应商一把 key，可以挂多个接口。
- **多设备同步**：生成在服务端跑完，任何设备都能中途加入、断线重连，流式输出不中断。
- **Project**：给一组会话统一提示词、默认模型与参数，每轮实时继承，也能按会话单独覆盖。
- **树状消息**：编辑或重新生成会产生分支，随时切回去。
- **附件**：图片、PDF、音频、视频，以及文本与源代码（GBK 等其他编码会自动转成 UTF-8，并醒目提示）。
- **插件**：读取文件、工作区文件、文件理解、生成图片、联网搜索、浏览器、向用户提问……按会话选择开启。
- **ComfyUI**：连接你自己的 ComfyUI，模型可以查模型和节点、套用模板或直接提交工作流出图，图片进画廊并自动回到对话。
- **MCP**：接入任意远程 MCP 服务（Streamable HTTP / SSE），支持自定义请求头与 OAuth 授权；模型按需查找服务和工具，接入再多也不占每轮的提示。
- **多用户**：注册、登录与账号管理，第一个注册的账号是管理员。

## Deploy / 部署

需要一个 Cloudflare 账号，以及 [Node.js](https://nodejs.org/) LTS 与 [pnpm](https://pnpm.io/)。

```bash
pnpm install

wrangler d1 create only-chat-db                  # 把 database_id 填进 wrangler.jsonc
wrangler r2 bucket create only-chat-attachments
wrangler kv namespace create KV                  # 把 id 填进 wrangler.jsonc 的 kv_namespaces
wrangler secret put KEY_ENCRYPTION_SECRET
wrangler secret put BETTER_AUTH_SECRET

pnpm db:migrate:remote
pnpm deploy
```

同时把 `wrangler.jsonc` 里的 `routes` 改成你自己的域名。

**第一个账号**：注册默认关闭。部署时临时把 `ALLOW_REGISTER` 设为 `true`，注册的第一个账号就是管理员（`uid=1`），之后立刻关掉注册（也可以在 `/admin/settings` 里关）。

**更新**：拉取代码后，如果 `migrations/` 里有新文件，先 `pnpm db:migrate:remote` 再 `pnpm deploy`。未迁移的数据库配上新代码会直接无法工作。

更多细节（Cloudflare Access、所有者审计、从旧版本升级、找回账号）见 [部署文档](docs/deployment.md)。

## Configuration / 配置

| 名称 | 类型 | 说明 | 默认值 |
| --- | --- | --- | --- |
| `KEY_ENCRYPTION_SECRET` | secret | 加密存储的供应商 API key，至少 16 个字符。**部署后不要更换**，否则已存的 key 全部无法解密 | — |
| `BETTER_AUTH_SECRET` | secret | 登录会话的签名密钥，至少 32 个字符 | — |
| `ALLOW_REGISTER` | var | 是否开放注册；`/admin/settings` 中的设置优先 | `false` |
| `ENABLE_AUDIT` | var | 为管理员开启只读的全站审计页 | `false` |

站点的访问地址不需要配置，由请求本身决定。

## Development / 开发

```bash
cp .dev.vars.example .dev.vars   # 填好两个 secret
pnpm install
pnpm db:migrate:local            # 每次拉取到新迁移后都要跑
pnpm dev                         # http://localhost:7456
```

本地同样需要临时打开 `ALLOW_REGISTER` 注册第一个账号。不想花钱调用真实 API 时，`pnpm seed:mock` 会创建一个只在本地应答的模拟供应商，还能用指令模拟工具调用、推理和报错，见 [开发文档](docs/development.md)。

```bash
pnpm typecheck   # 类型检查
pnpm test        # 单元测试与 Worker 测试
```

## Docs / 文档

- [部署与升级](docs/deployment.md)
- [开发与模拟供应商](docs/development.md)
- [供应商、接口与模型元数据](docs/providers.md)
- [文件：上传、读取与工作区](docs/files.md)
- [架构、插件与目录结构](docs/architecture.md)
- 设计文档：[docs/superpowers/specs/](docs/superpowers/specs/)

## Known gaps / 已知限制

- 登录方式只有邮箱加密码：没有邮箱验证、找回密码、OAuth 或 Passkey。账号丢失时用 `pnpm auth:reset-user` 恢复。
- 上传用途由客户端声明：以项目图标的名义上传的图片可以被发进聊天，从而绕过聊天上传策略（仅限 20 MiB 以内的图片）。
- Anthropic 的模型列表只读取第一页。
