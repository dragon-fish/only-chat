<template>
  <header class="flex h-12 shrink-0 items-center gap-2 border-b px-3">
    <div class="flex shrink-0 items-center">
      <slot name="leading" />
    </div>
    <div id="page-header" class="flex min-w-0 flex-1 items-center gap-2">
      <slot />
    </div>
    <div class="flex shrink-0 items-center gap-1">
      <slot name="actions" />
    </div>
  </header>
</template>
