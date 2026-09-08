<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { initialCrop, moveCrop, resizeCrop, type CropHandle, type CropRect } from '@/client/lib/image-crop'

const props = withDefaults(defineProps<{
  source: Blob
  aspectRatio?: number
  outputWidth: number
  outputHeight: number
  minCrop?: number
  outputType?: string
  quality?: number
  previewShape?: 'rect' | 'circle'
}>(), { minCrop: 32, outputType: 'image/webp', quality: 0.9, previewShape: 'rect' })

const image = ref<HTMLImageElement | null>(null)
const url = ref('')
const crop = ref<CropRect>({ x: 0, y: 0, width: 0, height: 0 })
const display = ref({ width: 0, height: 0 })
let drag: { handle: CropHandle; x: number; y: number; crop: CropRect } | null = null

watch(() => props.source, async source => {
  if (url.value) URL.revokeObjectURL(url.value)
  url.value = URL.createObjectURL(source)
  await nextTick()
}, { immediate: true })

function loaded() {
  const element = image.value
  if (!element) return
  display.value = { width: element.clientWidth, height: element.clientHeight }
  crop.value = initialCrop(display.value.width, display.value.height, props.aspectRatio)
}
function down(handle: CropHandle, event: PointerEvent) {
  event.preventDefault()
  drag = { handle, x: event.clientX, y: event.clientY, crop: { ...crop.value } }
}
function move(event: PointerEvent) {
  if (!drag) return
  const dx = event.clientX - drag.x
  const dy = event.clientY - drag.y
  crop.value = drag.handle === 'move'
    ? moveCrop(drag.crop, dx, dy, display.value.width, display.value.height)
    : resizeCrop(drag.crop, drag.handle, dx, dy, display.value.width, display.value.height, props.aspectRatio, props.minCrop)
}
function up() { drag = null }
window.addEventListener('pointermove', move)
window.addEventListener('pointerup', up)
onBeforeUnmount(() => {
  window.removeEventListener('pointermove', move)
  window.removeEventListener('pointerup', up)
  if (url.value) URL.revokeObjectURL(url.value)
})

const selectionStyle = computed(() => ({
  left: `${crop.value.x}px`, top: `${crop.value.y}px`, width: `${crop.value.width}px`, height: `${crop.value.height}px`,
  borderRadius: props.previewShape === 'circle' ? '9999px' : undefined,
}))
const handles: Exclude<CropHandle, 'move'>[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

async function getCroppedImage(): Promise<Blob> {
  const element = image.value
  if (!element || crop.value.width <= 0 || crop.value.height <= 0) throw new Error('图片尚未加载完成')
  const canvas = document.createElement('canvas')
  canvas.width = props.outputWidth
  canvas.height = props.outputHeight
  const context = canvas.getContext('2d')
  if (!context) throw new Error('浏览器无法创建图片画布')
  const scaleX = element.naturalWidth / display.value.width
  const scaleY = element.naturalHeight / display.value.height
  context.drawImage(element, crop.value.x * scaleX, crop.value.y * scaleY, crop.value.width * scaleX, crop.value.height * scaleY, 0, 0, props.outputWidth, props.outputHeight)
  return await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('图片编码失败')), props.outputType, props.quality))
}
defineExpose({ getCroppedImage })
</script>

<template>
  <div class="flex justify-center overflow-hidden rounded-lg bg-muted p-2">
    <div class="relative inline-block max-w-full overflow-hidden select-none">
      <img ref="image" :src="url" alt="待裁剪图片" class="block max-h-[60dvh] max-w-full" draggable="false" @load="loaded" />
      <div class="crop-selection absolute border-2 border-background" :style="selectionStyle" @pointerdown="down('move', $event)">
        <span v-for="handle in handles" :key="handle" :class="`crop-handle crop-${handle}`" @pointerdown.stop="down(handle, $event)" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.crop-selection { cursor: move; box-shadow: 0 0 0 9999px rgb(0 0 0 / 55%); touch-action: none; }
.crop-handle { position: absolute; width: 14px; height: 14px; border: 2px solid var(--background); border-radius: 9999px; background: var(--primary); }
.crop-nw { left: -7px; top: -7px; cursor: nw-resize; }.crop-n { left: calc(50% - 7px); top: -7px; cursor: n-resize; }.crop-ne { right: -7px; top: -7px; cursor: ne-resize; }
.crop-e { right: -7px; top: calc(50% - 7px); cursor: e-resize; }.crop-se { right: -7px; bottom: -7px; cursor: se-resize; }.crop-s { left: calc(50% - 7px); bottom: -7px; cursor: s-resize; }
.crop-sw { left: -7px; bottom: -7px; cursor: sw-resize; }.crop-w { left: -7px; top: calc(50% - 7px); cursor: w-resize; }
</style>
