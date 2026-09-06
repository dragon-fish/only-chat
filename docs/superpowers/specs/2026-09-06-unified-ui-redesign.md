# only-chat 统一 UI 重构设计

## 1. 背景与目标

当前客户端仍混合使用 MVP 手写布局、零散 shadcn-vue 控件和页面级 Tailwind 样式。它虽然已经具备聊天、Project、供应商与模型管理能力，但视觉层级、导航密度、移动端路径和暗色模式并不统一。

本轮直接重建客户端应用壳，不在旧页面上逐块换皮：以 shadcn-vue `dashboard-01` block 的 `SidebarProvider`、`Sidebar`、`SidebarInset` 和 header 组合为底盘，保留现有 Pinia、WebSocket、REST、路由语义与数据库结构，重新组织全部现有客户端界面。

本文取代 `2026-09-06-chat-shell-redesign.md` 的 UI 决策，并取代 `2026-09-06-projects-ui-reasoning-design.md` 中与页面布局和视觉组件有关的章节；后者的数据、同步、reasoning 和图片链路设计继续有效。

目标：

- 桌面端形成一致的动态侧栏与内容区；设置区允许三栏管理布局。
- 手机端使用稳定的底部全局导航，列表与详情逐级进入。
- 聊天、模型选择、Composer、Project、供应商与插件设置使用同一套 shadcn-vue 组件语言。
- 暗色模式成为一等主题，并提供跟随系统、浅色和深色三种选择。
- 不改变本轮之外的业务能力和服务端数据模型。

## 2. 范围

### 2.1 包含

- 用官方 `dashboard-01` block 的结构重建共享应用壳；只复用布局骨架，不引入示例图表、数据表等业务文件。
- 重做桌面主侧栏、Project 动态侧栏、设置导航与供应商列表栏。
- 增加手机底部导航、Project 列表页与设置逐级导航。
- 重做聊天顶栏、消息展示、模型选择器、Composer、会话设置与 reasoning 控件的组合关系。
- 重做 Project 设置、供应商列表与编辑、模型编辑、插件页、外观页、空状态、加载态和错误反馈。
- 增加主题选择和持久化。
- 增加客户端 Project 活跃排序与会话/Project/供应商/模型搜索。

### 2.2 不包含

- 不修改数据库、Worker API、WebSocket schema 或生成协议。
- 不增加 Agent 数据模型；Project 仅在 UI 上承担对话身份。
- 不增加供应商多端点、默认端点或单模型协议覆盖。
- 不增加 Project 自定义头像字段；本轮使用名称生成的确定性占位头像。
- 不自动推断模型能力、供应商品牌或模型协议。

下一轮单独设计供应商多端点：一个供应商可配置多种协议端点并指定默认端点，模型可覆盖默认端点。例如 ZenMux 的 Gemini 可改用 Vertex 兼容端点，DeepSeek 可在多种协议间切换。

## 3. shadcn-vue block 接入策略

采用“block 作为底盘”而非直接覆盖项目：

1. 使用项目包管理器通过官方 CLI 获取 `dashboard-01`，在隔离目录审阅 block 文件。
2. 提取 `AppSidebar`、`SiteHeader`、`SidebarProvider`、`SidebarInset` 的结构模式，映射到 only-chat 的路由和状态。
3. 不复制图表、数据表和示例数据；不保留无关 block 文件。
4. 已安装的 UI primitives 不直接覆盖。需要更新时先运行 CLI `--dry-run` 与 `--diff`，逐文件合并。
5. 新增或使用组件前查阅对应 shadcn-vue 官方文档；注册表组件通过 CLI 获取，不手工下载 GitHub raw 文件。

全局样式只使用 `src/client/style.css` 的语义 token。页面 class 只负责布局，不覆盖 shadcn-vue 组件的颜色和排版；不新增手写深色颜色分支。

## 4. 响应式应用骨架

### 4.1 桌面

共享结构为 `SidebarProvider → AppSidebar + SidebarInset`。顶栏与内容位于 `SidebarInset`，路由区域继续保持单一滚动所有者。

聊天相关路由使用一栏动态侧栏：

- 外层首页侧栏：新对话、全局搜索、最近活跃 Projects、随心聊会话、设置入口。
- Project 模式侧栏：返回外层、Project 名与切换、Project 内新对话、Project 搜索、Project 设置、该 Project 的会话。
- 进入 Project 后侧栏内容整体替换，不保留外层会话列表。

