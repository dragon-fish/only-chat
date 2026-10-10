<script setup lang="ts">
import { computed, toRef } from 'vue'
import { createFormValidation, provideFormName, provideFormValidation } from '@openuidev/vue-lang'
import { RenderValue, type NodeProps } from '../runtime'

const { props, renderNode } = defineProps<NodeProps<{ name?: string, buttons?: unknown, fields?: unknown[] }>>()
provideFormName(toRef(() => props.name))
provideFormValidation(createFormValidation())
const fields = computed(() => (props.fields ?? []).filter(field => field != null))
</script>

<template lang="pug">
form.flex.min-w-0.flex-col.gap-4(@submit.prevent)
  RenderValue(v-for="(field, index) in fields" :key="index" :value="field" :render="renderNode")
  RenderValue(v-if="props.buttons" :value="props.buttons" :render="renderNode")
</template>
