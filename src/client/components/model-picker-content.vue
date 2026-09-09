<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from 'vue'
import { Settings2Icon } from '@lucide/vue'
import LabAvatar from '@/client/components/lab-avatar.vue'
import CollectionState from '@/client/components/collection-state.vue'
import ModelFilterMenu from '@/client/components/model-filter-menu.vue'
import ModelGroupList from '@/client/components/model-group-list.vue'
import { Button } from '@/client/ui/button'
import { Badge } from '@/client/ui/badge'
import { RouterLink } from 'vue-router'
import { filterModelEntries, modelBadges, modelName, sortModelEntries, type EnabledModelEntry } from '@/client/lib/ui-models'
import { useConfigStore } from '@/client/stores/config'
import { Command, CommandInput, CommandItem, CommandList } from '@/client/ui/command'
import type { ModelRef } from '@/shared/api'
import type { ModelQuery } from '@/shared/models'
import { isChatSelectableModel } from '@/client/lib/image-studio'

const props = defineProps<{ modelValue: ModelRef | null }>()
const emit = defineEmits<{ select: [ModelRef]; editProvider: [providerId: number] }>()
const config = useConfigStore()
const filters = ref<Partial<ModelQuery>>({})
const searchKey = ref(0)
const root = useTemplateRef<HTMLElement>('root')
const validationError = computed(() => {
  if (filters.value.min_context !== undefined && (!Number.isInteger(filters.value.min_context) || filters.value.min_context < 0)) return '最小上下文需要填写非负整数。'
  return null
})
async function loadModels() {
  if (validationError.value) { config.cancelPickerQuery(); return }
  try { await config.loadEnabledModelList() }
  catch { /* The store owns the error and retry state for the active query. */ }
}
onMounted(() => { void loadModels(); void config.loadCatalogProviders() })
let searchTimer: ReturnType<typeof setTimeout> | undefined
onBeforeUnmount(() => { config.cancelPickerQuery(); if (searchTimer) clearTimeout(searchTimer) })
const currentKey = computed(() => props.modelValue ? `${props.modelValue.provider_id}:${props.modelValue.model_id}` : '')
const filtered = computed(() => Object.values(filters.value).some(value => value !== undefined && value !== ''))
const entries = computed(() => validationError.value ? [] : sortModelEntries(filterModelEntries(
  config.enabledModels(!filtered.value && props.modelValue ? [props.modelValue] : []).filter(entry => isChatSelectableModel(entry.model)),
  filters.value,
), config.providers, 'provider'))
const keyFor = (entry: EnabledModelEntry) => `${entry.provider.id}:${entry.model.model_id}`
async function revealCurrent() {
  if (!currentKey.value || filtered.value) return
  await nextTick()
  root.value?.querySelector<HTMLElement>('[role="option"][data-state="checked"]')?.scrollIntoView({ block: 'nearest' })
}
watch([entries, currentKey], revealCurrent, { immediate: true, flush: 'post' })
function onSearch(event: Event) {
  if (searchTimer) clearTimeout(searchTimer)
  const value = (event.target as HTMLInputElement).value.trim()
  if (!value) filters.value = { ...filters.value, search: undefined }
  else searchTimer = setTimeout(() => { filters.value = { ...filters.value, search: value } }, 150)
}
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
.contents(ref="root")
  Command(:key="searchKey" :model-value="currentKey" :should-filter="false" class="min-h-0" @update:model-value="onSelect")
    .relative
      CommandInput(placeholder="搜索模型名称或 ID…" class="pr-10" @input="onSearch")
      .absolute.right-2.top-2.z-10
        ModelFilterMenu(:model-value="filters" :providers="config.providers" :search="false" :lab="false" :chips="false" @update:model-value="updateFilters")
    CommandList(class="max-h-[min(32rem,65vh)]")
      CollectionState(:loaded="config.loaded && config.pickerLoaded" :error="validationError ?? config.pickerError ?? config.loadError" :retry="loadModels" :empty="entries.length === 0" empty-title="没有可用模型" empty-description="当前筛选条件下没有已启用的模型。")
        template(#empty-action)
          Button(v-if="Object.keys(filters).length" variant="outline" class="min-h-10" @click="updateFilters({})") 清除筛选
          Button(v-else as-child variant="outline" class="min-h-10")
            RouterLink(to="/settings/providers") 配置模型
        ModelGroupList(
          :entries="entries" :catalog-providers="config.catalogProviders"
          command :show-labs="false" sticky-providers)
          template(#provider-actions="{ provider }")
            Button(type="button" variant="ghost" size="icon-sm" class="size-8" :aria-label="`设置供应商 ${provider.name}`" @click.stop="emit('editProvider', provider.id)")
              Settings2Icon
          template(#default="{ entry }")
            CommandItem(:value="keyFor(entry)" class="min-h-10 md:min-h-0")
              LabAvatar(:model-id="entry.model.model_id" :lab-id="entry.model.lab_id" :family="entry.model.metadata.family" :provider-name="entry.provider.name" size="sm")
              .min-w-0.flex-1
                p.truncate {{ modelName(entry.model) }}
                p.truncate.text-xs.text-muted-foreground {{ entry.model.model_id }}
                .mt-1.flex.flex-wrap.gap-1
                  Badge(v-for="badge in modelBadges(entry.model)" :key="badge.key" variant="secondary") {{ badge.label }}
              span.sr-only {{ entry.provider.name }}
</template>
