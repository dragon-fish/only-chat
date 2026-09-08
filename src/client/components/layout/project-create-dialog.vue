<script setup lang="ts">
import { ref, watch, watchEffect } from 'vue'
import { useRouter } from 'vue-router'
import { PlusIcon } from '@lucide/vue'
import { cn } from '@/client/lib/utils'
import { DISCONNECTED_MESSAGE, useSyncStore } from '@/client/stores/sync'
import { Button } from '@/client/ui/button'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/client/ui/dialog'
import { Field, FieldGroup, FieldLabel } from '@/client/ui/field'
import { Input } from '@/client/ui/input'
import { Spinner } from '@/client/ui/spinner'

withDefaults(defineProps<{
  compact?: boolean
}>(), {
  compact: false,
})

const sync = useSyncStore()
const router = useRouter()
const open = ref(false)
const name = ref('')
const submittedName = ref<string | null>(null)
const idsBeforeSubmit = ref<Set<number> | null>(null)

watch(open, (value) => {
  if (!value) {
    name.value = ''
    submittedName.value = null
    idsBeforeSubmit.value = null
  }
})

watchEffect(() => {
  const submitted = submittedName.value
  const previousIds = idsBeforeSubmit.value
  if (submitted === null || previousIds === null) return
  const created = sync.projectList.find(project => !previousIds.has(project.id) && project.name === submitted)
  if (created) {
    open.value = false
    void router.push(`/project/${created.id}`)
  }
})

watch(() => sync.lastError, (error) => {
  if (error !== null) {
    submittedName.value = null
    idsBeforeSubmit.value = null
  }
})

function createProject() {
  const value = name.value.trim()
  if (!value || submittedName.value !== null) return
  idsBeforeSubmit.value = new Set(sync.projects.keys())
  submittedName.value = value
  sync.lastError = null
  if (!sync.send({ type: 'project.create', name: value })) {
    submittedName.value = null
    idsBeforeSubmit.value = null
    sync.lastError = DISCONNECTED_MESSAGE
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogTrigger as-child>
      <slot v-if="$slots.trigger" name="trigger" />
      <Button
        v-else
        :variant="compact ? 'ghost' : 'default'"
        :size="compact ? 'icon-sm' : 'default'"
        :class="cn(compact ? 'size-10' : 'min-h-10')"
        :aria-label="compact ? '新建 Project' : undefined"
      >
        <PlusIcon data-icon="inline-start" />
        <span v-if="!compact">新建 Project</span>
      </Button>
    </DialogTrigger>
    <DialogContent class="[&>button]:size-10">
      <DialogHeader>
        <DialogTitle>新建 Project</DialogTitle>
        <DialogDescription>为相关对话创建一个独立工作区。</DialogDescription>
      </DialogHeader>
      <form class="contents" @submit.prevent="createProject">
        <FieldGroup>
          <Field>
            <FieldLabel for="oc-new-project-name">名称</FieldLabel>
            <Input id="oc-new-project-name" v-model="name" class="min-h-10" autofocus placeholder="例如：产品设计" />
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button type="button" variant="outline" class="min-h-10" @click="open = false">取消</Button>
          <Button class="min-h-10" type="submit" :disabled="!name.trim() || sync.status !== 'open' || submittedName !== null">
            <Spinner v-if="submittedName !== null" data-icon="inline-start" />
            {{ submittedName === null ? '创建' : '创建中…' }}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
