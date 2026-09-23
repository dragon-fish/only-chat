import type { Message, Project, Conversation } from '@/shared/models'

export type ExportFormat = 'markdown' | 'json'
export interface ExportContext { conversation: Conversation; project?: Project; messages: Message[]; attachmentUrl: (id: number) => string }
interface ConversationExporter { extension: string; mime: string; serialize: (context: ExportContext) => string }

function partMarkdown(message: Message, attachmentUrl: (id: number) => string): string {
  return message.parts.map(part => {
    if (part.type === 'text') return part.text
    if (part.type === 'reasoning') return `<details>\n<summary>思考过程</summary>\n\n${part.text}\n\n</details>`
    if (part.type === 'image') return `![图片](${attachmentUrl(part.attachment_id)})`
    if (part.type === 'task_notification') return `> 后台任务（${part.status}）：${part.text}`
    if (part.type === 'tool_call') return `**工具调用：${part.name}**\n\n\`\`\`json\n${typeof part.args === 'string' ? part.args : JSON.stringify(part.args, null, 2)}\n\`\`\``
    return `**工具结果：${part.name}**\n\n\`\`\`json\n${typeof part.content === 'string' ? part.content : JSON.stringify(part.content, null, 2)}\n\`\`\``
  }).join('\n\n')
}

export const conversationExporters: Record<ExportFormat, ConversationExporter> = {
  markdown: {
    extension: 'md', mime: 'text/markdown;charset=utf-8',
    serialize: context => [
      `# ${context.conversation.title}`,
      context.project ? `Project: ${context.project.name}` : '',
      ...context.messages.map(message => `## ${message.role === 'user' ? '用户' : '助手'}\n\n${partMarkdown(message, context.attachmentUrl)}`),
    ].filter(Boolean).join('\n\n'),
  },
  json: {
    extension: 'json', mime: 'application/json;charset=utf-8',
    serialize: context => JSON.stringify({ version: 1, conversation: context.conversation, project: context.project ?? null, messages: context.messages }, null, 2),
  },
}

function safeFilename(title: string) { return title.replace(/[\\/:*?"<>|\u0000-\u001F]/g, '_').trim() || 'conversation' }

export function conversationExport(format: ExportFormat, context: ExportContext) {
  const exporter = conversationExporters[format]
  const url = URL.createObjectURL(new Blob([exporter.serialize(context)], { type: exporter.mime }))
  const link = document.createElement('a')
  link.href = url
  link.download = `${safeFilename(context.conversation.title)}.${exporter.extension}`
  link.click()
  URL.revokeObjectURL(url)
}
