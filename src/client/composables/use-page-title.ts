import { computed } from 'vue'
import { useTitle } from '@vueuse/core'
import { useRoute } from 'vue-router'
import { routeParamToId } from '@/client/lib/route-params'
import { projectPresentation } from '@/client/lib/ui-models'
import { useSyncStore } from '@/client/stores/sync'

const pageTitles: Record<string, string> = {
  '/login': '登录',
  '/register': '注册',
  '/new': '新对话',
  '/chats': '聊天',
  '/projects': 'Projects',
  '/images': '图片 Gallery',
  '/images/new': '图片创作',
  '/me': '我的',
  '/settings': '设置',
  '/settings/account': '账户设置',
  '/settings/providers': '供应商设置',
  '/settings/service-models': '全局服务模型',
  '/settings/plugins': '插件设置',
  '/settings/appearance': '外观设置',
  '/admin/users': '用户管理',
  '/admin/settings': '注册设置',
}

export function usePageTitle(): void {
  const route = useRoute()
  const sync = useSyncStore()
  const pageTitle = computed(() => {
    const path = route.path.replace(/\/+$/, '') || '/'
    const conversationParam = 'conversationId' in route.params ? route.params.conversationId : undefined
    const projectParam = 'projectId' in route.params ? route.params.projectId : undefined
    const conversationId = routeParamToId(typeof conversationParam === 'string' ? conversationParam : undefined)
    const routeProjectId = routeParamToId(typeof projectParam === 'string' ? projectParam : undefined)

    if (/^\/(?:new|c)(?:\/|$)/.test(path) || /^\/project\/[^/]+\/(?:new|c)(?:\/|$)/.test(path)) {
      const conversation = conversationId === null ? undefined : sync.conversations.get(conversationId)
      const projectId = conversation ? conversation.project_id : routeProjectId
      const project = projectId === null ? undefined : sync.projects.get(projectId)
      const title = conversation?.title.trim() || (conversationId === null ? '新对话' : '对话')
      return [title, project && projectPresentation(project.name).title].filter(Boolean).join(' | ')
    }

    if (path.startsWith('/project/')) {
      const project = routeProjectId === null ? undefined : sync.projects.get(routeProjectId)
      const name = project ? projectPresentation(project.name).title : 'Project'
      return path.endsWith('/settings') ? `Project 设置 | ${name}` : name
    }

    if (path.startsWith('/settings/providers/')) return '供应商设置'
    if (path.startsWith('/settings/plugins/')) return path.endsWith('/data') ? '插件数据管理' : '插件设置'
    if (path.startsWith('/images/s/')) return path.includes('/a/') ? '图片详情' : '图片创作'
    if (path.startsWith('/images/a/')) return '图片详情'
    return pageTitles[path] ?? ''
  })

  useTitle(pageTitle, { titleTemplate: title => title ? `${title} | Only Chat` : 'Only Chat' })
}
