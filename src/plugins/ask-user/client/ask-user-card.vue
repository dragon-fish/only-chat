<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import { ChevronDownIcon, CircleHelpIcon, CircleXIcon, XIcon } from '@lucide/vue'
import { Alert, AlertDescription, AlertTitle } from '@/client/ui/alert'
import { Button } from '@/client/ui/button'
import { Card, CardAction, CardContent, CardFooter, CardHeader, CardTitle } from '@/client/ui/card'
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
  QuestionnaireSkip,
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
/**
 * Folded out of the way, for a questionnaire that is taller than the screen it is being read on.
 *
 * Deliberately local and unsaved: it is somewhere to put the question while looking at what is
 * above it, not an answer to it. A reload brings it back open, which is the right default for
 * something still waiting on a person.
 */
const collapsed = ref(false)
const parsedInput = computed(() => AskUserInputSchema.safeParse(props.call.args))
const input = computed(() => parsedInput.value.success ? parsedInput.value.data : null)
const answers = reactive(input.value ? initialAnswers(input.value) : {})
const otherAnswers = reactive<Record<string, string>>({})
const activeQuestionId = ref(input.value?.questions[0]?.id)

/** Anywhere on a folded card brings it back; the X has already stopped its own click. */
function expandOnClick() {
  if (collapsed.value) collapsed.value = false
}
/** The question being answered, so a folded card still says which one is waiting. */
const collapsedPreview = computed(() => {
  const questions = input.value?.questions ?? []
  const current = questions.find(question => question.id === activeQuestionId.value) ?? questions[0]
  return current?.question ?? null
})
const parsedResult = computed(() => props.result ? AskUserResultSchema.safeParse(props.result.content) : null)
const terminal = computed(() => parsedResult.value?.success ? parsedResult.value.data : null)
const terminalLabel = computed(() => {
  if (terminal.value?.status === 'cancelled') return '已取消回答'
  if (terminal.value?.status === 'invalid') return '问题未能提出'
  return '已回答'
})
const definitions = computed<QuestionnaireItemDefinition[]>(() => input.value?.questions.map(question => ({
  name: question.id,
  required: question.required,
  ...(question.type === 'text' ? {} : { choices: (question.options ?? []).map(option => ({ value: option.label })) }),
})) ?? [])

async function focusFirstAnswer() {
  await nextTick()
  questionnaire.value?.$el?.querySelector<HTMLElement>(
    'input:not([type=hidden]):not(:disabled), textarea:not(:disabled)',
  )?.focus()
}

onMounted(focusFirstAnswer)
watch(() => props.call.id, focusFirstAnswer)
watch(() => props.call.id, () => {
  for (const key of Object.keys(answers)) delete answers[key]
  for (const key of Object.keys(otherAnswers)) delete otherAnswers[key]
  if (input.value) Object.assign(answers, initialAnswers(input.value))
  activeQuestionId.value = input.value?.questions[0]?.id
})

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

function skipCurrentQuestion() {
  const id = activeQuestionId.value
  if (!id) return
  const question = input.value?.questions.find(candidate => candidate.id === id)
  if (!question) return
  answers[id] = question.type === 'multiple' ? [] : ''
  delete otherAnswers[id]
}

function submit(event: Event) {
  event.preventDefault()
  if (!input.value) return
  emit('respond', buildAnsweredResult(input.value, answers, otherAnswers))
}

function cancel() {
  emit('respond', { status: 'cancelled', message: '用户选择了取消回答' })
}

/** Scoped to the card, not the window: Esc elsewhere on the page must not discard the questions. */
function cancelOnEscape(event: KeyboardEvent) {
  if (event.isComposing || props.busy) return
  cancel()
}

