import { describe, expect, test } from 'bun:test'

import { engine, handlers, startSession, typedTurn } from './mod-harness.ts'

describe('band for the agent in view', () => {
  const bandOn = { '/home/t/.config/jev-relayer/config.json': JSON.stringify({ band: { enabled: true } }) }
  const passed = Symbol('passed')
  const render = ($: any, agentId?: string) =>
    handlers.get('ui.render')!($, { component: 'AbovePrompt', props: { view: agentId ? { agentId } : {} } }, async () => passed)
  const textOf = (node: any): string =>
    node == null || typeof node === 'boolean' ? '' : typeof node === 'string' ? node : Array.isArray(node) ? node.map(textOf).join('') : textOf(node.props?.children)
  const ui = { status: () => {}, log: () => {}, resolve: () => ({ Box: 'Box', Button: 'Button', Text: 'Text' }) }
  ;(globalThis as any).h = (type: unknown, props: object | null, ...children: unknown[]) => ({ type, props: { ...props, children } })

  test('names the model of a subagent the relay started', async () => {
    // Arrange
    const { $ } = engine({ model: 'opus', contextTokens: 5_000 }, { model: 'haiku', placement: 'subagent' }, {
      files: bandOn,
      ui,
      agent: { spawn: async () => ({ agentId: 'a1', model: 'claude-haiku-5-5' }) },
    })
    await startSession($)
    await typedTurn($, 'find every caller of parse', 't1')
    // Act
    const band = await render($, 'a1')
    // Assert
    expect(textOf(band).trim()).toBe('jev: subagent · claude-haiku-5-5')
  })

  test('names the model of a subagent the Agent tool started', async () => {
    // Arrange
    const { $ } = engine({ model: 'opus', contextTokens: 5_000 }, { model: 'sonnet' }, { files: bandOn, ui })
    await startSession($)
    await handlers.get('agent.spawn')!($, { prompt: 'p', model: 'sonnet' }, async () => ({ agentId: 'a2', model: 'claude-sonnet-5-5' }))
    // Act
    const band = await render($, 'a2')
    // Assert
    expect(textOf(band).trim()).toBe('jev: subagent · claude-sonnet-5-5')
  })

  test('passes an agent it did not see start through', async () => {
    // Arrange
    const { $ } = engine({ model: 'opus', contextTokens: 5_000 }, { model: 'haiku' }, { files: bandOn, ui })
    await startSession($)
    // Act
    const band = await render($, 'unknown')
    // Assert
    expect(band).toBe(passed)
  })

  test('keeps the session verdict in the main view', async () => {
    // Arrange
    const { $ } = engine({ model: 'opus', contextTokens: 5_000 }, { model: 'haiku', placement: 'subagent' }, {
      files: bandOn,
      ui,
      agent: { spawn: async () => ({ agentId: 'a1', model: 'claude-haiku-5-5' }) },
    })
    await startSession($)
    await typedTurn($, 'find every caller of parse', 't1')
    // Act
    const band = await render($)
    // Assert
    expect(textOf(band)).toContain('jev: subagent · haiku')
  })

  test('stays off while the band is disabled', async () => {
    // Arrange
    const { $ } = engine({ model: 'opus', contextTokens: 5_000 }, { model: 'haiku', placement: 'subagent' }, {
      ui,
      agent: { spawn: async () => ({ agentId: 'a1', model: 'claude-haiku-5-5' }) },
    })
    await startSession($)
    await typedTurn($, 'find every caller of parse', 't1')
    // Act
    const band = await render($, 'a1')
    // Assert
    expect(band).toBe(passed)
  })

  test('forgets agents from an earlier session', async () => {
    // Arrange
    const { $ } = engine({ model: 'opus', contextTokens: 5_000 }, { model: 'sonnet' }, { files: bandOn, ui })
    await startSession($)
    await handlers.get('agent.spawn')!($, { prompt: 'p', model: 'sonnet' }, async () => ({ agentId: 'a2', model: 'claude-sonnet-5-5' }))
    await startSession($)
    // Act
    const band = await render($, 'a2')
    // Assert
    expect(band).toBe(passed)
  })
})
