import { describe, expect, it } from 'vitest'
import { pluginManifests } from '@/shared/plugin-manifests'
import {
  ASK_USER_PLUGIN_ID, BROWSER_RUN_PLUGIN_ID, COMFYUI_PLUGIN_ID, CONTEXT_COMPACTION_PLUGIN_ID, DATETIME_PLUGIN_ID, FILE_READER_PLUGIN_ID, FILE_UNDERSTANDING_PLUGIN_ID,
  IMAGE_GENERATION_PLUGIN_ID, MCP_PLUGIN_ID, MEMORY_PLUGIN_ID, TAVILY_PLUGIN_ID, WORKSPACE_FILES_PLUGIN_ID,
} from '@/shared/plugins'
import { AskUserServerPlugin } from '@/plugins/ask-user/server'
import { BrowserRunServerPlugin } from '@/plugins/cloudflare-browser-run/server'
import { ComfyuiServerPlugin } from '@/plugins/comfyui/server'
import { ContextCompactionServerPlugin } from '@/plugins/context-compaction/server'
import { DatetimeServerPlugin } from '@/plugins/datetime/server'
import { FileReaderServerPlugin } from '@/plugins/file-reader/server'
import { FileReader } from '@/plugins/file-reader/server/service'
import { FileUnderstandingServerPlugin } from '@/plugins/file-understanding/server'
import { ImageGenerationServerPlugin } from '@/plugins/image-generation/server'
import { McpServerPlugin } from '@/plugins/mcp/server'
import { MemoryServerPlugin } from '@/plugins/memory/server'
import { TavilyServerPlugin } from '@/plugins/tavily/server'
import { WorkspaceFilesServerPlugin } from '@/plugins/workspace-files/server'

/** Each plugin's hub half, which is where tools run and services are injected. */
const SERVERS: Record<string, { inject?: readonly string[] }> = {
  [ASK_USER_PLUGIN_ID]: AskUserServerPlugin,
  [BROWSER_RUN_PLUGIN_ID]: BrowserRunServerPlugin,
  [COMFYUI_PLUGIN_ID]: ComfyuiServerPlugin,
  [CONTEXT_COMPACTION_PLUGIN_ID]: ContextCompactionServerPlugin,
  [DATETIME_PLUGIN_ID]: DatetimeServerPlugin,
  [FILE_READER_PLUGIN_ID]: FileReaderServerPlugin,
  [FILE_UNDERSTANDING_PLUGIN_ID]: FileUnderstandingServerPlugin,
  [IMAGE_GENERATION_PLUGIN_ID]: ImageGenerationServerPlugin,
  [MCP_PLUGIN_ID]: McpServerPlugin,
  [MEMORY_PLUGIN_ID]: MemoryServerPlugin,
  [TAVILY_PLUGIN_ID]: TavilyServerPlugin,
  [WORKSPACE_FILES_PLUGIN_ID]: WorkspaceFilesServerPlugin,
}

/** Services a plugin provides to other plugins, by the plugin that provides them. */
const PROVIDED: Record<string, string> = {
  [FileReader.provide]: FILE_READER_PLUGIN_ID,
}

/**
 * Requirements that are not a service: the plugin does its work through another plugin's tools, so
 * without them in the turn it has nothing to offer. Memory is read, edited and deleted with the
 * workspace file tools.
 */
const TOOL_REQUIREMENTS: Record<string, readonly string[]> = {
  [MEMORY_PLUGIN_ID]: [WORKSPACE_FILES_PLUGIN_ID],
}

describe('plugin requirements', () => {
  it('cover every plugin, so a new one cannot skip the check', () => {
    expect(Object.keys(SERVERS).sort()).toEqual(pluginManifests.map(manifest => manifest.id).sort())
  })

  // A plugin whose server injects another plugin's service but whose manifest does not require it
  // could be switched on alone, and its tools would then fail every call they make.
  it.each(pluginManifests.map(manifest => [manifest.id, manifest] as const))('%s requires every plugin whose service it injects', (id, manifest) => {
    const needed = [...(SERVERS[id]!.inject ?? []).flatMap(service => PROVIDED[service] ?? []), ...(TOOL_REQUIREMENTS[id] ?? [])]
    expect([...(manifest.requires ?? [])].sort()).toEqual([...new Set(needed)].sort())
  })
})