function answerLabel(questionId: string): string {
  if (terminal.value?.status !== 'answered') return ''
  const value = terminal.value.answers.find(answer => answer.id === questionId)?.value
  if (value === null) return '已跳过'
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
Card(v-else-if="terminal" size="sm" class="my-2 w-full")
  CardHeader
    CardTitle.flex.items-center.gap-2.text-sm
      CircleHelpIcon
      span {{ terminalLabel }}
  CardContent(v-if="terminal.status === 'answered'" class="flex flex-col gap-3")
    .flex.flex-col.gap-1(v-for="question in input?.questions" :key="question.id")
      span.text-xs.text-muted-foreground {{ question.header }}
      span.text-sm {{ answerLabel(question.id) }}
  //- The question never reached anyone, so saying it was cancelled would blame the wrong party.
  CardContent(v-else-if="terminal.status === 'invalid'" class="text-sm text-muted-foreground") {{ terminal.message }}
  CardContent(v-else class="text-sm text-muted-foreground") 用户取消了回答。
  CardFooter(v-if="terminal.status === 'answered' && canContinue" class="justify-end")
    Button(size="sm" :disabled="busy" @click="emit('continue')") 继续
template(v-else)
  //- Its own strip above the card, and nowhere near the X. Sharing the header put a small target
  //- for "put this aside" next to a small target for "throw it away".
  .flex.justify-center(v-if="!collapsed")
    Button(
      variant="ghost" size="sm"
      class="min-h-10 w-48 max-w-full gap-1 text-xs text-muted-foreground md:min-h-7"
      aria-label="暂时收起" :aria-expanded="true" @click="collapsed = true")
      ChevronDownIcon(class="size-3.5")
      | 暂时收起
  //- Collapsing is deliberate and gets its own control; expanding is someone coming back to answer,
  //- so anywhere on the card will do. The X stops the click so it never expands on its way out.
  Card(
    size="sm" class="my-2 w-full" :class="collapsed ? 'cursor-pointer hover:bg-accent/40' : undefined"
    @keydown.escape="cancelOnEscape" @click="expandOnClick")
    CardHeader
      CardTitle.flex.items-center.gap-2.text-sm
        CircleHelpIcon
        span.shrink-0 {{ collapsed ? '点击回答问题' : '需要你的回答' }}
        //- Collapsed, the header is all there is, so it has to say what is behind it.
        span.min-w-0.truncate.font-normal.text-xs(
          v-if="collapsed && collapsedPreview" class="text-muted-foreground") {{ collapsedPreview }}
      CardAction
        //- Labelled rather than a bare glyph, and the label is part of the button: words beside a
        //- control that ignores them are a worse target than no words at all.
        Button(
          variant="ghost" size="sm" class="min-h-10 gap-1 px-2 text-xs text-muted-foreground md:min-h-6"
          :disabled="busy" title="不回答（Esc）" aria-label="不回答" @click.stop="cancel")
          | 不回答
          XIcon(class="size-3.5")
    //- Nothing below the header when folded: the header already names the state and the whole card
    //- is the target, so a second line saying so again only costs height.
    CardContent(v-if="!collapsed")
      Questionnaire(
        ref="questionnaire" v-model:item="activeQuestionId"
        :items="definitions" shortcuts="numbers" @submit="submit")
        QuestionnaireItem(
          v-for="question in input?.questions" :key="question.id" :name="question.id"
          :multiple="question.type === 'multiple'" :required="question.required")
          QuestionnaireTitle {{ question.question }}
          QuestionnaireDescription(v-if="question.description") {{ question.description }}
          QuestionnaireChoices(v-if="question.type !== 'text'" class="mt-3")
            QuestionnaireChoice(
              v-for="option in question.options ?? []" :key="option.label" :value="option.label"
              :checked="choiceChecked(question.id, option.label)"
              @update:checked="setChoice(question.id, option.label, question.type === 'multiple', $event)")
              span {{ option.label }}
              QuestionnaireChoiceDescription(v-if="option.description") {{ option.description }}
            QuestionnaireInput(
              v-if="question.allowOther" :model-value="otherAnswer(question.id)" placeholder="其他…"
              @update:model-value="setOtherAnswer(question.id, $event, question.type === 'multiple')")
          QuestionnaireInput(
            v-else :model-value="textAnswer(question.id)" :placeholder="question.placeholder"
            class="mt-3" @update:model-value="setTextAnswer(question.id, $event)")
          QuestionnaireError 请填写当前问题。
        QuestionnaireActions(class="mt-3")
          .flex.items-center.gap-2
            QuestionnairePrevious(size="sm") 上一步
            QuestionnaireProgress
              template(#default="progress") {{ progress.current }} / {{ progress.total }}
          QuestionnaireSkip(size="sm" @click="skipCurrentQuestion") 跳过
          QuestionnaireNext(size="sm") 下一步
          QuestionnaireSubmit(size="sm" :disabled="busy") 提交
</template>
