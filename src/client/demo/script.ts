import type { Conversation, Message, ModelListItem, ModelWithMetadata, Project, ProviderWithInterfaces, User } from '@/shared/models'
import type { ModelMetadata } from '@/shared/model-metadata'
import type { SiteConfig } from '@/shared/auth'
import { DATETIME_PLUGIN_ID, TAVILY_PLUGIN_ID, WEB_SEARCH_TOOL_ID } from '@/shared/plugins'
import type { TurnStep } from './stream'
import samplePhoto from './sample-photo.svg?url'

export const REPOSITORY_URL = 'https://github.com/dragon-fish/only-chat'
export const DEPLOY_URL = `https://deploy.workers.cloudflare.com/?url=${REPOSITORY_URL}`

const USER_ID = 2
export const PROVIDER_ID = 1
const INTERFACE_ID = 1
export const DEFAULT_MODEL_ID = 'demo-reasoning'
export const PROJECT_ID = 11
export const ATTACHMENT_CONVERSATION_ID = 101
export const TOUR_CONVERSATION_ID = 201
export const SKIP_CONVERSATION_ID = 202
const SAMPLE_ATTACHMENT_ID = 9001

/** Attachment ids the demo can show, mapped to images bundled with it. */
export const ATTACHMENT_URLS: Record<number, string> = { [SAMPLE_ATTACHMENT_ID]: samplePhoto }

export const TOUR_QUESTION = '这周末想去杭州玩两天，帮我查查天气，再排个轻松点的行程。'
export const ENDING_QUESTION = '我该怎么开始用？'

const HOUR = 3_600_000
const now = Date.now()

const createdAt = new Date(now - 30 * 24 * HOUR).toISOString()

/** What Better Auth's `get-session` returns for a signed-in, ordinary user. */
export const SESSION = {
  session: {
    id: 'demo-session', userId: String(USER_ID), token: 'demo', expiresAt: new Date(now + 24 * HOUR).toISOString(),
    createdAt, updatedAt: createdAt, ipAddress: null, userAgent: null,
  },
  user: {
    id: String(USER_ID), name: '演示用户', email: 'demo@only-chat.invalid', emailVerified: true, image: null,
    createdAt, updatedAt: createdAt, role: 'user', banned: false, banReason: null, banExpires: null,
  },
}

export const ME: User & { email: string; role: string } = {
  id: USER_ID,
  name: '演示用户',
  email: SESSION.user.email,
  role: 'user',
  settings: { plugins: { [TAVILY_PLUGIN_ID]: true, [DATETIME_PLUGIN_ID]: true } },
  plugin_config: {
    [TAVILY_PLUGIN_ID]: { configured: true, values: {}, secrets: { api_key: true } },
    [DATETIME_PLUGIN_ID]: { configured: true, values: {}, secrets: {} },
  },
  created_at: now - 30 * 24 * HOUR,
}

export const SITE_CONFIG: SiteConfig = {
  allowRegister: false,
  uploads: { maxBytes: 20 * 1024 * 1024, allowedMimeTypes: ['image/png', 'image/jpeg', 'image/webp'] },
}

export const PROVIDERS: ProviderWithInterfaces[] = [{
  id: PROVIDER_ID, user_id: USER_ID, name: '演示供应商', has_key: true, enabled: true,
  models_dev_provider_id: null, models_dev_provider_source: null, default_image_model_id: null,
  default_interface_id: INTERFACE_ID, credential_version: 1,
  interfaces: [{ id: INTERFACE_ID, provider_id: PROVIDER_ID, protocol: 'responses', native_files: true, base_url: 'https://mock.invalid/v1', created_at: now - 30 * 24 * HOUR }],
  created_at: now - 30 * 24 * HOUR,
}]

function metadata(name: string, reasoning: boolean): ModelMetadata {
  return {
    name,
    reasoning,
    ...(reasoning ? { reasoning_options: [{ type: 'effort' as const, values: ['low' as const, 'medium' as const, 'high' as const] }] } : {}),
    tool_call: true,
    attachment: true,
    modalities: { input: ['text', 'image'], output: ['text'] },
    limit: { context: 128_000, output: 8_192 },
  }
}

