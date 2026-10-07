import { driver, type DriveStep } from 'driver.js'
import 'driver.js/dist/driver.css'
import './tour.css'
import type { Router } from 'vue-router'
import { conversationPath } from '@/client/lib/ui-models'
import type { BackendSignal, DemoBackend } from './backend'
import * as script from './script'

/** Thrown into a waiting step when the visitor skips, so the script unwinds without running on. */
class Skipped extends Error {}

const ELEMENT_TIMEOUT = 8_000

function last(selector: string): Element | null {
  const all = document.querySelectorAll(selector)
  return all[all.length - 1] ?? null
}

/**
 * The guided tour: a fixed script over the real UI. Each step either waits for "下一步" or for the
 * visitor to do the one thing the highlighted element is for; everything outside the highlight is
 * covered, so the script never meets a state it did not plan for.
 */
export function startTour(router: Router, backend: DemoBackend): void {
  let skipped = false
  let cancel: (() => void) | null = null
  let refreshTimer: ReturnType<typeof setInterval> | undefined

  const tour = driver({
    animate: true,
    allowClose: true,
    overlayClickBehavior: 'none',
    allowKeyboardControl: false,
    stagePadding: 6,
    stageRadius: 10,
    popoverClass: 'oc-tour',
    nextBtnText: '下一步',
    closeBtnLabel: '跳过引导',
    onCloseClick: () => skip(),
  })

  function guard(): void {
    if (skipped) throw new Skipped()
  }

  /** Resolves once `selector` matches something, or fails the tour step after a timeout. */
  async function element(selector: string): Promise<Element> {
    const deadline = Date.now() + ELEMENT_TIMEOUT
    for (;;) {
      guard()
      const found = last(selector)
      if (found) return found
      if (Date.now() > deadline) throw new Error(`[demo] tour target never appeared: ${selector}`)
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }

  function waitFor<T>(register: (done: (value: T) => void) => () => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const off = register(value => { off(); cancel = null; resolve(value) })
      cancel = () => { off(); reject(new Skipped()) }
    })
  }

  const signal = (wanted: BackendSignal) => waitFor<void>(done => backend.on(got => { if (got === wanted) done() }))
  const route = (prefix: string) => waitFor<void>(done => router.afterEach(to => { if (to.path.startsWith(prefix)) done() }))

  /**
   * Shows one step. Its element is re-measured while it is up, because a streaming message keeps
   * growing under the highlight.
   */
  async function show(selector: string | null, popover: NonNullable<DriveStep['popover']>, interactive: boolean): Promise<void> {
    const target = selector ? await element(selector) : undefined
    guard()
    clearInterval(refreshTimer)
    tour.highlight({ element: target, disableActiveInteraction: !interactive, popover: { showButtons: ['close'], ...popover } })
    if (target) refreshTimer = setInterval(() => tour.refresh(), 250)
  }

  /** A step the visitor reads and dismisses with "下一步"; `interactive` lets them poke the highlight meanwhile. */
  async function read(selector: string | null, title: string, description: string, interactive = false): Promise<void> {
    let next!: () => void
    const clicked = waitFor<void>(done => { next = () => done(); return () => {} })
    await show(selector, { title, description, showButtons: ['next', 'close'], onNextClick: () => next() }, interactive)
    await clicked
  }

  /** A step that ends when the visitor does what it asks; `until` starts listening before it shows. */
  async function act(selector: string, title: string, description: string, until: Promise<void>): Promise<void> {
    await show(selector, { title, description }, true)
    await until
  }

  async function fill(text: string): Promise<void> {
    const box = await element('[data-tour="composer-input"]') as HTMLTextAreaElement
    box.value = text
    box.dispatchEvent(new Event('input', { bubbles: true }))
  }

  async function run(): Promise<void> {
    await read(null, '欢迎来到 Only Chat', '这是一段可以亲手操作的演示：所有回复都是预置的，不调用任何模型，也不保存任何数据。大约一分钟，随时可以点右上角跳过。')

    await fill(script.TOUR_QUESTION)
    await act('[data-tour="composer-action"]', '发出第一条消息', '问题已经替你填好了，点发送。', signal('turn-start'))

    await show('[data-tour="assistant-message"]', { title: '先思考，再动手', description: '它会先推理，再调用联网搜索查天气，最后给出行程。这些步骤都会实时显示出来。' }, false)
    await signal('turn-done')
    await read('[data-tour="assistant-message"]', '每一步都看得见', '推理过程和搜索结果都收在回答上方的「执行过程」里，点开就能看到它是怎么想、查到了什么。', true)

    await act('[data-tour="regenerate"]', '换个回答', '不满意？点「重新生成」，原来的回答不会被覆盖。', signal('turn-start'))
    await show('[data-tour="assistant-message"]', { title: '长出一个分支', description: '新回答作为一个分支生成，旧的那个还在。' }, false)
    await signal('turn-done')
    await act('[data-tour="branch-switcher"]', '在分支之间切换', '用左右箭头回到上一个版本看看。编辑消息也会这样长出分支。', signal('switched'))

    await read('[data-tour="model-picker"]', '随时换模型', '同一段对话里可以换模型，接入的每家供应商都在这里。')
    await read('[data-tour="reasoning"]', '推理强度', '支持推理的模型可以调高或调低思考的深度。')
    await read('[data-tour="tools"]', '按需开启插件', '联网搜索、浏览器、生成图片、MCP……按会话开关，不开就不占提示词。')

    await router.push(conversationPath(script.CONVERSATIONS[0]!))
    await read('[data-tour="message-images"]', '图片和文件', '图片、PDF、音频、视频、源代码都能直接发给模型。')

    // On a phone the sidebar is a drawer: open it for the row, and close it again afterwards,
    // because entering a Project keeps the drawer open on that Project's own navigation.
    const sidebarRow = '[data-tour="project-row"]'
    if (!isVisible(last(sidebarRow))) toggleSidebar()
    await act(sidebarRow, 'Project', '把相关的对话放进一个 Project，它们共享同一套提示词、默认模型与参数。点进去看看。', route(`/project/${script.PROJECT_ID}`))
    if (document.querySelector('[data-sidebar="sidebar"][data-mobile="true"]')) toggleSidebar()
    await read('[data-tour="project-conversations"]', '统一的设定', `这个 Project 的提示词是：「${script.PROJECTS[0]!.system_prompt}」里面每段对话都会自动带上它。`)

    await router.push(`/c/${script.TOUR_CONVERSATION_ID}`)
    await fill(script.ENDING_QUESTION)
    await act('[data-tour="composer-action"]', '最后一步', '问问它接下来该做什么。', signal('turn-start'))
    finish()
  }

  function finish(): void {
    clearInterval(refreshTimer)
    tour.destroy()
  }

  function skip(): void {
    if (skipped) return
    skipped = true
    cancel?.()
    finish()
    void router.push(conversationPath(backend.playSkipEnding()))
  }

  run().catch(error => {
    if (error instanceof Skipped) return
    console.error(error)
    finish()
  })
}

function toggleSidebar(): void {
  (document.querySelector('[data-sidebar="trigger"]') as HTMLElement | null)?.click()
}

function isVisible(element: Element | null): boolean {
  if (!element) return false
  const rect = element.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.left < window.innerWidth
}
