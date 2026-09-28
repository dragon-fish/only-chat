import type { ClientPluginSetup } from '@/client/plugins/host'
import {
  DELETE_FILE_TOOL_ID, EDIT_FILE_TOOL_ID, LIST_FILES_TOOL_ID, PREVIEW_FILE_TOOL_ID, READ_FILE_TOOL_ID,
  RENAME_FILE_TOOL_ID, RESTORE_FILE_TOOL_ID, WRITE_FILE_TOOL_ID,
} from '../shared'
import AnalyzeFileCard from './analyze-file-card.vue'
import { ANALYZE_FILE_TOOL_ID } from '@/shared/plugins'
import DeleteFileCard from './delete-file-card.vue'
import EditFileCard from './edit-file-card.vue'
import FilesTab from './files-tab.vue'
import ListFilesCard from './list-files-card.vue'
import PreviewFileCard from './preview-file-card.vue'
import RenameFileCard from './rename-file-card.vue'
import ReadFileCard from './read-file-card.vue'
import RestoreFileCard from './restore-file-card.vue'
import SettingsPanel from './settings-panel.vue'
import TurnFilesFooter from './turn-files-footer.vue'
import WriteFileCard from './write-file-card.vue'

export const setup: ClientPluginSetup = (ctx) => {
  ctx.tools.register(ANALYZE_FILE_TOOL_ID, AnalyzeFileCard)
  ctx.tools.register(LIST_FILES_TOOL_ID, ListFilesCard)
  ctx.tools.register(READ_FILE_TOOL_ID, ReadFileCard)
  ctx.tools.register(WRITE_FILE_TOOL_ID, WriteFileCard)
  ctx.tools.register(EDIT_FILE_TOOL_ID, EditFileCard)
  ctx.tools.register(RESTORE_FILE_TOOL_ID, RestoreFileCard)
  ctx.tools.register(RENAME_FILE_TOOL_ID, RenameFileCard)
  ctx.tools.register(DELETE_FILE_TOOL_ID, DeleteFileCard)
  ctx.tools.register(PREVIEW_FILE_TOOL_ID, PreviewFileCard)
  // What the turn produced, said once at the end: the cards above are a log, not a result.
  ctx.messageFooter.register(TurnFilesFooter)
  // Files outlive the conversation that wrote them, so managing them belongs on the plugin's page.
  ctx.settingsPanel.register(SettingsPanel)
  // The files of the open conversation, beside the chat rather than in a dialog over it.
  ctx.workspacePanel.register(FilesTab)
}
