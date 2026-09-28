<script setup lang="ts">
import { computed, ref } from 'vue'
import { ImageIcon, Trash2Icon } from '@lucide/vue'
import { toast } from 'vue-sonner'
import ImageCropper from '@/client/components/image-cropper.vue'
import ProjectAvatar from '@/client/components/project-avatar.vue'
import { api } from '@/client/lib/api'
import { sha256Hex } from '@/client/lib/image-prep'
import { Button } from '@/client/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/client/ui/dialog'
import { Spinner } from '@/client/ui/spinner'

const props = defineProps<{ name: string, attachmentId: number | null }>()
const emit = defineEmits<{ 'update:attachmentId': [number | null] }>()
const fileInput = ref<HTMLInputElement | null>(null)
const source = ref<Blob | null>(null)
const cropper = ref<InstanceType<typeof ImageCropper> | null>(null)
const saving = ref(false)
const previewProject = computed(() => ({ name: props.name, icon_attachment_id: props.attachmentId }))
function selectFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (file?.type.startsWith('image/')) source.value = file
}
async function applyCrop() {
  if (!cropper.value) return
  saving.value = true
  try {
    const blob = await cropper.value.getCroppedImage()
    const sha256 = await sha256Hex(await blob.arrayBuffer())
    // Not a chat attachment, so the site upload policy does not apply (spec §6.2).
    const checked = await api.checkAttachment(sha256, 'image')
    const attachmentId = checked.exists && checked.attachment_id !== undefined
      ? checked.attachment_id
      : (await api.uploadAttachment(sha256, blob, { purpose: 'image', width: 200, height: 200 })).attachment_id
    emit('update:attachmentId', attachmentId)
    source.value = null
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error))
  } finally { saving.value = false }
}
function clear() { emit('update:attachmentId', null) }
</script>

<template>
  <div class="flex flex-wrap items-center gap-3">
    <ProjectAvatar :project="previewProject" />
    <input ref="fileInput" class="hidden" type="file" accept="image/*" @change="selectFile" />
    <Button type="button" variant="outline" class="min-h-10" @click="fileInput?.click()"><ImageIcon data-icon="inline-start" />选择图片</Button>
    <Button v-if="attachmentId" type="button" variant="ghost" size="icon-sm" class="size-10" aria-label="清除图标" @click="clear"><Trash2Icon /></Button>
  </div>
  <Dialog :open="source !== null" @update:open="value => { if (!value) source = null }">
    <DialogContent class="sm:max-w-2xl">
      <DialogHeader><DialogTitle>裁剪 Project 图标</DialogTitle></DialogHeader>
      <ImageCropper v-if="source" ref="cropper" :source="source" :aspect-ratio="1" :output-width="200" :output-height="200" output-type="image/webp" preview-shape="circle" />
      <DialogFooter>
        <Button type="button" variant="outline" class="min-h-10" @click="source = null">取消</Button>
        <Button type="button" class="min-h-10" :disabled="saving" @click="applyCrop"><Spinner v-if="saving" data-icon="inline-start" />使用图片</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
