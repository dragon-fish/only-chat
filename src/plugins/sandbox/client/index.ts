import type { ClientPluginSetup } from '@/client/plugins/host'
import { SANDBOX_EXEC_TOOL_ID, SANDBOX_EXPORT_TOOL_ID, SANDBOX_IMPORT_TOOL_ID, SANDBOX_WRITE_FILE_TOOL_ID, SANDBOX_EDIT_FILE_TOOL_ID } from '../shared'
import ExecCard from './exec-card.vue'
import ExportCard from './export-card.vue'
import ImportCard from './import-card.vue'
import WriteFileCard from './write-file-card.vue'
import EditFileCard from './edit-file-card.vue'

export const setup: ClientPluginSetup = (ctx) => {
  ctx.tools.register(SANDBOX_EXEC_TOOL_ID, ExecCard)
  ctx.tools.register(SANDBOX_WRITE_FILE_TOOL_ID, WriteFileCard)
  ctx.tools.register(SANDBOX_EDIT_FILE_TOOL_ID, EditFileCard)
  ctx.tools.register(SANDBOX_IMPORT_TOOL_ID, ImportCard)
  ctx.tools.register(SANDBOX_EXPORT_TOOL_ID, ExportCard)
}
