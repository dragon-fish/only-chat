/** Synthetic public-protocol data. No captured credentials or private reasoning are used. */
export const deepseekReasoningItem = {
  id: 'rs_fixture', type: 'reasoning', status: 'completed',
  summary: [{ type: 'summary_text', text: 'fixture summary' }],
  content: [{ type: 'reasoning_text', text: 'complete reasoning' }],
  encrypted_content: 'fixture-encrypted-state',
} as const

const functionCall = {
  id: 'fc_fixture', type: 'function_call', status: 'completed', call_id: 'call_fixture',
  name: 'lookup', arguments: '{"q":"fixture"}',
} as const

const message = {
  id: 'msg_fixture', type: 'message', status: 'completed', role: 'assistant',
  content: [{ type: 'output_text', text: 'fixture answer', annotations: [] }],
} as const

export const deepseekResponsesBody = {
  id: 'resp_fixture', object: 'response', model: 'deepseek-fixture', created_at: 1,
  status: 'completed', error: null, incomplete_details: null,
  output: [deepseekReasoningItem, functionCall, message],
  usage: {
    input_tokens: 11, input_tokens_details: { cached_tokens: 3 },
    output_tokens: 9, output_tokens_details: { reasoning_tokens: 6 }, total_tokens: 20,
  },
} as const

export function deepseekResponsesStream({ omitReasoningContent = false } = {}): Response {
  const reasoningItem = omitReasoningContent
    ? { ...deepseekReasoningItem, content: undefined }
    : deepseekReasoningItem
  const responseBody = { ...deepseekResponsesBody, output: [reasoningItem, functionCall, message] }
  const events = [
    { type: 'response.created', response: { ...responseBody, status: 'in_progress', output: [], usage: null } },
    { type: 'response.output_item.added', output_index: 0, item: { id: 'rs_fixture', type: 'reasoning', status: 'in_progress', summary: [] } },
    { type: 'response.reasoning_summary_text.delta', output_index: 0, item_id: 'rs_fixture', summary_index: 0, delta: 'fixture summary' },
    { type: 'response.reasoning_text.delta', output_index: 0, item_id: 'rs_fixture', content_index: 0, delta: 'complete ' },
    { type: 'response.reasoning_text.delta', output_index: 0, item_id: 'rs_fixture', content_index: 0, delta: 'reasoning' },
    { type: 'response.output_item.done', output_index: 0, item: reasoningItem },
    { type: 'response.output_item.added', output_index: 1, item: { ...functionCall, status: 'in_progress', arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'fc_fixture', delta: '{"q":"fixture"}' },
    { type: 'response.function_call_arguments.done', output_index: 1, item_id: 'fc_fixture', arguments: functionCall.arguments },
    { type: 'response.output_item.done', output_index: 1, item: functionCall },
    { type: 'response.output_item.added', output_index: 2, item: { ...message, status: 'in_progress', content: [] } },
    { type: 'response.output_text.delta', output_index: 2, item_id: 'msg_fixture', content_index: 0, delta: 'fixture answer' },
    { type: 'response.output_item.done', output_index: 2, item: message },
    { type: 'response.completed', response: responseBody },
  ]
  return new Response(events.map((event, sequence_number) => `data: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join('') + 'data: [DONE]\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  })
}
