import type { ClientPluginSetup } from '@/client/plugins/host'
import {
  DELETE_FILE_TOOL_ID, LIST_FILES_TOOL_ID, READ_FILE_TOOL_ID, RENAME_FILE_TOOL_ID,
  RESTORE_FILE_TOOL_ID, WRITE_FILE_TOOL_ID,
} from '../shared'
import DeleteFileCard from './delete-file-card.vue'
import ListFilesCard from './list-files-card.vue'
import RenameFileCard from './rename-file-card.vue'
import ReadFileCard from './read-file-card.vue'
import RestoreFileCard from './restore-file-card.vue'
import SettingsPanel from './settings-panel.vue'
import TurnFilesFooter from './turn-files-footer.vue'
import WriteFileCard from './write-file-card.vue'

export const setup: ClientPluginSetup = (ctx) => {
  ctx.tools.register(LIST_FILES_TOOL_ID, ListFilesCard)
  ctx.tools.register(READ_FILE_TOOL_ID, ReadFileCard)
  ctx.tools.register(WRITE_FILE_TOOL_ID, WriteFileCard)
  ctx.tools.register(RESTORE_FILE_TOOL_ID, RestoreFileCard)
  ctx.tools.register(RENAME_FILE_TOOL_ID, RenameFileCard)
  ctx.tools.register(DELETE_FILE_TOOL_ID, DeleteFileCard)
  // What the turn produced, said once at the end: the cards above are a log, not a result.
  ctx.messageFooter.register(TurnFilesFooter)
  // Files outlive the conversation that wrote them, so managing them belongs on the plugin's page.
  ctx.settingsPanel.register(SettingsPanel)
}
