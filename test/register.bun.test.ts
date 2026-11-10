import { beforeEach, describe, expect, setSystemTime, test } from 'bun:test'

import { register } from '../hooks/register.tsx'

type Handler = (...args: any[]) => any

const handlers = new Map<string, Handler>()
register(((event: string, ...rest: Handler[]) => handlers.set(event, rest.at(-1)!)) as any, {} as any)

let sessions = 0

type Scenario = { model: string; contextTokens: number }

type Verdict = { model: string; effort?: string; placement?: string; agent?: string; toolset?: string; confidence?: number }

function engine(scenario: Scenario, verdict: Verdict, overrides: Record<string, any> = {}) {
  const sessionId = `s${++sessions}`
  const files = new Map<string, string>()
  const statuses: string[] = []
  const vars: Record<string, string> = { HOME: '/home/t', OPENROUTER_API_KEY: 'k', ...overrides.vars }
  const $: any = {
    env: { get: async (key: string) => vars[key] },
    fs: {
      read: async (path: string) => {
        if (files.has(path)) return files.get(path)
        throw new Error('ENOENT')
      },
      write: async (path: string, text: string) => void files.set(path, text),
    },
    session: {
      id: async () => sessionId,
      cwd: async () => '/repo',
      model: async () => scenario.model,
      usage: async () => ({ context: { tokens: scenario.contextTokens } }),
    },
    process: { run: async () => ({ stdout: 'git@github-personal:mxttbennett/x.git', exitCode: 0 }) },
    http: {
      fetch: async () => ({
        ok: true,
        status: 200,
        text: JSON.stringify({
          answers: {
            placement: { choice: verdict.placement ?? 'inline', confidence: verdict.confidence ?? 0.9 },
            model_choice: { choice: verdict.model },
            effort_choice: { choice: verdict.effort ?? 'low' },
            agent_choice: { choice: verdict.agent },
            toolset_choice: { choice: verdict.toolset },
          },
        }),
      }),
    },
    clock: { after: () => {} },
    ui: { status: () => {}, log: (text: string) => void statuses.push(text) },
    ...overrides,
  }
  for (const [path, text] of Object.entries(overrides.files ?? {})) files.set(path, text as string)
  const records = () =>
    [...files.entries()]
      .filter(([path]) => path.includes('/mod/'))
      .flatMap(([, text]) => text.split('\n').filter(Boolean).map(line => JSON.parse(line)))
  return { $, records, scenario, statuses }
}

async function startSession($: any) {
  await handlers.get('session.start')!($, {}, async (e: unknown) => e)
}

async function typedTurn($: any, text: string, turnId: string, seen: { step?: any; submitted?: any } = {}) {
  seen.submitted = await handlers.get('prompt.submit')!($, { text, origin: { kind: 'composer' } }, async (e: unknown) => e)
  await handlers.get('turn.start')!($, { text, turnId }, async (e: unknown) => e)
  const next = (e: any) => {
    seen.step = e
    const stream = (async function* () {
      yield { kind: 'stop', usage: { model: 'claude-served', input_tokens: 10, cache_read_input_tokens: 900, cache_creation_input_tokens: 40, output_tokens: 5 } }
    })()
    return Object.assign(stream, { result: Promise.resolve('done') })
  }
  const run = handlers.get('turn.step')!($, { turnId, index: 0, effort: 'high' }, next)
  for await (const _ of run) void _
  await handlers.get('turn.complete')!($, { turnId }, async (e: unknown) => e)
  return seen.step
}

const applied = (records: () => any[]) => records().filter(r => r.event === 'applied').at(-1)

beforeEach(() => setSystemTime())

