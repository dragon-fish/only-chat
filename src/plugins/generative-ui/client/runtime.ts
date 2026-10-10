import { computed, inject, onBeforeUnmount, shallowRef, type ComputedRef, type FunctionalComponent, type InjectionKey } from 'vue'
import { ACTION_STEPS, resolveStateField, type ActionPlan } from '@openuidev/lang-core'
import { useFormName, useOpenUI, type RenderNodeResult } from '@openuidev/vue-lang'

/** What every OpenUI renderer receives from vue-lang's RenderNode. */
export interface NodeProps<P> {
  props: P
  renderNode: (value: unknown) => RenderNodeResult
}

/** A parsed child as a parent sees it before rendering — how Tabs reads its TabItems. */
export interface ElementLike<P> { type: 'element', typeName: string, props: P }

export function isElement<P = Record<string, unknown>>(value: unknown): value is ElementLike<P> {
  return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'element'
}

/**
 * Renders one parsed value. A stable component, not an inline `() => renderNode(x)`: a fresh
 * function per render would be a new component type each time and remount every child, wiping
 * slider positions and typed text.
 */
export const RenderValue: FunctionalComponent<{ value: unknown, render: (value: unknown) => RenderNodeResult }> = props => props.render(props.value)
RenderValue.props = ['value', 'render']

/** What the card grants its controls; absent outside a card, which never happens in practice. */
export interface GenerativeUiHost {
  /** False while the model is answering, offline, or under an audit: messaging buttons go grey. */
  canMessage: ComputedRef<boolean>
}
export const GENERATIVE_UI_HOST: InjectionKey<GenerativeUiHost> = Symbol('generative-ui-host')

export function useGenerativeUiHost(): GenerativeUiHost {
  return inject(GENERATIVE_UI_HOST, { canMessage: computed(() => false) })
}

/** True when clicking would reach the assistant; local-only @Set/@Reset/@OpenUrl buttons stay live. */
export function messagesAssistant(action: unknown): boolean {
  const steps = (action as ActionPlan | undefined)?.steps
  if (!Array.isArray(steps)) {
    const type = (action as { type?: unknown } | undefined)?.type
    return type !== 'open_url'
  }
  return steps.some(step => step.type === ACTION_STEPS.ToAssistant || step.type === ACTION_STEPS.Run)
}

/**
 * vue-lang 0.3.2 has no `useStateField`; this mirrors react-lang's `hooks/useStateField.ts`.
 * Adapted from OpenUI (https://github.com/thesysdev/openui), Copyright (c) 2011-2024 Thesys Inc., MIT License. See NOTICE.md.
 * The store is a plain
 * subscribe/getSnapshot object Vue cannot see into, so a version counter bumped on every store
 * change is what makes the value re-read — without it a bound control would not follow @Set/@Reset.
 */
export function useStateField<T>(name: () => string, binding: () => unknown) {
  const ctx = useOpenUI()
  const formName = useFormName()
  const version = shallowRef(0)
  onBeforeUnmount(ctx.store.subscribe(() => { version.value++ }))
  const field = computed(() => {
    void version.value
    return resolveStateField<T>(
      name(), binding(), ctx.store, ctx.evaluationContext,
      fieldName => ctx.getFieldValue(formName?.value, fieldName),
      (fieldName, value) => ctx.setFieldValue(formName?.value, undefined, fieldName, value),
    )
  })
  return {
    value: computed(() => field.value.value),
    isReactive: computed(() => field.value.isReactive),
    set(value: T) { field.value.setValue(value) },
  }
}
