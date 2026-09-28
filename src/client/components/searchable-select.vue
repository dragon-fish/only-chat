<script setup lang="ts">
import { computed } from 'vue'
import { CheckIcon, ChevronsUpDownIcon } from '@lucide/vue'
import { Button } from '@/client/ui/button'
import {
  Combobox, ComboboxAnchor, ComboboxEmpty, ComboboxGroup, ComboboxInput,
  ComboboxItem, ComboboxItemIndicator, ComboboxList, ComboboxTrigger, ComboboxViewport,
} from '@/client/ui/combobox'

export interface SearchableSelectOption {
  value: string
  label: string
  description?: string
}

const props = withDefaults(defineProps<{
  options: SearchableSelectOption[]
  placeholder: string
  searchPlaceholder: string
  emptyText?: string
  disabled?: boolean
  id?: string
  ariaLabel?: string
}>(), { emptyText: '没有匹配的选项', disabled: false })
const model = defineModel<string>({ required: true })
const selected = computed(() => props.options.find(option => option.value === model.value))
const selectedOption = computed<SearchableSelectOption | undefined>({
  get: () => selected.value,
  set: option => { if (option) model.value = option.value },
})
const textValue = (option: SearchableSelectOption) => [option.label, option.description, option.value].filter(Boolean).join(' ')
</script>

<template>
  <Combobox v-model="selectedOption" by="value" :disabled="disabled">
    <ComboboxAnchor as-child>
      <ComboboxTrigger as-child :aria-label="ariaLabel ?? placeholder">
        <Button :id="id" type="button" variant="outline" class="min-h-10 w-full min-w-0 justify-between font-normal" :aria-label="ariaLabel ?? placeholder">
          <span class="truncate">{{ selected?.label ?? placeholder }}</span>
          <ChevronsUpDownIcon class="shrink-0 opacity-50" data-icon="inline-end" />
        </Button>
      </ComboboxTrigger>
    </ComboboxAnchor>
    <ComboboxList align="start">
      <ComboboxInput :placeholder="searchPlaceholder" />
      <ComboboxViewport>
        <ComboboxEmpty>{{ emptyText }}</ComboboxEmpty>
        <ComboboxGroup>
          <ComboboxItem
            v-for="option in options"
            :key="option.value"
            :value="option"
            :text-value="textValue(option)"
          >
            <span class="flex min-w-0 flex-1 items-center gap-2">
              <span class="min-w-0 truncate">{{ option.label }}</span>
              <span v-if="option.description" class="min-w-0 flex-1 truncate text-xs text-muted-foreground">{{ option.description }}</span>
              <!-- Extra per-option content after the description, e.g. capability icons. -->
              <slot name="option-extra" :option="option" />
            </span>
            <ComboboxItemIndicator><CheckIcon /></ComboboxItemIndicator>
          </ComboboxItem>
        </ComboboxGroup>
      </ComboboxViewport>
    </ComboboxList>
  </Combobox>
</template>