describe('inline switching in the mod', () => {
  test('blocks a downgrade on a warm large context', async () => {
    // Arrange
    const { $, records, statuses } = engine({ model: 'opus', contextTokens: 80_000 }, { model: 'haiku' })
    await startSession($)
    // Act
    const step = await typedTurn($, 'rename the variable', 't1')
    // Assert
    expect(step.model).toBeUndefined()
    expect(applied(records)).toMatchObject({ switched: false, downgrade: false, downgradeBlocked: true })
    expect(statuses).toEqual(['jev: staying on opus · haiku skipped, 80k context is cached · low · 0.90'])
  })

  test('applies a downgrade on a small context and records cache creation tokens', async () => {
    // Arrange
    const { $, records, statuses } = engine({ model: 'opus', contextTokens: 5_000 }, { model: 'haiku' })
    await startSession($)
    // Act
    const step = await typedTurn($, 'rename the variable', 't1')
    // Assert
    expect(statuses).toEqual(['jev → haiku · low · 0.90'])
    expect(step.model).toBe('haiku')
    expect(applied(records)).toMatchObject({ switched: true, downgrade: true, downgradeBlocked: false, cacheCreationTokens: 40 })
  })

  test('applies an upgrade on a warm large context', async () => {
    // Arrange
    const { $, records } = engine({ model: 'sonnet', contextTokens: 80_000 }, { model: 'opus' })
    await startSession($)
    // Act
    const step = await typedTurn($, 'redesign the cache layer', 't1')
    // Assert
    expect(step.model).toBe('opus')
    expect(applied(records)).toMatchObject({ switched: true, downgrade: false, downgradeBlocked: false })
  })

  test('applies a downgrade once the cache has gone cold', async () => {
    // Arrange
    const { $, records } = engine({ model: 'opus', contextTokens: 80_000 }, { model: 'haiku' })
    await startSession($)
    setSystemTime(new Date('2026-11-06T10:00:00Z'))
    await typedTurn($, 'first question', 't1')
    setSystemTime(new Date('2026-11-06T10:06:00Z'))
    // Act
    const step = await typedTurn($, 'rename the variable', 't2')
    // Assert
    expect(step.model).toBe('haiku')
    expect(applied(records)).toMatchObject({ downgrade: true, downgradeBlocked: false })
  })
})

describe('regret logging in the mod', () => {
  async function afterDowngrade() {
    const made = engine({ model: 'opus', contextTokens: 5_000 }, { model: 'haiku' })
    await startSession(made.$)
    await typedTurn(made.$, 'rename the variable', 't1')
    return made
  }

  test('logs regret when the prompt after a downgrade is a correction', async () => {
    // Arrange
    const { $, records } = await afterDowngrade()
    // Act
    await typedTurn($, 'no, try again', 't2')
    // Assert
    expect(records().filter(r => r.event === 'regret')).toHaveLength(1)
  })

  test('logs no regret for a follow-up that is not a correction', async () => {
    // Arrange
    const { $, records } = await afterDowngrade()
    // Act
    await typedTurn($, 'now add a test', 't2')
    // Assert
    expect(records().filter(r => r.event === 'regret')).toHaveLength(0)
  })

  test('clears the downgrade flag after one prompt', async () => {
    // Arrange
    const { $, records, scenario } = await afterDowngrade()
    scenario.contextTokens = 80_000
    await typedTurn($, 'now add a test', 't2')
    // Act
    await typedTurn($, 'no, that is wrong', 't3')
    // Assert
    expect(records().filter(r => r.event === 'regret')).toHaveLength(0)
  })

  test('a new session forgets the previous downgrade', async () => {
    // Arrange
    const { $, records } = await afterDowngrade()
    await startSession($)
    // Act
    await typedTurn($, 'no, try again', 't2')
    // Assert
    expect(records().filter(r => r.event === 'regret')).toHaveLength(0)
  })
})

