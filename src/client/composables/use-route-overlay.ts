import { onBeforeUnmount, ref, type Ref } from 'vue'
import { useRouter, type RouteLocationRaw } from 'vue-router'

/** Dialog motion is 100ms; keep its route alive through the final painted frame. */
const ROUTE_OVERLAY_LEAVE_MS = 120

/**
 * An overlay whose presence is a route: closing plays the exit animation first and only then runs
 * `leave`, because leaving unmounts the overlay mid-animation.
 */
export function useOverlayLeave(leave: () => void): {
  open: Ref<boolean>
  setOpen: (value: boolean) => void
} {
  const open = ref(true)
  let leaveTimer: ReturnType<typeof setTimeout> | undefined

  function setOpen(value: boolean): void {
    open.value = value
    if (leaveTimer !== undefined) clearTimeout(leaveTimer)
    leaveTimer = undefined
    if (!value) {
      leaveTimer = setTimeout(() => {
        leaveTimer = undefined
        leave()
      }, ROUTE_OVERLAY_LEAVE_MS)
    }
  }

  onBeforeUnmount(() => {
    if (leaveTimer !== undefined) clearTimeout(leaveTimer)
  })

  return { open, setOpen }
}

export function useRouteOverlay(destination: () => RouteLocationRaw): {
  open: Ref<boolean>
  setOpen: (value: boolean) => void
} {
  const router = useRouter()
  return useOverlayLeave(() => { void router.push(destination()) })
}
