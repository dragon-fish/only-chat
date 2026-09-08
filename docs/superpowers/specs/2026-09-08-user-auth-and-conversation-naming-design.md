# 用户认证与 Conversation 命名设计

## 1. 目标

Only Chat 使用 Better Auth 建立简单的多用户系统，替代当前由 Cloudflare Access 保护、业务代码固定使用 `user_id = 1` 的 MVP 状态。

本次同时消除登录会话与聊天会话都叫 `session` 的歧义：登录会话统一称为 `AuthSession`，聊天会话统一改称 `Conversation`，包括 D1 物理表、HTTP API、WebSocket 协议、共享类型和客户端 Store。

## 2. 范围

包含：

- 邮箱与密码注册、登录、退出和修改密码。
- Better Auth 的 Cookie 会话、密码哈希、安全校验和限速。
- 每请求解析当前用户，所有业务数据按用户隔离。
- 每用户独立的 UserHub Durable Object。
- Better Auth Admin 提供的用户创建、角色调整、封禁、解禁和会话撤销能力。
- 注册开关及最小管理界面。
- 将聊天领域的 `Session` 完整改名为 `Conversation`。
- 通用的运维账号凭据重置脚本。

不包含：

- 邮件验证、邮件发送和自助找回密码。
- GitHub、Google、Passkey、Magic Link 等额外登录方式。
- 管理员查看或操作其他用户的 Conversation、Project、Provider、模型、附件或用户设置。
- 删除用户及其业务数据。
- 部署时移除 Cloudflare Access；该操作留到发布阶段处理。

## 3. Better Auth 集成

### 3.1 服务端

Better Auth 挂载在 `/api/auth/*`，使用现有 Hono、Drizzle 和 D1。Wrangler 已启用 `nodejs_compat`，满足 Better Auth 在 Cloudflare Workers 中对 `AsyncLocalStorage` 的要求。

Better Auth 负责：

- 邮箱密码注册和登录；
- scrypt 密码哈希与验证；
- AuthSession 创建、读取、过期和撤销；
- HttpOnly Cookie；
- CSRF、Origin 与回调地址校验；
- 认证端点限速；
- Admin 插件端点的授权。

Only Chat 提供一层薄 Hono 中间件。它调用 `auth.api.getSession()`，未登录时返回 `401`，成功时把结果写入 Hono context 的 `authSession`。业务授权从 `authSession.user` 取得 `authUser`，不自行解析 Cookie 或验证凭据。

Better Auth 路由、注册状态所需的公开站点设置和 SPA 静态资源公开。其他 `/api/*`、`/ws` 和附件下载均要求有效 AuthSession。

### 3.2 命名规则

- `authSession`：Better Auth 登录会话。
- `authUser`：当前登录用户。
- `authSessionId`：登录会话 ID。
- `AuthSession`、`AuthUser`：认证领域类型。
- `auth_sessions`：认证会话物理表。
- `conversation`、`Conversation`、`conversationId`：聊天领域名称。
- `conversations`：聊天物理表、Store 集合和 API 资源名。

认证代码不得使用裸 `session` 变量表达登录态。Better Auth 自身的 `getSession()` 方法和返回结构属于外部 API，不重命名；离开调用边界后立即使用上述名称。

## 4. 数据模型

### 4.1 Better Auth 表

现有 `users` 表扩展为 Better Auth 的用户表，保留自增整数主键和现有 `settings`。新增 Better Auth 核心字段及 Admin 插件字段。角色遵循框架的 `user` / `admin`，不移植 FlareDrive 未实际使用的数字等级 `2`。

新增并映射以下物理表，避免与聊天数据重名：

- `auth_accounts`
- `auth_sessions`
- `auth_verifications`

Better Auth 使用混合 ID 策略：`users.id` 由 D1 生成自增整数，认证附属表使用框架生成的字符串 ID。Only Chat 将框架 API 返回的用户 ID 视为字符串，进入业务层时必须通过一个统一转换函数校验并转换为正整数。