describe('delegation in the mod', () => {
  const actions = (records: () => any[]) => records().filter(r => r.event === 'action').map(r => r.outcome)

  test('a subagent verdict spawns the classifier-picked agent type and tells the model to stop', async () => {
    // Arrange
    const spawns: any[] = []
    const { $, records } = engine({ model: 'opus', contextTokens: 5_000 }, { model: 'haiku', placement: 'subagent', agent: 'Explore' }, {
      agent: { spawn: async (input: any) => (spawns.push(input), { agentId: 'a1', model: 'claude-haiku' }) },
    })
    await startSession($)
    const seen: any = {}
    // Act
    await typedTurn($, 'find every caller of parse', 't1', seen)
    // Assert
    expect(spawns).toEqual([{ prompt: 'find every caller of parse', model: 'haiku', subagentType: 'Explore', description: 'find every caller of parse' }])
    expect(seen.submitted.context).toEqual(['jev-relayer: reply with exactly "jev-relayer: started a subagent (claude-haiku) for this request." and stop; its result arrives when it finishes.'])
    expect(actions(records)).toEqual(['spawned'])
  })

  test('a failed subagent spawn asks the model to delegate instead', async () => {
    // Arrange
    const { $, records } = engine({ model: 'opus', contextTokens: 5_000 }, { model: 'haiku', placement: 'subagent' }, {
      agent: { spawn: async () => { throw new Error('no') } },
    })
    await startSession($)
    const seen: any = {}
    // Act
    await typedTurn($, 'find every caller of parse', 't1', seen)
    // Assert
    expect(seen.submitted.context).toEqual(['jev-relayer: delegate this request to a subagent (model haiku) with the Agent tool, using Explore for read-only searches. Do not do the work in this conversation.'])
    expect(actions(records)).toEqual(['delegated-to-model'])
  })

  test('the result of a spawned subagent comes back as a prompt', async () => {
    // Arrange
    const submitted: string[] = []
    const { $ } = engine({ model: 'opus', contextTokens: 5_000 }, { model: 'haiku', placement: 'subagent' }, {
      agent: { spawn: async () => ({ agentId: 'a1', model: 'claude-haiku' }) },
      prompt: { submit: async ({ text }: any) => void submitted.push(text) },
    })
    await startSession($)
    await typedTurn($, 'find every caller of parse', 't1')
    // Act
    await handlers.get('turn.complete')!($, { turnId: 'x', agentId: 'a1', answer: 'three callers' }, async (e: unknown) => e)
    // Assert
    expect(submitted).toEqual(['jev-relayer: the subagent finished. Its result:\n\nthree callers\n\nTell the user what it found.'])
  })

  test('an approved sibling runs claude --bg with the toolset flags', async () => {
    // Arrange
    const runs: string[][] = []
    const config = JSON.stringify({ toolsets: { lean: { description: 'read-only', claude: { tools: ['Read', 'Grep'] } } } })
    const { $, records } = engine({ model: 'opus', contextTokens: 5_000 }, { model: 'sonnet', placement: 'sibling', toolset: 'lean', confidence: 0.95 }, {
      files: { '/home/t/.config/jev-relayer/config.json': config },
      ui: { status: () => {}, log: () => {}, ask: async () => 'Run in background' },
      process: { run: async (argv: string[]) => (runs.push(argv), { stdout: 'git@github.com:x/y.git', exitCode: 0 }) },
    })
    await startSession($)
    await typedTurn($, 'hello', 't1')
    const seen: any = {}
    // Act
    await typedTurn($, 'clean up the old branches', 't2', seen)
    // Assert
    expect(runs.filter(argv => argv[0] === 'claude')).toEqual([['claude', '--bg', '--model', 'sonnet', '--strict-mcp-config', '--tools', 'Read,Grep', '--', 'clean up the old branches']])
    expect(seen.submitted.context).toEqual(["jev-relayer: the user's request was handed to a background session (sonnet). Reply with one short sentence saying so and stop; do not do the work here."])
    expect(actions(records)).toEqual(['accepted'])
  })

  test('a sibling falls back to a background subagent where the CLI is unavailable', async () => {
    // Arrange
    const spawns: any[] = []
    const { $, records } = engine({ model: 'opus', contextTokens: 5_000 }, { model: 'sonnet', placement: 'sibling', confidence: 0.95 }, {
      ui: { status: () => {}, log: () => {}, ask: async () => 'Run in background' },
      process: { run: async (argv: string[]) => { if (argv[0] === 'claude') throw new Error('ENOENT'); return { stdout: '', exitCode: 0 } } },
      agent: { spawn: async (input: any) => (spawns.push(input), { agentId: 'b1' }) },
    })
    await startSession($)
    await typedTurn($, 'hello', 't1')
    // Act
    await typedTurn($, 'clean up the old branches', 't2')
    // Assert
    expect(spawns).toEqual([{ prompt: 'clean up the old branches', model: 'sonnet', subagentType: 'general-purpose', name: 'jev-sibling', description: 'clean up the old branches', cwd: '/repo' }])
    expect(actions(records)).toEqual(['accepted'])
  })

  test('a declined sibling is not offered again for the next ten prompts', async () => {
    // Arrange
    let asked = 0
    const { $, records } = engine({ model: 'opus', contextTokens: 5_000 }, { model: 'sonnet', placement: 'sibling', confidence: 0.95 }, {
      ui: { status: () => {}, log: () => {}, ask: async () => (asked++, 'Keep here') },
    })
    await startSession($)
    await typedTurn($, 'hello', 't1')
    // Act
    await typedTurn($, 'clean up the old branches', 't2')
    await typedTurn($, 'and the tags', 't3')
    // Assert
    expect(asked).toBe(1)
    expect(actions(records)).toEqual(['declined', 'quiet-after-decline'])
  })

  test('a sibling verdict on the first prompt is not offered', async () => {
    // Arrange
    let asked = 0
    const { $ } = engine({ model: 'opus', contextTokens: 5_000 }, { model: 'sonnet', placement: 'sibling', confidence: 0.95 }, {
      ui: { status: () => {}, log: () => {}, ask: async () => (asked++, 'Run in background') },
    })
    await startSession($)
    const seen: any = {}
    // Act
    await typedTurn($, 'clean up the old branches', 't1', seen)
    // Assert
    expect(asked).toBe(0)
    expect(seen.submitted.context).toBeUndefined()
  })
})

