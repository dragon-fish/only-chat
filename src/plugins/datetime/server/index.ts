import type { Context } from 'cordis'
import { tool } from 'ai'
import { CURRENT_TIME_TOOL_ID, DATETIME_PLUGIN_ID } from '@/shared/plugins'
import { CurrentTimeInputSchema } from '../shared'
import { runCurrentTime } from './runner'

const DESCRIPTION = [
  '查询此刻的日期与时间。',
  '何时调：涉及"今天""现在""最近"等相对时间，或需要判断某件事是否已经发生。不要凭训练数据推测当前日期。',
  '可传 IANA 时区名（如 Asia/Shanghai）；省略则返回 UTC。需要多个时区时并行调用，一个时区一次。',
].join('\n')

export const DatetimeServerPlugin = {
  name: 'datetime',
  inject: ['tools'] as const,
  apply(ctx: Context) {
    ctx.tools.register(DATETIME_PLUGIN_ID, CURRENT_TIME_TOOL_ID, () => tool({
      description: DESCRIPTION,
      inputSchema: CurrentTimeInputSchema,
      execute: async input => runCurrentTime(input),
    }))
  },
}