Admin 插件配置用户 ID `"1"` 为固定管理员。服务端所有管理员判定以 Admin 插件的有效权限为准，因此 `uid=1` 即使数据库角色字段异常也拥有管理员能力。管理操作不得封禁或降级 `uid=1`。

### 4.2 Conversation 改名

现有 `sessions` 物理表改名为 `conversations`，列 `messages.session_id` 改名为 `conversation_id`。相关外键、索引、Drizzle 导出、共享 DTO、HTTP 路由、WebSocket 命令与事件、Cordis 事件、客户端 Store、组件属性和测试夹具同步改名。

这是一次协调迁移：匹配的新 Worker 与 D1 migration 必须一起发布，旧 Worker 不支持迁移后的 schema。

## 5. 注册与账号规则

### 5.1 注册开关

`allowRegister` 按以下优先级解析：

1. D1 `site_settings` 中的显式值；
2. Worker 环境变量 `ALLOW_REGISTER`；
3. 默认值 `false`。

管理员可在后台写入数据库覆盖值，也可清除数据库值以恢复环境变量或默认值。首次注册不会自动修改注册开关。

注册关闭时，公开自助注册被拒绝，包括未来 OAuth Provider 的隐式注册；已有用户仍可使用已经绑定的身份登录，管理员仍可从后台创建用户。该策略覆盖 Better Auth 的全部公开身份入口，不只保护邮箱注册路由。

### 5.2 首位用户

新部署不再在应用启动时创建默认用户。空数据库开放注册后，第一个成功插入的用户自然获得 `uid=1`，并因固定管理员规则成为超管。后续注册始终插入新用户，不会补全或认领任何已有用户。

现有 MVP 数据库已经包含无认证凭据的 `uid=1`。普通注册不会认领它；如果开放注册，下一位用户获得 `uid=2+`。现有 `uid=1` 只能通过运维凭据重置脚本恢复登录能力。

### 5.3 账号能力

首版注册字段为名称、邮箱和密码。邮箱规范化后唯一，但不进行邮件验证。登录错误统一返回不区分账号是否存在的提示。

已登录用户可以修改名称和密码。修改密码时可撤销其他 AuthSession。首版不开放修改邮箱，避免在没有验证邮件的情况下改变账号标识。

## 6. 运维凭据重置脚本

仓库提供通用命令：

```text
pnpm auth:reset-user -- --userid <positive-integer> --local
pnpm auth:reset-user -- --userid <positive-integer> --remote
```

规则：

- `--userid` 必填，不隐式使用 `1`。
- `--local` 与 `--remote` 必须且只能指定一个。
- 操作前读取并显示目标环境、用户 ID 和当前邮箱，要求人工确认。
- 新邮箱、名称和密码以交互方式读取；密码不得出现在命令参数、输出或日志中。
- 删除目标用户已有的密码、OAuth、Passkey 等全部登录凭据。
- 写入新的邮箱密码 credential，并撤销该用户的全部 AuthSession。
- 保留用户 ID、角色、设置、Conversation、Project、Provider、模型和附件。
- 目标不存在、邮箱冲突、输入无效或任何数据库步骤失败时立即终止，不做部分成功的恢复。

脚本是数据库控制者的最终恢复入口，既用于现有 MVP `uid=1`，也用于其他失去全部登录方式的账号。未来新增认证方式时必须同步更新脚本清理的凭据表清单。

## 7. 请求与实时数据流

### 7.1 HTTP

受保护请求的数据流为：

```text
Browser Cookie
  -> Hono auth middleware
  -> Better Auth getSession
  -> authSession.user
  -> validated integer userId
  -> user-scoped query
```

所有 Provider、模型、Project、Conversation、消息、附件和用户设置查询必须显式接收 `userId`。仅凭资源 ID 查询后再比较所有者的写法应收束为带所有者条件的查询，资源不存在和资源不属于当前用户统一返回 `404`。

### 7.2 WebSocket 与 UserHub

