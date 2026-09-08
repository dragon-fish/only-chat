<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import { CircleHelpIcon, CircleXIcon } from '@lucide/vue'
import { Alert, AlertDescription, AlertTitle } from '@/client/ui/alert'
import { Button } from '@/client/ui/button'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/client/ui/card'
import {
  Questionnaire,
  QuestionnaireActions,
  QuestionnaireChoice,
  QuestionnaireChoiceDescription,
  QuestionnaireChoices,
  QuestionnaireDescription,
  QuestionnaireError,
  QuestionnaireInput,
  QuestionnaireItem,
  QuestionnaireNext,
  QuestionnairePrevious,
  QuestionnaireProgress,
  QuestionnaireSubmit,
  QuestionnaireTitle,
  type QuestionnaireItemDefinition,
} from '@/client/ui/questionnaire'
import type { ToolCallPart, ToolResultPart } from '@/shared/parts'
import { AskUserInputSchema, AskUserResultSchema, type AskUserResult } from '../shared'
import { buildAnsweredResult, initialAnswers } from './answers'

const props = defineProps<{
  call: ToolCallPart
  result: ToolResultPart | null
  canContinue: boolean
  busy?: boolean
}>()
const emit = defineEmits<{ respond: [result: AskUserResult]; continue: [] }>()
const questionnaire = ref<{ $el?: HTMLFormElement } | null>(null)
const parsedInput = computed(() => AskUserInputSchema.safeParse(props.call.args))
const input = computed(() => parsedInput.value.success ? parsedInput.value.data : null)
const answers = reactive(input.value ? initialAnswers(input.value) : {})
const otherAnswers = reactive<Record<string, string>>({})
const parsedResult = computed(() => props.result ? AskUserResultSchema.safeParse(props.result.content) : null)
const terminal = computed(() => parsedResult.value?.success ? parsedResult.value.data : null)
const definitions = computed<QuestionnaireItemDefinition[]>(() => input.value?.questions.map(question => ({
  name: question.id,
  required: true,
  ...(question.type === 'text' ? {} : { choices: question.options.map(option => ({ value: option.label })) }),
})) ?? [])

async function focusFirstAnswer() {
  await nextTick()
  questionnaire.value?.$el?.querySelector<HTMLElement>(
    'input:not([type=hidden]):not(:disabled), textarea:not(:disabled)',
  )?.focus()
}

onMounted(focusFirstAnswer)
watch(() => props.call.id, focusFirstAnswer)

function choiceChecked(questionId: string, label: string): boolean {
  const value = answers[questionId]
  return Array.isArray(value) ? value.includes(label) : value === label
}

function setChoice(questionId: string, label: string, multiple: boolean, checked: boolean) {
  if (!multiple) {
    if (checked) answers[questionId] = label
    return
  }
  const current = answers[questionId]
  const values = new Set(Array.isArray(current) ? current : [])
  if (checked) values.add(label)
  else values.delete(label)
  answers[questionId] = [...values]
}

function textAnswer(questionId: string): string {
  const value = answers[questionId]
  return typeof value === 'string' ? value : ''
}

function setTextAnswer(questionId: string, value: string) {
  answers[questionId] = value
}

function otherAnswer(questionId: string): string {
  return otherAnswers[questionId] ?? ''
}

function setOtherAnswer(questionId: string, value: string, multiple: boolean) {
  otherAnswers[questionId] = value
  if (!multiple) answers[questionId] = value
}

function submit(event: Event) {
  event.preventDefault()
  if (!input.value) return
  emit('respond', buildAnsweredResult(input.value, answers, otherAnswers))
}

function cancel() {
  emit('respond', { status: 'cancelled', message: '用户选择了取消回答' })
}

function answerLabel(questionId: string): string {
  if (terminal.value?.status !== 'answered') return ''
  const value = terminal.value.answers.find(answer => answer.id === questionId)?.value
  return Array.isArray(value) ? value.join('、') : (value ?? '')
}
</script>

<template lang="pug">
Alert(v-if="!parsedInput.success" variant="destructive")
  CircleXIcon
  AlertTitle 无法显示问题
  AlertDescription 工具参数格式不正确。
Alert(v-else-if="result && !parsedResult?.success" variant="destructive")
  CircleXIcon
  AlertTitle 无法显示工具结果
  AlertDescription 已保存的工具结果格式不正确。
Card(v-else-if="terminal" class="my-2 w-full")
  CardHeader
    CardTitle.flex.items-center.gap-2.text-sm
      CircleHelpIcon
      span {{ terminal.status === 'cancelled' ? '已取消回答' : '已回答' }}
  CardContent(v-if="terminal.status === 'answered'" class="flex flex-col gap-3")
    .flex.flex-col.gap-1(v-for="question in input?.questions" :key="question.id")
      span.text-xs.text-muted-foreground {{ question.header }}
      span.text-sm {{ answerLabel(question.id) }}
  CardContent(v-else class="text-sm text-muted-foreground") 用户取消了回答。
  CardFooter(v-if="terminal.status === 'answered' && canContinue" class="justify-end")
    Button(size="sm" :disabled="busy" @click="emit('continue')") 继续
Card(v-else class="my-2 w-full")
  CardHeader
    CardTitle.flex.items-center.gap-2.text-sm
      CircleHelpIcon
      span 需要你的回答
  CardContent
    Questionnaire(ref="questionnaire" :items="definitions" shortcuts="numbers" @submit="submit")
      QuestionnaireItem(
        v-for="question in input?.questions" :key="question.id" :name="question.id"
        :multiple="question.type === 'multiple'" required)
        QuestionnaireTitle {{ question.question }}
        QuestionnaireDescription(v-if="question.description") {{ question.description }}
        QuestionnaireChoices(v-if="question.type !== 'text'" class="mt-4")
          QuestionnaireChoice(
            v-for="option in question.options" :key="option.label" :value="option.label"
            :checked="choiceChecked(question.id, option.label)"
            @update:checked="setChoice(question.id, option.label, question.type === 'multiple', $event)")
            span {{ option.label }}
            QuestionnaireChoiceDescription(v-if="option.description") {{ option.description }}
          QuestionnaireInput(
            v-if="question.allowOther" :model-value="otherAnswer(question.id)" placeholder="其他…"
            @update:model-value="setOtherAnswer(question.id, $event, question.type === 'multiple')")
        QuestionnaireInput(
          v-else :model-value="textAnswer(question.id)" :placeholder="question.placeholder"
          class="mt-4" @update:model-value="setTextAnswer(question.id, $event)")
        QuestionnaireError 请填写当前问题。
      QuestionnaireActions(class="mt-4")
        QuestionnairePrevious(size="sm") 上一步
        QuestionnaireProgress
          template(#default="progress") {{ progress.current }} / {{ progress.total }}
        QuestionnaireNext(size="sm") 下一步
        QuestionnaireSubmit(size="sm" :disabled="busy") 提交
  CardFooter(class="justify-end")
    Button(variant="ghost" size="sm" :disabled="busy" @click="cancel") 取消回答
</template>
