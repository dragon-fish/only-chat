<script setup lang="ts">
import { useId } from 'vue'
import { Input } from '@/client/ui/input'
import SearchableSelect from '@/client/components/searchable-select.vue'
import { Field, FieldGroup, FieldLabel } from '@/client/ui/field'
import { NativeSelect, NativeSelectOption } from '@/client/ui/native-select'
import { Switch } from '@/client/ui/switch'

defineProps<{ models: Array<{ key: string; label: string; description?: string }> }>()
const model = defineModel<string>('model', { required: true })
const count = defineModel<number>('count', { required: true })
const customSize = defineModel<boolean>('customSize', { required: true })
const width = defineModel<number>('width', { required: true })
const height = defineModel<number>('height', { required: true })
const quality = defineModel<string>('quality', { required: true })
const background = defineModel<string>('background', { required: true })
const outputFormat = defineModel<string>('outputFormat', { required: true })
const modelId = useId()
</script>

<template>
  <FieldGroup>
    <Field>
      <FieldLabel :for="modelId">模型</FieldLabel>
      <SearchableSelect
        :id="modelId"
        v-model="model"
        :options="models.map(item => ({ value: item.key, label: item.label, description: item.description }))"
        :placeholder="models.length ? '选择生图模型' : '没有可用的生图模型'"
        search-placeholder="搜索供应商、模型名称或 ID…"
        empty-text="没有匹配的生图模型"
        :disabled="!models.length"
      />
    </Field>
    <Field>
      <FieldLabel for="image-count">数量</FieldLabel>
      <Input id="image-count" v-model.number="count" type="number" min="1" max="10" class="min-h-10" />
    </Field>
    <Field orientation="horizontal">
      <FieldLabel for="image-custom-size">自定义尺寸</FieldLabel>
      <Switch id="image-custom-size" v-model="customSize" />
    </Field>
    <div v-if="customSize" class="grid grid-cols-2 gap-3">
      <Field>
        <FieldLabel for="image-width">宽度</FieldLabel>
        <Input id="image-width" v-model.number="width" type="number" min="1" class="min-h-10" />
      </Field>
      <Field>
        <FieldLabel for="image-height">高度</FieldLabel>
        <Input id="image-height" v-model.number="height" type="number" min="1" class="min-h-10" />
      </Field>
    </div>
    <Field>
      <FieldLabel for="image-quality">质量</FieldLabel>
      <Input id="image-quality" v-model="quality" list="image-quality-values" placeholder="自动" class="min-h-10" />
      <datalist id="image-quality-values"><option value="low" /><option value="medium" /><option value="high" /></datalist>
    </Field>
    <Field>
      <FieldLabel>背景</FieldLabel>
      <NativeSelect v-model="background" class="w-full">
        <NativeSelectOption value="">自动</NativeSelectOption>
        <NativeSelectOption value="transparent">透明</NativeSelectOption>
        <NativeSelectOption value="opaque">不透明</NativeSelectOption>
      </NativeSelect>
    </Field>
    <Field>
      <FieldLabel>输出格式</FieldLabel>
      <NativeSelect v-model="outputFormat" class="w-full">
        <NativeSelectOption value="">自动</NativeSelectOption>
        <NativeSelectOption value="png">PNG</NativeSelectOption>
        <NativeSelectOption value="webp">WebP</NativeSelectOption>
        <NativeSelectOption value="jpeg">JPEG</NativeSelectOption>
      </NativeSelect>
    </Field>
  </FieldGroup>
</template>
