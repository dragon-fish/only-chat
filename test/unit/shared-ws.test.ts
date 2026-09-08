import { describe, expect, it } from 'vitest'
import { encodeEvent, parseCommand, WsEventSchema } from '@/shared/ws'

describe('ws protocol', () => {
  it('parses a send command with a new session', () => {
    const cmd = parseCommand(JSON.stringify({
      type: 'send', request_id: 'r1', session_id: null, parent_id: null,
      parts: [{ type: 'text', text: 'hi' }], provider_id: 1, model_id: 'gpt-5.1',
    }))
    expect(cmd.type).toBe('send')
    if (cmd.type === 'send') expect(cmd.session_id).toBeNull()
  })

  it('rejects a command without type', () => {
    expect(() => parseCommand('{"session_id":1}')).toThrow()
  })

  it('round-trips a delta event', () => {
    const raw = encodeEvent({ type: 'message.delta', message_id: 5, part_index: 0, kind: 'text', delta: 'he' })
    expect(WsEventSchema.parse(JSON.parse(raw))).toEqual({
      type: 'message.delta', message_id: 5, part_index: 0, kind: 'text', delta: 'he',
    })
  })

  it('settings.update accepts a partial plugins map', () => {
    const cmd = parseCommand(JSON.stringify({ type: 'settings.update', settings: { plugins: { foo: true } } }))
    expect(cmd.type).toBe('settings.update')
  })

  it('send carries nullable project_id, system_prompt, params and a session model override for first-message session init', () => {
    const cmd = parseCommand(JSON.stringify({
      type: 'send', session_id: null, parent_id: null, parts: [{ type: 'text', text: 'hi' }],
      provider_id: 1, model_id: 'gpt-5.1', project_id: 3, system_prompt: 'be terse',
      params: { reasoning_enabled: true, reasoning_effort: null },
      session_provider_id: 2, session_model_id: 'gpt-5.1-mini',
    }))
    expect(cmd.type).toBe('send')
    if (cmd.type === 'send') {
      expect(cmd.project_id).toBe(3)
      expect(cmd.system_prompt).toBe('be terse')
      expect(cmd.params).toEqual({ reasoning_enabled: true, reasoning_effort: null })
      expect(cmd.session_provider_id).toBe(2)
      expect(cmd.session_model_id).toBe('gpt-5.1-mini')
    }
  })

  it('send omits all session-init fields, including the session model override, when not provided', () => {
    const cmd = parseCommand(JSON.stringify({
      type: 'send', session_id: null, parent_id: null, parts: [{ type: 'text', text: 'hi' }],
      provider_id: 1, model_id: 'gpt-5.1',
    }))
    expect(cmd.type).toBe('send')
    if (cmd.type === 'send') {
      expect(cmd.project_id).toBeUndefined()
      expect(cmd.system_prompt).toBeUndefined()
      expect(cmd.params).toBeUndefined()
      expect(cmd.session_provider_id).toBeUndefined()
      expect(cmd.session_model_id).toBeUndefined()
    }
  })

  it('parses project.create/update/delete commands', () => {
    const create = parseCommand(JSON.stringify({ type: 'project.create', name: 'Design', icon_attachment_id: null }))
    expect(create.type).toBe('project.create')
    if (create.type === 'project.create') expect(create.icon_attachment_id).toBeNull()
    const update = parseCommand(JSON.stringify({
      type: 'project.update', project_id: 1, name: 'Design v2', system_prompt: null,
    }))
    expect(update.type).toBe('project.update')
    const del = parseCommand(JSON.stringify({ type: 'project.delete', project_id: 1 }))
    expect(del.type).toBe('project.delete')
  })

  it('session.update accepts a nullable project_id', () => {
    const cmd = parseCommand(JSON.stringify({ type: 'session.update', session_id: 1, project_id: null }))
    expect(cmd.type).toBe('session.update')
    if (cmd.type === 'session.update') expect(cmd.project_id).toBeNull()
  })

  it('carries a first-send tool snapshot and a later session update', () => {
    const first = parseCommand(JSON.stringify({
      type: 'send', session_id: null, parent_id: null, parts: [{ type: 'text', text: 'hi' }],
      provider_id: 1, model_id: 'gpt', tools: ['ask_user'],
    }))
    expect(first.type === 'send' && first.tools).toEqual(['ask_user'])
    const update = parseCommand(JSON.stringify({ type: 'session.update', session_id: 1, tools: ['ask_user'] }))
    expect(update.type === 'session.update' && update.tools).toEqual(['ask_user'])
  })

  it('parses correlated tool response and continuation commands', () => {
    const respond = parseCommand(JSON.stringify({
      type: 'tool.respond', request_id: 'answer-1', message_id: 7, call_id: 'call-1',
      result: { status: 'answered', answers: [{ id: 'framework', value: 'Vue' }] },
    }))
    expect(respond).toEqual({
      type: 'tool.respond', request_id: 'answer-1', message_id: 7, call_id: 'call-1',
      result: { status: 'answered', answers: [{ id: 'framework', value: 'Vue' }] },
    })
    expect(parseCommand(JSON.stringify({
      type: 'tool.continue', request_id: 'continue-1', message_id: 7,
    }))).toEqual({ type: 'tool.continue', request_id: 'continue-1', message_id: 7 })
  })

  it('rejects malformed tool response envelopes at the wire boundary', () => {
    expect(() => parseCommand(JSON.stringify({
      type: 'tool.respond', request_id: 'answer-1', message_id: 7, call_id: 'call-1',
      result: { status: 'answered', answers: [] },
    }))).toThrow()
    expect(() => parseCommand(JSON.stringify({
      type: 'tool.continue', message_id: 7,
    }))).toThrow()
  })

  it('round-trips project.created/updated/deleted events', () => {
    const project = {
      id: 1, user_id: 1, name: 'Design', icon_attachment_id: null, system_prompt: null, provider_id: null,
      model_id: null, params: null, created_at: 1, updated_at: 1,
    }
    expect(WsEventSchema.parse({ type: 'project.created', project })).toEqual({ type: 'project.created', project })
    expect(WsEventSchema.parse({ type: 'project.updated', project })).toEqual({ type: 'project.updated', project })
    expect(WsEventSchema.parse({ type: 'project.deleted', project_id: 1 })).toEqual({ type: 'project.deleted', project_id: 1 })
  })
})
