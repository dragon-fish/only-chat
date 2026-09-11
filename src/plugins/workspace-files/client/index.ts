import type { ClientPluginSetup } from '@/client/plugins/host'
import { LIST_FILES_TOOL_ID, READ_FILE_TOOL_ID, RESTORE_FILE_TOOL_ID, WRITE_FILE_TOOL_ID } from '../shared'
import ListFilesCard from './list-files-card.vue'
import ReadFileCard from './read-file-card.vue'
import RestoreFileCard from './restore-file-card.vue'
import WriteFileCard from './write-file-card.vue'

export const setup: ClientPluginSetup = (ctx) => {
  ctx.tools.register(LIST_FILES_TOOL_ID, ListFilesCard)
  ctx.tools.register(READ_FILE_TOOL_ID, ReadFileCard)
  ctx.tools.register(WRITE_FILE_TOOL_ID, WriteFileCard)
  ctx.tools.register(RESTORE_FILE_TOOL_ID, RestoreFileCard)
}
