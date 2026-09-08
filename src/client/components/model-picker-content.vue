<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Settings2Icon } from '@lucide/vue'
import LabAvatar from '@/client/components/lab-avatar.vue'
import CollectionState from '@/client/components/collection-state.vue'
import ModelFilterBar from '@/client/components/model-filter-bar.vue'
import ModelGroupList from '@/client/components/model-group-list.vue'
import { Button } from '@/client/ui/button'
import { Badge } from '@/client/ui/badge'
import { RouterLink } from 'vue-router'
import { modelBadges, modelName, type EnabledModelEntry } from '@/client/lib/ui-models'
import { useConfigStore } from '@/client/stores/config'
import { Command, CommandInput, CommandItem, CommandList } from '@/client/ui/command'
import type { ModelRef } from '@/shared/api'
import type { ModelQuery } from '@/shared/models'

const props = defineProps<{ modelValue: ModelRef | null }>()
const emit = defineEmits<{ select: [ModelRef]; editProvider: [providerId: number] }>()
const config = useConfigStore()
const filters = ref<Partial<ModelQuery>>({})
const searchKey = ref(0)
const validationError = computed(() => {
  const search = filters.value.search?.trim()
  if (search && Array.from(search).length < 3) return '搜索模型至少需要 3 个字符。'
  if (filters.value.min_context !== undefined && (!Number.isInteger(filters.value.min_context) || filters.value.min_context < 0)) return '最小上下文需要填写非负整数。'
  return null
})
async function loadModels(append = false) {
  if (validationError.value) { config.cancelPickerQuery(); return }
  const search = filters.value.search?.trim()
  try { await config.loadEnabledModels(append, { ...filters.value, search: search || undefined }) }
  catch { /* The store owns the error and retry state for the active query. */ }
}
onMounted(() => { void loadModels(); void config.loadCatalogProviders() })
onBeforeUnmount(() => config.cancelPickerQuery())
watch(filters, () => { void loadModels() }, { deep: true })
const entries = computed(() => validationError.value ? [] : config.enabledModels())
const currentKey = computed(() => props.modelValue ? `${props.modelValue.provider_id}:${props.modelValue.model_id}` : '')
const keyFor = (entry: EnabledModelEntry) => `${entry.provider.id}:${entry.model.model_id}`
function onSearch(event: Event) { filters.value = { ...filters.value, search: (event.target as HTMLInputElement).value } }
function updateFilters(value: Partial<ModelQuery>) {
  if (!value.search && filters.value.search) searchKey.value++
  filters.value = value
}
function onSelect(value: unknown) {
  const entry = entries.value.find(candidate => keyFor(candidate) === value)
  if (entry) emit('select', { provider_id: entry.provider.id, model_id: entry.model.model_id })
}
</script>

<template lang="pug">
Command(:key="searchKey" :model-value="currentKey" :should-filter="false" class="min-h-0" @update:model-value="onSelect")
  CommandInput(placeholder="搜索模型名称或 ID…" @input="onSearch")
  .px-3.py-2
    ModelFilterBar(:model-value="filters" :providers="config.providers" :search="false" @update:model-value="updateFilters")
  CommandList(class="max-h-[min(32rem,65vh)]")
    CollectionState(:loaded="config.loaded && config.pickerLoaded" :error="validationError ?? config.pickerError ?? config.loadError" :retry="loadModels" :empty="entries.length === 0" empty-title="没有可用模型" empty-description="当前筛选条件下没有已启用的模型。")
      template(#empty-action)
        Button(v-if="Object.keys(filters).length" variant="outline" class="min-h-10" @click="updateFilters({})") 清除筛选
        Button(v-else as-child variant="outline" class="min-h-10")
          RouterLink(to="/settings/providers") 配置模型
      ModelGroupList(:entries="entries" :catalog-providers="config.catalogProviders" command)
        template(#provider-actions="{ provider }")
          Button(type="button" variant="ghost" size="icon-sm" class="size-8" :aria-label="`设置供应商 ${provider.name}`" @click.stop="emit('editProvider', provider.id)")
            Settings2Icon
        template(#default="{ entry }")
          CommandItem(:value="keyFor(entry)" class="min-h-10 md:min-h-0")
            LabAvatar(:lab-id="entry.model.lab_id" :provider-name="entry.provider.name" size="sm")
            .min-w-0.flex-1
              p.truncate {{ modelName(entry.model) }}
              p.truncate.text-xs.text-muted-foreground {{ entry.model.model_id }}
              .mt-1.flex.flex-wrap.gap-1
                Badge(v-for="badge in modelBadges(entry.model)" :key="badge.key" variant="secondary") {{ badge.label }}
            span.sr-only {{ entry.provider.name }}
  Button(v-if="config.pickerCursor && !validationError" variant="ghost" :disabled="config.pickerLoading" @click="loadModels(true)") 加载更多模型
</template>
