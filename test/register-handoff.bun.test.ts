import { beforeEach, describe, expect, setSystemTime, test } from 'bun:test'

import { engine, handlers, startSession } from './mod-harness.ts'

beforeEach(() => setSystemTime())

const actions = (records: () => any[]) => records().filter(r => r.event === 'action').map(r => r.outcome)

describe('after the relay spawned a subagent', () => {
  const relayed = async () => {
    const env = engine({ model: 'opus', contextTokens: 5_000 }, { model: 'haiku', placement: 'subagent', agent: 'Explore' }, {
      agent: { spawn: async () => ({ agentId: 'a1', model: 'claude-haiku' }) },
      prompt: { submit: async () => undefined },
    })
    await startSession(env.$)
    await handlers.get('prompt.submit')!(env.$, { text: 'find every caller of parse', origin: { kind: 'composer' } }, async (e: unknown) => e)
    return env
  }
  const spawn = ($: any, e: any) => handlers.get('agent.spawn')!($, e, async (x: unknown) => x)

  test('denies the main loop its own Agent call in the same turn', async () => {
    // Arrange
    const { $, records } = await relayed()
    // Act
    const out = await spawn($, { prompt: 'search for callers', subagentType: 'Explore', fork: false })
    // Assert
    expect(out.deny).toContain('jev-relayer already started a subagent')
    await Bun.sleep(0)
    expect(actions(records)).toEqual(['spawned', 'duplicate-denied'])
  })

  test('lets a subagent spawn its own agents', async () => {
    // Arrange
    const { $ } = await relayed()
    // Act
    const out = await spawn($, { prompt: 'search for callers', parentAgentId: 'a1', model: 'haiku', fork: false })
    // Assert
    expect(out.deny).toBeUndefined()
  })

  test('allows Agent calls again once the main turn completes', async () => {
    // Arrange
    const { $ } = await relayed()
    await handlers.get('turn.complete')!($, { turnId: 't1' }, async (e: unknown) => e)
    // Act
    const out = await spawn($, { prompt: 'search for callers', model: 'haiku', fork: false })
    // Assert
    expect(out.deny).toBeUndefined()
  })

  const call = ($: any, e: any) => handlers.get('tool.call')!($, { tool_use_id: 'u1', ...e }, async (x: unknown) => x)

  test('denies the main loop its other tools in the same turn', async () => {
    // Arrange
    const { $, records } = await relayed()
    // Act
    const bash = await call($, { tool: 'Bash', command: 'ls' })
    const skill = await call($, { tool: 'Skill', skill: 'pr-screenshots' })
    // Assert
    expect(bash.deny).toContain('jev-relayer handed this request to a subagent')
    expect(skill.deny).toContain('jev-relayer handed this request to a subagent')
    await Bun.sleep(0)
    expect(actions(records)).toEqual(['spawned', 'tool-denied', 'tool-denied'])
  })

  test("lets the subagent's own tools through", async () => {
    // Arrange
    const { $ } = await relayed()
    // Act
    const out = await call($, { tool: 'Bash', command: 'ls', agentId: 'a1' })
    // Assert
    expect(out.deny).toBeUndefined()
  })

  test('leaves the Agent tool to the agent.spawn guard', async () => {
    // Arrange
    const { $ } = await relayed()
    // Act
    const out = await call($, { tool: 'Agent', prompt: 'x' })
    // Assert
    expect(out.deny).toBeUndefined()
  })

  test('allows tools again once the main turn completes', async () => {
    // Arrange
    const { $ } = await relayed()
    await handlers.get('turn.complete')!($, { turnId: 't1' }, async (e: unknown) => e)
    // Act
    const out = await call($, { tool: 'Bash', command: 'ls' })
    // Assert
    expect(out.deny).toBeUndefined()
  })

  const step = ($: any, stopReason: string, agentId?: string) => {
    const next = () => Object.assign((async function* () { yield { kind: 'stop', stopReason, usage: null } })(), { result: Promise.resolve('done') })
    return (async () => { for await (const _ of handlers.get('turn.step')!($, { turnId: 't1', index: 0, agentId }, next)) void _ })()
  }

  test('allows tools again when the main step ends its turn, as after a stop-hook continuation', async () => {
    // Arrange
    const { $ } = await relayed()
    // Act
    await step($, 'end_turn')
    const out = await call($, { tool: 'Bash', command: 'ls' })
    // Assert
    expect(out.deny).toBeUndefined()
  })

  test('keeps denying tools when the main step stops to run tools', async () => {
    // Arrange
    const { $ } = await relayed()
    // Act
    await step($, 'tool_use')
    const out = await call($, { tool: 'Bash', command: 'ls' })
    // Assert
    expect(out.deny).toContain('jev-relayer handed this request to a subagent')
  })

  test("keeps denying tools when the subagent's own step stops", async () => {
    // Arrange
    const { $ } = await relayed()
    // Act
    await step($, 'end_turn', 'a1')
    const out = await call($, { tool: 'Bash', command: 'ls' })
    // Assert
    expect(out.deny).toContain('jev-relayer handed this request to a subagent')
  })

  test('allows tools again once the subagent result arrives', async () => {
    // Arrange
    const { $ } = await relayed()
    await handlers.get('turn.complete')!($, { turnId: 't2', agentId: 'a1', answer: 'found it' }, async (e: unknown) => e)
    // Act
    const out = await call($, { tool: 'Bash', command: 'ls' })
    // Assert
    expect(out.deny).toBeUndefined()
  })

  test('words the denial as a status, not an instruction to stop', async () => {
    // Arrange
    const { $ } = await relayed()
    // Act
    const out = await call($, { tool: 'Bash', command: 'ls' })
    // Assert
    expect(out.deny).not.toContain('reply in one line and stop')
    expect(out.deny).toContain('running it now')
  })

  test('allows tools again in a new session', async () => {
    // Arrange
    const { $ } = await relayed()
    await startSession($)
    // Act
    const out = await call($, { tool: 'Bash', command: 'ls' })
    // Assert
    expect(out.deny).toBeUndefined()
  })
})
