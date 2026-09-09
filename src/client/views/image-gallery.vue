<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ImagesIcon, PlusIcon } from '@lucide/vue'
import { RouterLink } from 'vue-router'
import { toast } from 'vue-sonner'
import { api } from '@/client/lib/api'
import { Button } from '@/client/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/client/ui/empty'
import { Skeleton } from '@/client/ui/skeleton'
import type { ArtifactDto } from '@/shared/artifacts'

const artifacts = ref<ArtifactDto[]>([])
const cursor = ref<string | null>(null)
const loading = ref(true)
async function load(more = false) {
  loading.value = true
  try {
    const page = await api.artifacts(more && cursor.value ? { cursor: cursor.value } : {})
    artifacts.value = more ? [...artifacts.value, ...page.artifacts] : page.artifacts
    cursor.value = page.next_cursor
  } catch (error) { toast.error(error instanceof Error ? error.message : String(error)) }
  finally { loading.value = false }
}
onMounted(() => void load())
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
      <div v-else class="columns-2 gap-3 md:columns-3 xl:columns-4">
        <RouterLink v-for="artifact in artifacts" :key="artifact.id" :to="`/images/a/${artifact.id}`" class="group mb-3 block break-inside-avoid overflow-hidden rounded-xl border bg-muted">
          <img :src="api.artifactContentUrl(artifact.id, 'gallery')" :alt="artifact.prompt" class="h-auto w-full transition-transform duration-300 group-hover:scale-[1.02]" loading="lazy" />
          <div class="flex flex-col gap-1 p-3"><span class="line-clamp-2 text-sm">{{ artifact.prompt }}</span><span class="truncate text-xs text-muted-foreground">{{ artifact.model_name }}</span></div>
        </RouterLink>
      </div>
      <div v-if="cursor" class="flex justify-center py-6"><Button variant="outline" :disabled="loading" @click="load(true)">加载更多</Button></div>
    </main>
  </div>
</template>