Worker 在 `/ws` 升级前解析 AuthSession。认证失败时拒绝升级。认证成功后使用 `USER_HUB.getByName(String(userId))` 路由到该用户的 Durable Object，并用 Worker 覆盖写入的内部字段传递已验证用户 ID；客户端提供的同名字段不得透传。

每个 UserHub 实例固定服务一个用户。Hub 初始化后所有命令、快照、生成、设置和数据库操作使用该固定用户 ID，不再引用 `DEFAULT_USER_ID`。连接建立时若内部用户 ID 与实例已绑定 ID 不一致，应立即失败。

用户被封禁或 AuthSession 被撤销后，新连接必须失败。管理员执行封禁时还需通知对应 UserHub 关闭现有 WebSocket，避免已经升级的长连接继续操作。

## 8. 管理界面

### 8.1 路由

- `/login`：邮箱、密码和记住登录。
- `/register`：名称、邮箱和密码，仅在注册开放时提供入口。
- `/settings/account`：个人资料、修改密码、退出登录。
- `/admin/settings`：注册开关及其当前来源。
- `/admin/users`：用户列表、创建用户、调整角色、封禁和解禁。

客户端启动时先解析 AuthSession，加载期间不渲染受保护页面。未登录访问业务页面时跳转登录页并保留原目标地址，成功登录后返回。客户端路由守卫只负责体验，不能替代服务端授权。

侧栏现有账户占位替换为真实用户菜单。普通用户不显示管理入口；直接访问管理路由仍由服务端返回 `403`。

### 8.2 隐私边界

管理后台不提供用户数据浏览能力。管理员能够管理账号状态，但不能通过管理 API 查看其他用户的 Conversation、消息、Provider、模型、Project、附件或设置。

首版不提供删除用户。封禁会阻止新登录、撤销现有 AuthSession 并关闭在线 WebSocket，但不删除任何业务数据。解禁不会恢复已撤销会话，用户需重新登录。

## 9. 错误处理

- 无有效 AuthSession：HTTP 返回 `401`；WebSocket 拒绝升级。
- 已登录但权限不足：返回 `403`。
- 资源不属于当前用户：返回 `404`，不暴露资源存在性。
- 被封禁：撤销会话并要求重新认证；解禁后仍需重新登录。
- Better Auth 初始化配置、用户 ID 转换或 UserHub 身份绑定异常：fail fast，不回退到 `uid=1`。
- 不得在日志中记录密码、Cookie、AuthSession token、OAuth token 或 Provider API key。

## 10. 测试

只测试 Only Chat 的策略和集成边界，不重复测试 Better Auth 内部实现。

核心覆盖：

- 注册开关的 D1、环境变量和默认值优先级。
- 注册关闭时拒绝全部公开自助注册来源，已有用户仍可登录，管理员仍可创建用户。
- 空数据库首次注册获得 `uid=1` 和管理员能力。
- 已存在无凭据 `uid=1` 时，普通注册创建 `uid=2+`。
- `uid=1` 不能被封禁或降级。
- Hono 中间件的 `401`、认证成功和用户 ID 转换。
- 两个用户无法通过 REST、WebSocket、附件地址或猜测 ID 读写对方数据。
- 用户封禁后 AuthSession 撤销，现有 WebSocket 被关闭。
- 运维脚本重设全部凭据和 AuthSession，同时保持业务数据不变。
- 旧 `sessions` 数据迁移为 `conversations` 后，消息树、Project 归属和附件引用保持完整。
- 代码、协议和客户端状态中不存在聊天领域的遗留 `Session` 命名。

## 11. 后续扩展

GitHub 等 OAuth Provider 可通过 Better Auth `socialProviders` 加入，身份存入 `auth_accounts`。Passkey 可通过 `@better-auth/passkey` 与独立 `auth_passkeys` 表加入。新增方式必须复用统一注册策略：注册关闭时禁止创建用户，但允许已有用户通过已绑定身份登录。

Passkey 只作为附加登录方式。其 WebAuthn 凭据受 RP ID 约束；迁移到无关域名后，用户仍可通过密码或 OAuth 登录并重新绑定 Passkey。
