// @ts-ignore The Node-only SSR loader is excluded from the client DOM tsconfig.
import { createRequire } from 'node:module'
import { createSSRApp, defineComponent, h } from 'vue'
import { describe, expect, it } from 'vitest'
import { Command, CommandGroup, CommandItem, CommandList, useCommand } from '@/client/ui/command'
import { type EnabledModelEntry } from '@/client/lib/ui-models'
import { modelRecords, provider } from './provider-fixtures'

const requireFromVue = createRequire(import.meta.resolve('vue'))
const { renderToString } = requireFromVue('@vue/server-renderer') as {
  renderToString: (app: ReturnType<typeof createSSRApp>) => Promise<string>
}

const models: EnabledModelEntry[] = [{
  provider,
  model: { ...modelRecords[0]!, model_id: 'gpt-5', metadata: { name: 'GPT Five' } },
}]

describe('Command with externally filtered rows', () => {
  it('keeps externally matched rows visible for a space-padded search', async () => {
    // A second search over raw text must not hide rows that the model filter retained.
    const query = ' gpt '
    const entries = models
    const Results = defineComponent({
      setup() {
        // This is the public context written by CommandInput; SSR has no interactive DOM input.
        useCommand().filterState.search = query
        return () => h(CommandList, null, () => h(CommandGroup, { heading: 'OpenAI' }, () =>
          entries.map(({ model }) => h(CommandItem, { value: model.model_id }, () => model.metadata.name))))
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
