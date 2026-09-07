// @ts-ignore The Node-only SSR loader is excluded from the client DOM tsconfig.
import { createRequire } from 'node:module'
import { createSSRApp, defineComponent, h } from 'vue'
import { describe, expect, it } from 'vitest'
import { Command, CommandGroup, CommandItem, CommandList, useCommand } from '@/client/ui/command'
import { filterModelEntries, type EnabledModelEntry } from '@/client/lib/ui-models'

const requireFromVue = createRequire(import.meta.resolve('vue'))
const { renderToString } = requireFromVue('@vue/server-renderer') as {
  renderToString: (app: ReturnType<typeof createSSRApp>) => Promise<string>
}

const models: EnabledModelEntry[] = [{
  provider: { id: 1, user_id: 1, name: 'OpenAI', protocol: 'openai-responses', base_url: '', enabled: true, has_key: true, native_files: false, extra: null, created_at: 0 },
  model: { id: 1, provider_id: 1, model_id: 'gpt-5', display_name: 'GPT Five', capabilities: {}, pricing: null, enabled: true, sort: 0 },
}]

describe('Command with externally filtered rows', () => {
  it('keeps externally matched rows visible for a space-padded search', async () => {
    // A second search over raw text must not hide rows that the model filter retained.
    const query = ' gpt '
    const entries = filterModelEntries(models, query, 'all')
    expect(entries).toHaveLength(1)
    const Results = defineComponent({
      setup() {
        // This is the public context written by CommandInput; SSR has no interactive DOM input.
        useCommand().filterState.search = query
        return () => h(CommandList, null, () => h(CommandGroup, { heading: 'OpenAI' }, () =>
          entries.map(({ model }) => h(CommandItem, { value: model.model_id }, () => model.display_name))))
      },
    })
    const output = await renderToString(createSSRApp({
      setup: () => () => h(Command, { shouldFilter: false }, () => h(Results)),
    }))
    const group = output.match(/<[^>]*data-slot="command-group"[^>]*>/)?.[0]
    expect(group).toBeDefined()
    expect(group).not.toMatch(/\shidden(?:\s|=|>)/)
    expect(output).toContain('role="option"')
    expect(output).toContain('GPT Five')
  })
})
