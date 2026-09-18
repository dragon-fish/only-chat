import { computed, markRaw, type Component } from 'vue'
import { defineStore } from 'pinia'
import {
  CircleUserRoundIcon, FolderIcon, MessagesSquareIcon, PaletteIcon, PlugIcon, ServerCogIcon, ServerIcon,
  SettingsIcon, SparklesIcon, UsersIcon,
} from '@lucide/vue'
import { useAuditEnabled } from '@/client/composables/use-audit-listing'
import { pluginManifests } from '@/client/plugins/loaders'
import { useAuthStore } from '@/client/stores/auth'
import { useSyncStore } from '@/client/stores/sync'
import { isAuthAdmin } from '@/shared/auth'
import { pluginSettingsEntries } from '@/shared/plugins'

export interface SettingsNavItem { label: string, description: string, to: string, icon: Component }
export interface SettingsNavGroup { id: 'settings' | 'plugins' | 'admin' | 'audit', label: string, items: SettingsNavItem[] }

/**
 * The one table of contents for settings, as Special:SpecialPages is for a wiki: the settings
 * sidebar and the `/settings` landing page both render it. A group the viewer may not use is absent.
 */
export const useSettingsNavStore = defineStore('settingsNav', () => {
  const auth = useAuthStore()
  const sync = useSyncStore()
  const auditEnabled = useAuditEnabled()
  const groups = computed<SettingsNavGroup[]>(() => {
    const groups: SettingsNavGroup[] = [{
      id: 'settings', label: '设置', items: [
        { label: '账户', description: '管理个人信息与登录密码', to: '/settings/account', icon: markRaw(CircleUserRoundIcon) },
        { label: '模型服务', description: '连接供应商，管理模型与能力', to: '/settings/providers', icon: markRaw(ServerIcon) },
        { label: '全局服务模型', description: '应用自己使用的文本与生图模型', to: '/settings/service-models', icon: markRaw(SparklesIcon) },
        { label: '插件', description: '管理聊天中的工具与扩展', to: '/settings/plugins', icon: markRaw(PlugIcon) },
        { label: '外观', description: '调整主题与显示偏好', to: '/settings/appearance', icon: markRaw(PaletteIcon) },
      ],
    }]
    // Their own group: a plugin page is not a sub-page of 插件, which manages which plugins run.
    const pluginPages = pluginSettingsEntries(pluginManifests, sync.settings.plugins)
    if (pluginPages.length) groups.push({ id: 'plugins', label: '插件数据管理', items: pluginPages.map(page => ({ ...page, icon: markRaw(FolderIcon) })) })
    if (isAuthAdmin(auth.authUser)) {
      groups.push({ id: 'admin', label: '站点管理', items: [
        { label: '用户管理', description: '管理账户、角色与登录权限', to: '/admin/users', icon: markRaw(UsersIcon) },
        { label: '注册设置', description: '设置本站是否开放注册', to: '/admin/settings', icon: markRaw(SettingsIcon) },
      ] })
    }
    if (auditEnabled.value) {
      groups.push({ id: 'audit', label: '审计', items: [
        { label: '全站会话', description: '只读查看所有用户的会话', to: '/admin/audit/conversations', icon: markRaw(MessagesSquareIcon) },
        { label: '全站供应商', description: '只读查看所有用户的供应商配置', to: '/admin/audit/providers', icon: markRaw(ServerCogIcon) },
      ] })
    }
    return groups
  })
  const targets = computed(() => groups.value.flatMap(group => group.items.map(item => item.to)))
  return { groups, targets }
})