describe('subagent model in the mod', () => {
  const spawn = async ($: any, e: any) => handlers.get('agent.spawn')!($, e, async (x: unknown) => x)

  test('sets the classifier model on an Agent call without one', async () => {
    // Arrange
    const { $, records } = engine({ model: 'opus', contextTokens: 5_000 }, { model: 'haiku' })
    await startSession($)
    // Act
    const out = await spawn($, { prompt: 'list the files' })
    // Assert
    expect(out.model).toBe('haiku')
    await Bun.sleep(0)
    expect(records().filter(r => r.event === 'spawn-model')).toMatchObject([{ picked: 'haiku' }])
  })

  test('leaves an explicit model and a fork alone', async () => {
    // Arrange
    const { $ } = engine({ model: 'opus', contextTokens: 5_000 }, { model: 'haiku' })
    await startSession($)
    expect((await spawn($, { prompt: 'p', model: 'opus' })).model).toBe('opus')
    expect((await spawn($, { prompt: 'p', fork: true })).model).toBeUndefined()
  })
})

describe('provider settings in the mod', () => {
  test('an openai-compat provider sends the key named by its apiKeyEnv', async () => {
    // Arrange
    const headers: any[] = []
    const config = JSON.stringify({
      chain: ['local'],
      providers: { local: { type: 'openai-compat', baseUrl: 'http://pc', model: 'qwen', apiKeyEnv: 'PC_KEY', timeoutMs: 1000 } },
    })
    const { $ } = engine({ model: 'opus', contextTokens: 5_000 }, { model: 'haiku' }, {
      files: { '/home/t/.config/jev-relayer/config.json': config },
      vars: { PC_KEY: 'secret' },
      http: {
        fetch: async (_url: string, init: any) => {
          headers.push(init.headers)
          return { ok: true, status: 200, text: JSON.stringify({ choices: [{ message: { content: '{"placement":"inline","model":"haiku"}' } }] }) }
        },
      },
    })
    await startSession($)
    // Act
    await typedTurn($, 'rename the variable', 't1')
    // Assert
    expect(headers[0].Authorization).toBe('Bearer secret')
  })
})
