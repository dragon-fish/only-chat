import { describe, expect, it } from 'vitest'
import { resolveEffectiveConfig } from '@/server/plugins/hub/effective-config'
import type { ProjectRow, SessionRow } from '@/server/db/schema'

function session(over: Partial<SessionRow> = {}): SessionRow {
  return {
    id: 1, user_id: 1, project_id: null, title: 't', head_message_id: null,
    provider_id: null, model_id: null, system_prompt: null, params: null,
    created_at: 0, updated_at: 0, archived_at: null, ...over,
  }
}

function project(over: Partial<ProjectRow> = {}): ProjectRow {
  return {
    id: 7, user_id: 1, name: 'p', system_prompt: null,
    provider_id: null, model_id: null, params: null, created_at: 0, updated_at: 0, ...over,
  }
}

const fallbackModel = { provider_id: 9, model_id: 'fallback' }

describe('resolveEffectiveConfig', () => {
  it('joins both prompts, prefers the session model, and merges params field by field', () => {
    const p = project({
      system_prompt: 'project prompt',
      provider_id: 3,
      model_id: 'project-model',
      params: { temperature: 0.4, top_p: 0.2, reasoning_enabled: false, reasoning_effort: 'high' },
    })
    const s = session({
      project_id: p.id,
      system_prompt: 'session prompt',
      provider_id: 2,
      model_id: 'session-model',
      params: { top_p: 0.9, reasoning_enabled: true, reasoning_effort: null },
    })
    expect(resolveEffectiveConfig({ session: s, project: p, fallbackModel })).toEqual({
      systemPrompt: 'project prompt\n\nsession prompt',
      model: { provider_id: 2, model_id: 'session-model', source: 'session' },
      params: { temperature: 0.4, top_p: 0.9, reasoning_enabled: true, reasoning_effort: null },
    })
  })

  // ---- system prompt

  it('keeps a blank-but-present prompt byte-identical on either side', () => {
    expect(resolveEffectiveConfig({ session: session({ system_prompt: '' }), project: project({ system_prompt: '' }), fallbackModel }).systemPrompt).toBe('\n\n')
    expect(resolveEffectiveConfig({ session: session({ system_prompt: '' }), project: project({ system_prompt: 'p' }), fallbackModel }).systemPrompt).toBe('p\n\n')
    expect(resolveEffectiveConfig({ session: session({ system_prompt: '  keep me  ' }), project: project({ system_prompt: ' P ' }), fallbackModel }).systemPrompt).toBe(' P \n\n  keep me  ')
    expect(resolveEffectiveConfig({ session: session({ system_prompt: '' }), fallbackModel }).systemPrompt).toBe('')
  })

  it('emits only the present side, and null when neither side has a prompt', () => {
    expect(resolveEffectiveConfig({ session: session({ system_prompt: 'only session' }), project: project(), fallbackModel }).systemPrompt).toBe('only session')
    expect(resolveEffectiveConfig({ session: session(), project: project({ system_prompt: 'only project' }), fallbackModel }).systemPrompt).toBe('only project')
    expect(resolveEffectiveConfig({ session: session(), project: project(), fallbackModel }).systemPrompt).toBeNull()
    expect(resolveEffectiveConfig({ session: session(), fallbackModel }).systemPrompt).toBeNull()
  })

  // ---- model precedence

  it('falls through to the Project default when the session has no override', () => {
    const p = project({ provider_id: 3, model_id: 'project-model' })
    expect(resolveEffectiveConfig({ session: session({ project_id: p.id }), project: p, fallbackModel }).model)
      .toEqual({ provider_id: 3, model_id: 'project-model', source: 'project' })
  })

  it('falls through to the command model when neither layer specifies one', () => {
    expect(resolveEffectiveConfig({ session: session(), project: project(), fallbackModel }).model)
      .toEqual({ provider_id: 9, model_id: 'fallback', source: 'command' })
    expect(resolveEffectiveConfig({ session: session(), fallbackModel }).model)
      .toEqual({ provider_id: 9, model_id: 'fallback', source: 'command' })
  })

  it('treats a half-specified override as no override', () => {
    const p = project({ provider_id: 3, model_id: 'project-model' })
    expect(resolveEffectiveConfig({ session: session({ provider_id: 2, model_id: null }), project: p, fallbackModel }).model)
      .toEqual({ provider_id: 3, model_id: 'project-model', source: 'project' })
    expect(resolveEffectiveConfig({ session: session(), project: project({ provider_id: 3, model_id: null }), fallbackModel }).model)
      .toEqual({ provider_id: 9, model_id: 'fallback', source: 'command' })
  })

  it('reports no model when no layer supplies one', () => {
    expect(resolveEffectiveConfig({ session: session(), project: project() }).model).toBeNull()
  })

  // ---- params

  it('overrides with falsy session values rather than dropping them', () => {
    const p = project({ params: { temperature: 0.7, top_p: 0.5, max_tokens: 100 } })
    const s = session({ params: { temperature: 0, max_tokens: 1 } })
    expect(resolveEffectiveConfig({ session: s, project: p, fallbackModel }).params)
      .toEqual({ temperature: 0, top_p: 0.5, max_tokens: 1 })
  })

  it('lets the session disable reasoning a Project enabled', () => {
    const p = project({ params: { reasoning_enabled: true, reasoning_effort: 'high' } })
    const s = session({ params: { reasoning_enabled: false } })
    expect(resolveEffectiveConfig({ session: s, project: p, fallbackModel }).params)
      .toEqual({ reasoning_enabled: false, reasoning_effort: 'high' })
  })

  it('keeps explicit Auto (null effort) distinct from inheriting the effort', () => {
    const p = project({ params: { reasoning_enabled: true, reasoning_effort: 'high' } })
    // Explicit Auto: the session says `null`, which must win over the Project's strength.
    expect(resolveEffectiveConfig({ session: session({ params: { reasoning_effort: null } }), project: p, fallbackModel }).params)
      .toEqual({ reasoning_enabled: true, reasoning_effort: null })
    // Inherit: the session omits the field entirely, so the Project's strength survives.
    expect(resolveEffectiveConfig({ session: session({ params: { temperature: 0.1 } }), project: p, fallbackModel }).params)
      .toEqual({ reasoning_enabled: true, reasoning_effort: 'high', temperature: 0.1 })
  })

  it('leaves an unset field absent rather than materializing it as undefined', () => {
    const params = resolveEffectiveConfig({ session: session({ params: { temperature: 0.1 } }), project: project(), fallbackModel }).params
    expect('reasoning_effort' in params).toBe(false)
    expect('reasoning_enabled' in params).toBe(false)
  })

  it('returns an empty params object when neither layer has params', () => {
    expect(resolveEffectiveConfig({ session: session(), project: project(), fallbackModel }).params).toEqual({})
  })

  it('does not mutate its inputs', () => {
    const p = project({ params: { temperature: 0.7 }, system_prompt: 'P' })
    const s = session({ params: { top_p: 0.3 }, system_prompt: 'S' })
    const first = resolveEffectiveConfig({ session: s, project: p, fallbackModel })
    const second = resolveEffectiveConfig({ session: s, project: p, fallbackModel })
    expect(first).toEqual(second)
    expect(p.params).toEqual({ temperature: 0.7 })
    expect(s.params).toEqual({ top_p: 0.3 })
  })
})
