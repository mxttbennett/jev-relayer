import { describe, expect, test } from 'bun:test'

import { engine, handlers, startSession, typedTurn } from './mod-harness.ts'

async function subagentStep($: any, agentId: string) {
  let forwarded: any
  const next = (e: any) => {
    forwarded = e
    return Object.assign((async function* () {})(), { result: Promise.resolve('done') })
  }
  for await (const _ of handlers.get('turn.step')!($, { turnId: 's1', index: 0, agentId, effort: 'xhigh' }, next)) void _
  return forwarded
}

describe('model label on spawned subagents', () => {
  test('labels a subagent the relay starts with the model it picked', async () => {
    // Arrange
    const spawns: any[] = []
    const { $ } = engine({ model: 'opus', contextTokens: 5_000 }, { model: 'haiku', placement: 'subagent', agent: 'Explore' }, {
      agent: { spawn: async (input: any) => (spawns.push(input), { agentId: 'a1', model: 'claude-haiku' }) },
    })
    await startSession($)
    // Act
    await typedTurn($, 'find every caller of parse', 't1')
    // Assert
    expect(spawns[0].description).toBe('[haiku · low] find every caller of parse')
  })

  test('sets and labels the effort the relay picks for a subagent', async () => {
    // Arrange
    const spawns: any[] = []
    const { $ } = engine({ model: 'opus', contextTokens: 5_000 }, { model: 'haiku', effort: 'high', placement: 'subagent', agent: 'Explore' }, {
      agent: { spawn: async (input: any) => (spawns.push(input), { agentId: 'a6', model: 'claude-haiku' }) },
    })
    await startSession($)
    // Act
    await typedTurn($, 'find every caller of parse', 't2')
    // Assert
    expect(spawns[0]).toMatchObject({ model: 'haiku', description: '[haiku · high] find every caller of parse' })
    expect((await subagentStep($, 'a6')).effort).toBe('high')
  })

  test('sets the effort the classifier picks on an Agent call\'s turns', async () => {
    // Arrange
    const { $ } = engine({ model: 'opus', contextTokens: 5_000 }, { model: 'haiku' })
    await startSession($)
    // Act
    await handlers.get('agent.spawn')!($, { prompt: 'find every caller of parse', description: 'Find callers' }, async () => ({ agentId: 'a8', model: 'claude-haiku-5-5' }))
    // Assert
    expect((await subagentStep($, 'a8')).effort).toBe('low')
  })

  test('leaves a subagent\'s effort alone once it has finished', async () => {
    // Arrange
    const { $ } = engine({ model: 'opus', contextTokens: 5_000 }, { model: 'haiku' })
    await startSession($)
    await handlers.get('agent.spawn')!($, { prompt: 'find every caller of parse', description: 'Find callers' }, async () => ({ agentId: 'a9', model: 'claude-haiku-5-5' }))
    await handlers.get('turn.complete')!($, { turnId: 's1', agentId: 'a9' }, async (e: unknown) => e)
    // Act
    const step = await subagentStep($, 'a9')
    // Assert
    expect(step.effort).toBe('xhigh')
  })

  test('labels an Agent call with the model the call asks for', async () => {
    // Arrange
    const { $ } = engine({ model: 'opus', contextTokens: 5_000 }, { model: 'sonnet' })
    await startSession($)
    let forwarded: any
    // Act
    await handlers.get('agent.spawn')!($, { prompt: 'p', model: 'sonnet', description: 'Check VM' }, async (e: unknown) => ((forwarded = e), { agentId: 'a2', model: 'claude-sonnet-5-5' }))
    // Assert
    expect(forwarded.description).toBe('[sonnet] Check VM')
  })

  test('labels an Agent call with the model the classifier picks', async () => {
    // Arrange
    const { $ } = engine({ model: 'opus', contextTokens: 5_000 }, { model: 'haiku' })
    await startSession($)
    let forwarded: any
    // Act
    await handlers.get('agent.spawn')!($, { prompt: 'find every caller of parse', description: 'Find callers' }, async (e: unknown) => ((forwarded = e), { agentId: 'a3', model: 'claude-haiku-5-5' }))
    // Assert
    expect(forwarded).toMatchObject({ model: 'haiku', description: '[haiku · low] Find callers' })
  })

  test('does not label a description twice', async () => {
    // Arrange
    const { $ } = engine({ model: 'opus', contextTokens: 5_000 }, { model: 'haiku' })
    await startSession($)
    let forwarded: any
    // Act
    await handlers.get('agent.spawn')!($, { prompt: 'p', model: 'haiku', description: '[haiku] Find callers' }, async (e: unknown) => ((forwarded = e), { agentId: 'a5', model: 'claude-haiku-5-5' }))
    // Assert
    expect(forwarded.description).toBe('[haiku] Find callers')
  })

  test('does not label a description twice when it carries an effort', async () => {
    // Arrange
    const { $ } = engine({ model: 'opus', contextTokens: 5_000 }, { model: 'haiku' })
    await startSession($)
    let forwarded: any
    // Act
    await handlers.get('agent.spawn')!($, { prompt: 'p', model: 'haiku', effort: 'low', description: '[haiku · low] Dry Run Upload' }, async (e: unknown) => ((forwarded = e), { agentId: 'a7', model: 'claude-haiku-5-5' }))
    // Assert
    expect(forwarded.description).toBe('[haiku · low] Dry Run Upload')
  })

  test('leaves the description alone when no model is known', async () => {
    // Arrange
    const { $ } = engine({ model: 'opus', contextTokens: 5_000 }, { model: 'haiku' })
    await startSession($)
    let forwarded: any
    // Act
    await handlers.get('agent.spawn')!($, { prompt: 'p', fork: true, description: 'Fork work' }, async (e: unknown) => ((forwarded = e), { agentId: 'a4', model: 'claude-opus-5-5' }))
    // Assert
    expect(forwarded.description).toBe('Fork work')
  })
})