设置相关路由使用三栏：

1. 设置项导航：模型服务、插件、外观；顶部返回进入设置前的聊天界面。
2. 当前设置项的集合导航；模型服务中为供应商搜索和供应商列表。
3. 详情内容；模型服务中为供应商表单与模型列表。

模型等次级对象的编辑不增加第四栏，而是从右侧打开 `Sheet`。

### 4.2 手机

手机不渲染桌面侧栏。功能页底部固定三个全局入口：`聊天 / ＋ / 设置`。

- `聊天`：回到聊天首页。
- `＋`：始终开始无 Project 的“随心聊”，含义不随当前页面变化。
- `设置`：进入设置首页。
- Project 页面另有“Project 内新对话”按钮，继续沿用 `{ path: '/', query: { project: project.id } }` 的现有草稿语义。
- 进入具体聊天后隐藏底部导航，由 Composer 占据底部；返回来源列表后恢复导航。

移动端聊天首页使用 `/chats`，中央 `＋` 使用现有 `/` 无 Project 草稿路由，因此“查看列表”和“开始新会话”不会落在同一个 URL。桌面访问 `/chats` 时仍显示外层侧栏与一个引导选择/新建会话的空内容区。

聊天首页依次显示 Projects 和随心聊。Project 会话列表为独立页面。设置区把桌面三栏摊平成“设置项 → 供应商列表 → 供应商详情”三级页面。

桌面右侧 `Sheet` 在手机上转换为底部 `Drawer`，覆盖模型选择、模型编辑、会话设置和 Project 编辑等较长浮层。删除等短确认继续使用居中的 `AlertDialog`。

## 5. Projects 与随心聊

外层首页先显示 Projects，再显示随心聊。

- Projects 按活跃时间降序排列。活跃时间由客户端取 Project 自身 `updated_at` 与其所属会话最新 `updated_at` 的最大值，不要求服务端为了聊天活动额外写 Project。
- 主侧栏和手机聊天首页默认显示最近 5 个 Project。
- “查看全部”进入独立 Project 列表页；该页提供搜索、创建和进入 Project，不在窄侧栏中无限展开。
- “随心聊”是 `project_id = null` 会话的用户可见名称，不创建默认 Project 实体。
- 随心聊会话同样按 `updated_at` 降序排列。

搜索使用已经同步到 Pinia 的数据：外层搜索所有 Project 和会话；Project 内只搜索当前 Project 会话；设置区分别搜索供应商和模型。不增加服务端搜索接口。

## 6. 聊天体验

### 6.1 顶栏与身份

桌面聊天顶栏显示完整模型选择器和会话设置。reasoning 强度不在顶栏重复显示。

手机聊天顶栏显示：

- 返回按钮。
- Project 会话显示 Project 占位头像与 Project 名；随心聊显示固定标题“随心聊”。
- 模型入口压缩为模型占位图标与下拉箭头；无障碍名称和 Tooltip 提供完整模型名。
- 会话设置入口。

点击模型入口时，桌面打开 `Popover` 内的 `Command`，手机打开底部 `Drawer`。

助手消息身份与运行模型分离：

- Project 会话的助手头像和主名称使用 Project；实际模型作为次级信息。
- 随心聊没有 Project 身份，助手头像和名称直接使用实际模型。
- 顶栏模型选择始终代表运行配置，不被 Project 身份替代。

### 6.2 模型选择器

模型选择器由 `Command`、`Input`、`ToggleGroup`、`Item` 和 `Badge` 组合：

- 支持按供应商名、模型 ID 和显示名搜索。
- 支持全部、视觉、推理、工具和图片输出能力筛选。
- 按供应商分组；本轮没有可靠的收藏或常用记录来源，因此不增加“常用”分组。
- 能力徽章只读取现有 `capabilities`，不从模型名推断。
- 禁用或已删除模型不作为可选项；当前继承来源与恢复继承操作保持现有语义。

### 6.3 消息与 Composer

消息区使用现有 shadcn-vue `Message`、`Bubble`、`MessageScroller` 与 Markstream 渲染：

- 用户消息右对齐并使用轻量气泡。
- 助手消息保持开放正文布局，头像、身份和操作栏形成稳定层级。
- reasoning summary、图片、错误和中止状态保留现有数据行为，只更新组件表达。
- 消息操作使用 `Button` ghost/icon variants 与 `Tooltip`，不手写图标按钮。