const MODEL_DEFS = [
  { id: 1, model_id: DEFAULT_MODEL_ID, name: '演示模型 · 深度思考', reasoning: true },
  { id: 2, model_id: 'demo-fast', name: '演示模型 · 快速', reasoning: false },
]

export const MODELS: ModelWithMetadata[] = MODEL_DEFS.map((def, sort) => ({
  id: def.id, provider_id: PROVIDER_ID, model_id: def.model_id, interface_id: INTERFACE_ID,
  metadata: metadata(def.name, def.reasoning), metadata_override: {}, image_extra_body: {},
  catalog_matches: { operator: null, lab: null, global: null }, lab_id: null,
  enabled: true, manual_pinned: false, upstream_available: true, sort,
}))

export const MODEL_LIST: ModelListItem[] = MODELS.map(model => ({
  id: model.id, provider_id: model.provider_id, model_id: model.model_id, interface_id: model.interface_id,
  metadata: {
    name: model.metadata.name, reasoning: model.metadata.reasoning, reasoning_options: model.metadata.reasoning_options,
    tool_call: model.metadata.tool_call, modalities: model.metadata.modalities, limit: model.metadata.limit,
  },
  image_extra_body: {}, lab_id: null, enabled: true, manual_pinned: false, upstream_available: true, sort: model.sort,
}))

export const PROJECTS: Project[] = [{
  id: PROJECT_ID, user_id: USER_ID, name: '旅行手账', icon_attachment_id: null,
  system_prompt: '你是一位细心的旅行规划师。回答先给结论，再列行程；节奏宽松，留出发呆的时间。',
  provider_id: null, model_id: null, params: null, plugin_settings: null,
  created_at: now - 20 * 24 * HOUR, updated_at: now - 2 * HOUR,
}]

function conversation(id: number, title: string, projectId: number | null, head: number, hoursAgo: number): Conversation {
  return {
    id, user_id: USER_ID, project_id: projectId, title, kind: 'chat', head_message_id: head,
    provider_id: null, model_id: null, system_prompt: null, params: null,
    tools: [WEB_SEARCH_TOOL_ID], tools_enabled: true, plugin_settings: null,
    created_at: now - hoursAgo * HOUR, updated_at: now - hoursAgo * HOUR, archived_at: null,
  }
}

function message(id: number, conversationId: number, parentId: number | null, role: Message['role'], parts: Message['parts'], hoursAgo: number): Message {
  return {
    id, conversation_id: conversationId, parent_id: parentId, seq: id, role, parts,
    provider_id: role === 'assistant' ? PROVIDER_ID : null, model_id: role === 'assistant' ? DEFAULT_MODEL_ID : null,
    usage: null, status: 'done', error: null, notes: null, created_at: now - hoursAgo * HOUR,
  }
}

export const CONVERSATIONS: Conversation[] = [
  conversation(ATTACHMENT_CONVERSATION_ID, '这是哪里的湖？', null, 1012, 5),
  conversation(102, '成都三日慢游', PROJECT_ID, 1022, 26),
  conversation(103, '出门前的行李清单', PROJECT_ID, 1032, 50),
]

export const MESSAGES: Message[] = [
  message(1011, ATTACHMENT_CONVERSATION_ID, null, 'user', [
    { type: 'image', attachment_id: SAMPLE_ATTACHMENT_ID, filename: '湖边日落.svg' },
    { type: 'text', text: '这张照片里的湖边日落太好看了，帮我找找国内类似风景的地方。' },
  ], 5),
  message(1012, ATTACHMENT_CONVERSATION_ID, 1011, 'assistant', [{ type: 'text', text: [
    '照片里是群山环抱的湖面，加上低角度的暖色夕阳，国内有几处很接近：',
    '',
    '1. **杭州西湖**：傍晚从断桥往雷峰塔方向看，山影和湖面的层次几乎一样。',
    '2. **大理洱海**：西岸看日落，苍山的轮廓更高更陡。',
    '3. **千岛湖**：岛多，前景更丰富，适合拍出层层叠叠的山。',
    '',
    '想拍出照片里的效果，建议日落前 40 分钟到位，用长焦把远山压近一些。',
  ].join('\n') }], 5),
  message(1021, 102, null, 'user', [{ type: 'text', text: '下个月去成都三天，不想赶景点。' }], 26),
  message(1022, 102, 1021, 'assistant', [{ type: 'text', text: '结论：三天只排三件事，其余时间交给茶馆和街边小吃。\n\n- **第一天**：人民公园喝茶，晚上玉林路散步。\n- **第二天**：上午熊猫基地，下午回城睡个午觉。\n- **第三天**：杜甫草堂，傍晚去望江楼看锦江。' }], 26),
  message(1031, 103, null, 'user', [{ type: 'text', text: '帮我列个周末短途的行李清单。' }], 50),
  message(1032, 103, 1031, 'assistant', [{ type: 'text', text: '结论：一个双肩包就够。\n\n- 证件、充电宝、数据线\n- 一套换洗衣物、薄外套\n- 折叠伞、防晒\n- 常用药和创可贴' }], 50),
]

