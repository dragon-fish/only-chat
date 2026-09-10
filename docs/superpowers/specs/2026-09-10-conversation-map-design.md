# 对话分支地图设计

在一个全屏弹窗里把当前会话的完整消息树画成图：单击节点切换分支，双击节点关闭弹窗并定位到该消息。

## 范围

地图只做「看、切、跳」三件事。不在地图里删除消息、重命名、编辑或发起生成。

## 数据来源

`listMessages` 不按分支过滤，`sync.messages` 持有的是 `Map<conversationId, Map<messageId, Message>>` 的**完整树**，所有非活跃分支都已在客户端。地图不新增任何 API、WebSocket 命令或数据库改动。

当前活跃路径来自 `sync.pathFor(conversationId)`。

## 数据流

```
sync.messages.get(cid)
      │
      ├─ 结构指纹（所有消息的 id + parent_id + seq 排序拼接）──┐
      │                                                        │ 指纹变化才重算
      └─ buildGraph() → 节点/边纯数据 ──→ dagre 布局 ──────────┘
                                            │
                                       VueFlow nodes / edges
                                            │
                            <VueFlow> + <Controls> + <MiniMap>
```

**`node.data` 只放 `messageId`，绝不放消息内容。** 节点卡片组件用这个 id 自行从 store 取消息。这条是硬约束：消息对象在流式生成期间每个 token 都会变，一旦内容进了 `node.data`，每个 token 都会触发一次全量 dagre 布局。按此约定，token 更新只重渲染那一个卡片，布局完全不参与，也就不需要任何防抖。

结构指纹只由 `id`、`parent_id`、`seq` 构成，不含 `parts`、`status`、`usage`——同一个理由。

## 布局

dagre `rankdir: 'TB'`，用户消息在上、助手消息在下。

节点卡片**固定宽高**（约 240×96，摘要截断到 3 行并溢出省略）。固定尺寸让 dagre 无需测量 DOM，布局结果在内容变化时也不会跳动。

长会话全量渲染，不折叠单链。导航靠 minimap 与缩放；弹窗打开时 `fitView` 到当前路径末端。

## 交互

| 动作 | 行为 |
| --- | --- |
| 单击节点 | `switch_head(conversation_id, leafOf(节点))`。目标等于当前 head 时不发命令 |
| 双击节点 | 关闭弹窗，`scrollToMessage(String(messageId))` |
| 滚轮 / 双指缩放 / 拖拽 / minimap / 缩放控件 | VueFlow 自带 |
| 打开弹窗 | `fitView` 到当前路径末端 |

`sync.isStreaming(conversationId)` 为真时禁用单击切换。

`leafOf()` 从 `branch-switcher.vue` 提取到 `sync.ts`：单击节点与消息下方的 `‹ 1/2 ›` 箭头必须是同一个动作——切到目标所在分支后，沿最新子节点落到最深叶，不截断后续对话。两处共用同一实现是这个语义一致性的前提。

## 节点卡片

顶部 role 徽章与模型名，中部消息摘要，底部状态点与时间。

- 当前活跃路径的节点与边实色高亮，非活跃分支暗色显示。
- 状态区分 `done` / `streaming`（转圈）/ `error`（红）/ `aborted`（灰）。
- 助手消息若无 `text` part（纯工具调用），摘要位显示工具名。

## 依赖

| 包 | 版本 | 用途 |
| --- | --- | --- |
| `@vue-flow/core` | ^1.48.2 | 画布、pan/zoom、触屏手势 |
| `@vue-flow/controls` | ^1.1.3 | 缩放与 fitView 控件 |
| `@vue-flow/minimap` | ^1.5.4 | 缩略图 |
| `@dagrejs/dagre` | ^3.1.1 | 层次布局 |

布局包用 `@dagrejs/dagre`，不用已归档停更的 `dagre` 0.8.5。

VueFlow 的节点是绝对定位的 DOM 元素，只有边走 SVG，因此节点内可直接使用项目现有的卡片组件，文本可选中。

`@vue-flow/core` 依赖 `@vueuse/core ^10`，项目使用 `^14`，安装后会并存两份。

地图整体通过 `defineAsyncComponent(() => import(...))` 懒加载，未打开弹窗时不下载。

## 文件

| 文件 | 职责 |
| --- | --- |
| `src/client/components/conversation-map.ts` | 建树、结构指纹、dagre 布局。纯函数，不依赖 Vue |
| `src/client/components/conversation-map.vue` | VueFlow 容器，懒加载目标 |
| `src/client/components/conversation-map-node.vue` | 节点卡片 |
| `src/client/components/conversation-map-dialog.vue` | 弹窗外壳与头部入口按钮 |
| `src/client/stores/sync.ts` | 提取 `leafOf` |

入口按钮放在对话页头部工具栏，与模型选择器同一排。桌面端与移动端共用这一套。

## 测试

主力在 `conversation-map.ts` 的纯函数：

- 从消息 Map 建出正确的树，含多分叉与深层嵌套。
- **结构指纹对内容变化不敏感**：仅 `parts` / `status` / `usage` 变化时指纹不变。这条直接锁住上面的性能约定。
- 分叉布局的节点不重叠。

`leafOf` 提取到 store 后补单测：沿最新子节点走到最深叶。

VueFlow 依赖 `ResizeObserver` 与 `getBoundingClientRect`，在 happy-dom 下未必可用。组件级测试待实现时确认——若可行，补一条「单击节点发出正确 `switch_head`」的接线测试。

手工验证的样本用本地 mock 供应商造，不花钱也不依赖真实模型：`/parallel` 造分叉，`/error` 造失败节点，`/slow` 造仍在流式中的节点，`/reasoning` 造带思考过程的节点。地图要区分的四种状态由此都能凑齐。
