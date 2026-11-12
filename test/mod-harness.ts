import { register } from '../hooks/register.tsx'

type Handler = (...args: any[]) => any

export const handlers = new Map<string, Handler>()
register(((event: string, ...rest: Handler[]) => handlers.set(event, rest.at(-1)!)) as any, {} as any)

let sessions = 0

type Scenario = { model: string; contextTokens: number }

type Verdict = { model: string; effort?: string; placement?: string; agent?: string; toolset?: string; confidence?: number }

export function engine(scenario: Scenario, verdict: Verdict, overrides: Record<string, any> = {}) {
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

export async function startSession($: any) {
  await handlers.get('session.start')!($, {}, async (e: unknown) => e)
}

export async function typedTurn($: any, text: string, turnId: string, seen: { step?: any; submitted?: any } = {}) {
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