const SEARCH_RESULTS = {
  query: '杭州 本周末 天气',
  results: [
    { title: '杭州本周末天气预报（示例数据）', url: 'https://example.com/weather/hangzhou', content: '周六多云转晴，18–25℃；周日晴，19–27℃，傍晚有微风。', score: 0.92 },
    { title: '杭州周末出行指南（示例数据）', url: 'https://example.com/guide/hangzhou-weekend', content: '西湖周边周末人流较大，建议早上 8 点前或傍晚游湖。', score: 0.81 },
  ],
  note: '演示模式：这是预置的搜索结果，没有真的联网。',
}

/** The first answer: thinks, searches, then plans. */
export const TOUR_ANSWER: TurnStep[] = [
  { kind: 'reasoning', durationMs: 2400, text: '用户想周末去杭州两天，要轻松的节奏。先查天气，决定哪天适合户外；再按“上午一个点、下午一个点、傍晚看湖”的密度排，避开人流高峰。' },
  { kind: 'tool', id: 'call_weather', name: WEB_SEARCH_TOOL_ID, args: { query: SEARCH_RESULTS.query }, content: SEARCH_RESULTS, runMs: 1200 },
  { kind: 'reasoning', durationMs: 900, text: '两天都不下雨，周日更晴，把最需要好天气的西湖骑行放在周日。' },
  { kind: 'text', text: [
    '好消息：周末两天都不下雨，周日更晴。行程按“慢”来排：',
    '',
    '**周六 · 多云转晴**',
    '- 上午：灵隐寺，早点去人少，山里很凉快',
    '- 下午：龙井村喝茶，顺着茶园小路走走',
    '- 傍晚：河坊街随便逛逛吃点小吃',
    '',
    '**周日 · 晴**',
    '- 早上 8 点前：环西湖骑行，从断桥到苏堤',
    '- 中午：湖边找家馆子，吃完歇一会儿',
    '- 傍晚：雷峰塔看日落，然后回程',
    '',
    '傍晚有微风，记得带件薄外套。',
  ].join('\n') },
]

/** The regenerated answer: a different take, so the two branches are easy to tell apart. */
export const TOUR_ALTERNATIVE: TurnStep[] = [
  { kind: 'reasoning', durationMs: 1600, text: '换个思路：不追景点，只围着西湖和城市街区慢慢走，更适合“轻松”这个要求。' },
  { kind: 'text', text: [
    '换个更松弛的版本：两天都不离开西湖太远。',
    '',
    '- **周六**：北山街散步 → 孤山喝咖啡 → 晚上南宋御街',
    '- **周日**：杨公堤骑车 → 茅家埠发呆 → 日落前到柳浪闻莺',
    '',
    '天气都不错，周日更适合骑车。',
  ].join('\n') },
]

export const ENDING_ANSWER: TurnStep[] = [
  { kind: 'text', text: [
    '演示就到这里。刚才这些——推理、联网搜索、分支、Project——都只是 Only Chat 的起点：核心只做聊天，其余能力按需开启，还能接上你自己的插件。',
    '',
    `- [部署你自己的 Only Chat](${DEPLOY_URL})：一键部署到你自己的 Cloudflare 账户`,
    `- [GitHub 源码](${REPOSITORY_URL})：开源，欢迎 Star 和 PR`,
    '- [重新开始演示](/demo/)',
  ].join('\n') },
]

export const USAGE = { prompt: 812, completion: 356, reasoning: 120, time_to_first_token_ms: 420, generation_duration_ms: 4800, total_duration_ms: 5200 }
