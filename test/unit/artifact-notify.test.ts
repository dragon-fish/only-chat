import { describe, expect, it } from 'vitest'
import { toolRunNotification } from '@/server/plugins/artifacts/notify'

describe('toolRunNotification', () => {
  it('lists every output path on success', () => {
    expect(toolRunNotification({ id: 12, status: 'completed', error: null, tool_call_id: 'call_1' }, [{ id: 31, mime: 'image/png' }, { id: 32, mime: 'image/webp' }]))
      .toEqual({
        type: 'task_notification', task_id: 'image_run:12', plugin_id: 'image_generation', tool_call_id: 'call_1',
        status: 'completed', text: 'Generated 2 image(s): /artifacts/31.png, /artifacts/32.webp',
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
