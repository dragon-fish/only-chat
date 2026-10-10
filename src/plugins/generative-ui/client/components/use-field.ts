import { computed, onBeforeUnmount, watchEffect } from 'vue'
import { parseStructuredRules } from '@openuidev/lang-core'
import { useFormName, useFormValidation, useIsStreaming, useSetDefaultValue } from '@openuidev/vue-lang'
import { useStateField } from '../runtime'

/**
 * One form control's value, validation and default. The default is written into form state up
 * front so a form submitted untouched still reports what the user saw on screen.
 */
export function useField<T>(componentType: string, name: () => string, binding: () => unknown, rules: () => unknown, fallback?: T) {
  const field = useStateField<T>(name, binding)
  const validation = useFormValidation()
  const streaming = useIsStreaming()
  const formName = useFormName()
  const parsedRules = computed(() => parseStructuredRules(rules()))
  if (!field.isReactive.value) {
    const initial = binding() ?? fallback
    if (initial !== undefined && initial !== null) {
      useSetDefaultValue({ formName: formName?.value, componentType, name: name(), defaultValue: initial })
    }
  }
  if (validation) {
    watchEffect(() => {
      if (parsedRules.value.length > 0) validation.registerField(name(), parsedRules.value, () => field.value.value)
    })
    onBeforeUnmount(() => validation.unregisterField(name()))
  }
  return {
    value: field.value,
    disabled: streaming,
    error: computed(() => validation?.errors[name()]),
    set(value: T) {
      field.set(value)
      if (validation && parsedRules.value.length > 0) validation.validateField(name(), value, parsedRules.value)
    },
  }
}
