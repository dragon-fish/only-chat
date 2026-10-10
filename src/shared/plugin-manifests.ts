import type { PluginManifest } from './plugins'
import askUser from '@/plugins/ask-user/manifest'
import tavily from '@/plugins/tavily/manifest'
import datetime from '@/plugins/datetime/manifest'
import imageGeneration from '@/plugins/image-generation/manifest'
import workspaceFiles from '@/plugins/workspace-files/manifest'
import browserRun from '@/plugins/cloudflare-browser-run/manifest'
import fileUnderstanding from '@/plugins/file-understanding/manifest'
import fileReader from '@/plugins/file-reader/manifest'
import mcp from '@/plugins/mcp/manifest'
import comfyui from '@/plugins/comfyui/manifest'
import memory from '@/plugins/memory/manifest'
import contextCompaction from '@/plugins/context-compaction/manifest'
import generativeUi from '@/plugins/generative-ui/manifest'

/**
 * The one list both halves of the app read. The client used to discover manifests with
 * `import.meta.glob`, which the Worker cannot share: the server needs the same declarations to
 * know which config keys are secrets, and two discovery mechanisms would eventually disagree.
 */
export const pluginManifests: readonly PluginManifest[] = [askUser, tavily, datetime, fileReader, imageGeneration, workspaceFiles, memory, fileUnderstanding, browserRun, mcp, comfyui, contextCompaction, generativeUi]

export function findPluginManifest(pluginId: string): PluginManifest | undefined {
  return pluginManifests.find(manifest => manifest.id === pluginId)
}
