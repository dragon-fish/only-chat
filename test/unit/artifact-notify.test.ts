import { describe, expect, it } from 'vitest'
import { toolRunNotification } from '@/server/plugins/artifacts/notify'

describe('toolRunNotification', () => {
  it('names every output by asset and carries its attachment id, never the id in the text', () => {
    const outputs = [{ attachmentId: 31, sha256: '5c2e8f10'.padEnd(64, '1') }, { attachmentId: 32, sha256: '9a01d3c4'.padEnd(64, '2') }]
    expect(toolRunNotification({ id: 12, status: 'completed', error: null, tool_call_id: 'call_1' }, outputs))
      .toEqual({
        type: 'task_notification', task_id: 'image_run:12', plugin_id: 'image_generation', tool_call_id: 'call_1',
        status: 'completed', text: 'Generated 2 image(s): asset:5c2e8f10, asset:9a01d3c4', attachments: [31, 32],
      })
  })

  it('carries the provider error on failure', () => {
    const error = 'Images API request failed: 400 at /images/generations (moderation_blocked): Your request was rejected by the safety system.'
    expect(toolRunNotification({ id: 12, status: 'failed', error, tool_call_id: 'call_1' }, []))
      .toMatchObject({ status: 'failed', text: `Image generation failed: ${error}` })
  })

  it('reports a cancellation', () => {
    expect(toolRunNotification({ id: 12, status: 'cancelled', error: null, tool_call_id: 'call_1' }, []))
      .toMatchObject({ status: 'cancelled', text: 'Cancelled by the user.' })
  })
})