Composer 继续使用 `InputGroup`、`Attachment`、`InputGroupTextarea` 与圆形发送/停止按钮：

- reasoning 强度只在 Composer 工具行出现。
- 输入、附件、上传状态、发送失败恢复与停止生成逻辑不变。
- 手机输入字号保持至少 16px，避免 iOS 聚焦缩放。

## 7. 设置体验

### 7.1 供应商

供应商详情只表达现有字段：名称、启用、协议、Base URL、API Key、原生 Files API、Vertex Project/Location（仅适用时）。表单使用 `FieldGroup`、`Field`、`Input`、`Select` 和 `Switch`。

模型列表使用 `Item`、`Badge`、`Switch` 和操作菜单。获取模型、手工添加、启停、删除和能力编辑保持现有 API 行为。模型编辑使用桌面 `Sheet` / 手机 `Drawer`，包含：

- 模型 ID 与显示名称。
- 启用状态。
- 视觉、推理、工具、图片输出、可关闭推理能力。
- 已声明的 reasoning 档位。

本轮不显示无法保存的“单模型协议”或“模型用途”控件。

### 7.2 Project、插件与外观

Project 设置与会话设置改用一致的 Field 与响应式 Sheet/Drawer 结构，继承、覆盖和恢复默认的业务语义不变。

插件页使用 `Item`、`Switch`、`Badge`、`Alert` 和 `Empty`。外观页提供跟随系统、浅色、深色三项 `ToggleGroup`，并预览当前语义色。

## 8. 主题

主题值为 `system | light | dark`，默认 `system`，保存在 `localStorage`。

- 在 Vue 挂载前读取主题并设置 `document.documentElement.classList`，避免首屏闪白。
- `system` 监听 `prefers-color-scheme`；显式浅色或深色时不响应系统变化。
- 更新选择后立即同步 DOM、持久化并更新 `color-scheme`。
- 所有页面使用 `background`、`foreground`、`card`、`popover`、`muted`、`accent`、`border`、`destructive`、`sidebar-*` 等语义 token。

## 9. 数据流与边界

现有 `useSyncStore` 和 `useConfigStore` 仍是唯一业务状态来源。新布局组件只消费派生的展示数据并发出现有命令，不复制服务端状态。

- Project 排序、列表截取和搜索实现为纯函数或纯 computed，便于定向测试。
- 新会话仍在发送第一条消息时创建；中央 `＋` 只导航到无 Project 草稿，Project 内按钮导航到带 `project` query 的草稿。
- 模型选择、会话更新、Project 更新与供应商更新继续沿用现有 API/WS 写入路径。
- 不把视觉状态写进服务端；Sidebar 折叠、主题和最近使用模型等客户端偏好保存在本地。

## 10. 加载、错误与无障碍

- 首次加载列表或详情使用 `Skeleton`。
- 空 Project、空会话、空供应商、空模型和无搜索结果使用 `Empty`。
- 可恢复的保存失败使用 Sonner toast；阻止整页工作的加载失败使用 `Alert`。
- 删除 Project、会话、供应商和模型使用 `AlertDialog`，不使用二次点击文字确认。
- 保留现有发送失败恢复机制与未连接提示。
- 所有 Sheet、Drawer、Dialog 均包含 Title；Avatar 均包含 Fallback；图标按钮均有可读名称和 Tooltip。
- 触摸操作目标不小于 40 CSS px；手机底部导航和 Drawer 考虑安全区 inset。
- 每个定高区域只有一个纵向滚动所有者，弹层内容超高时在弹层内部滚动。

## 11. 验证

自动验证：

- 为 Project 活跃时间、最近 5 个截取、各范围搜索和主题解析补定向单元测试。
- 运行相关测试文件、`pnpm typecheck` 和 `pnpm build`。
- 仅在合并或推送前运行全量套件；若全量套件实测只需数秒，可直接运行。

人工浏览器验收：

- 桌面：外层侧栏、Project 动态替换、设置三栏、模型 Popover、右侧 Sheet。
- 手机：底部导航、Project/随心聊列表、具体聊天 Composer、设置三级下钻、底部 Drawer。
- 浅色、深色与跟随系统；刷新后主题不闪烁且选择保持。
- 长 Project/会话/供应商/模型名称、空列表、长列表和窄屏滚动。
- 加载、断线、保存失败、删除确认、发送失败恢复和无可用模型。

人工验收只使用本地 dev server，不通过预览部署写入生产绑定。
