import type { Context } from 'cordis'
import { tool } from 'ai'
import { CURRENT_TIME_TOOL_ID, DATETIME_PLUGIN_ID } from '@/shared/plugins'
import { CurrentTimeInputSchema } from '../shared'
import { runCurrentTime } from './runner'

const DESCRIPTION = [
  'Returns the current date and time.',
  'Use when the request involves relative time such as today, now or recently, or when deciding whether something has already happened. Do not infer the current date from training data.',
  'Takes an IANA timezone name such as Asia/Shanghai; omitting it returns UTC. For several timezones, call once per timezone in parallel.',
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
