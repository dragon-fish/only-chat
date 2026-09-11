<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ImagesIcon, PlusIcon } from '@lucide/vue'
import { RouterLink } from 'vue-router'
import { toast } from 'vue-sonner'
import { api } from '@/client/lib/api'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/client/ui/alert-dialog'
import { Button } from '@/client/ui/button'
import { Checkbox } from '@/client/ui/checkbox'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/client/ui/empty'
import { Skeleton } from '@/client/ui/skeleton'
import type { ArtifactDto } from '@/shared/artifacts'

const artifacts = ref<ArtifactDto[]>([])
const cursor = ref<string | null>(null)
const loading = ref(true)
const selected = ref(new Set<number>())
const removing = ref(false)

const selectedCount = computed(() => selected.value.size)

async function load(more = false) {
  loading.value = true
  try {
    const page = await api.artifacts(more && cursor.value ? { cursor: cursor.value } : {})
    artifacts.value = more ? [...artifacts.value, ...page.artifacts] : page.artifacts
    cursor.value = page.next_cursor
    // Keep only what is still on screen: a selected image that a reload dropped must not stay
    // selected, or the delete count would name images the user can no longer see.
    const visible = new Set(artifacts.value.map(artifact => artifact.id))
    selected.value = new Set([...selected.value].filter(id => visible.has(id)))
  } catch (error) { toast.error(error instanceof Error ? error.message : String(error)) }
  finally { loading.value = false }
}
onMounted(() => void load())

function toggle(id: number, value: boolean | 'indeterminate') {
  const next = new Set(selected.value)
  if (value === true) next.add(id)
  else next.delete(id)
  selected.value = next
}

function selectAll() {
  selected.value = new Set(artifacts.value.map(artifact => artifact.id))
}

/** One request per image, reporting what succeeded: a failure partway must not abort the rest. */
async function removeSelected() {
  const ids = [...selected.value]
  if (ids.length === 0) return
  removing.value = true
  let done = 0
  const failures: string[] = []
  try {
    for (const id of ids) {
      try { await api.deleteArtifact(id); done++ }
      catch (error) { failures.push(error instanceof Error ? error.message : String(error)) }
    }
    if (done > 0) toast.success(`已删除 ${done} 张图片`)
    if (failures.length > 0) toast.error(`${failures.length} 张未能删除：${failures[0]}`)
    selected.value = new Set()
    await load()
  }
  finally { removing.value = false }
}
</script>

<template>
  <Teleport to="#page-header" defer>
    <span class="truncate text-sm font-medium">图片 Gallery</span>
    <Button as-child size="sm" class="ml-auto min-h-10 md:min-h-8"><RouterLink to="/images/new"><PlusIcon data-icon="inline-start" />新建图片</RouterLink></Button>
  </Teleport>
  <div class="h-full overflow-y-auto">
    <main class="mx-auto w-full max-w-7xl p-4 md:p-6">
      <div v-if="loading && !artifacts.length" class="columns-2 gap-3 md:columns-3 xl:columns-4"><Skeleton v-for="n in 8" :key="n" class="mb-3 aspect-square break-inside-avoid rounded-xl" /></div>
      <Empty v-else-if="!artifacts.length"><EmptyHeader><EmptyMedia variant="icon"><ImagesIcon /></EmptyMedia><EmptyTitle>还没有生成图片</EmptyTitle><EmptyDescription>从 Studio 创建的图片会出现在这里。</EmptyDescription></EmptyHeader><Button as-child><RouterLink to="/images/new">开始创作</RouterLink></Button></Empty>
      <template v-else>
        <!-- Sticky, because the grid is long and the selection is made while scrolling. -->
        <div v-if="selectedCount" class="bg-background/95 sticky top-0 z-10 mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 backdrop-blur">
          <span class="text-xs">已选 {{ selectedCount }} 张</span>
          <div class="flex items-center gap-2">
            <Button type="button" variant="ghost" size="xs" class="min-h-10 md:min-h-7" :disabled="removing" @click="selectAll">全选本页</Button>
            <Button type="button" variant="ghost" size="xs" class="min-h-10 md:min-h-7" :disabled="removing" @click="selected = new Set()">取消选择</Button>
            <AlertDialog>
              <AlertDialogTrigger as-child>
                <Button type="button" variant="outline" size="xs" class="min-h-10 md:min-h-7" :disabled="removing">删除</Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>删除选中的 {{ selectedCount }} 张图片？</AlertDialogTitle>
                  <AlertDialogDescription>它们会从 Gallery 移除。引用过这些图片的对话仍会显示它们。</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>取消</AlertDialogCancel>
                  <AlertDialogAction @click="removeSelected">删除</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
        <div class="columns-2 gap-3 md:columns-3 xl:columns-4">
          <div v-for="artifact in artifacts" :key="artifact.id" class="relative mb-3 break-inside-avoid">
            <RouterLink :to="`/images/a/${artifact.id}`" class="group block overflow-hidden rounded-xl border bg-muted" :class="selected.has(artifact.id) ? 'ring-primary ring-2' : ''">
              <img :src="api.artifactContentUrl(artifact.id, 'gallery')" :alt="artifact.prompt" class="h-auto w-full transition-transform duration-300 group-hover:scale-[1.02]" loading="lazy" />
              <div class="flex flex-col gap-1 p-3"><span class="line-clamp-2 text-sm">{{ artifact.prompt }}</span><span class="truncate text-xs text-muted-foreground">{{ artifact.model_name }}</span></div>
            </RouterLink>
            <!-- Outside the link, and stopping the event: a tick must never navigate. -->
            <div class="bg-background/80 absolute left-2 top-2 rounded-md p-1.5 backdrop-blur" @click.stop.prevent>
              <Checkbox
                :model-value="selected.has(artifact.id)"
                :aria-label="`选择 ${artifact.prompt}`"
                @update:model-value="value => toggle(artifact.id, value)"
              />
            </div>
          </div>
        </div>
      </template>
      <div v-if="cursor" class="flex justify-center py-6"><Button variant="outline" :disabled="loading" @click="load(true)">加载更多</Button></div>
    </main>
  </div>
</template>
