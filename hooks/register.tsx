import type { EngineInterface, Register } from 'claude-code'

import { isEnabled, resolveConfig } from '../src/defaults.mjs'
import { parseEnv } from '../src/envfile.mjs'
import { claudeToolsetFlags } from '../src/toolsets.mjs'
import { createProviders } from '../src/providers.mjs'
import { decisionLabel, isChange, sendNotification, transcriptPath } from '../src/notify.mjs'
import { classify, classifyFields } from '../src/relay.mjs'
import { appliedNotice } from '../src/nudge.mjs'
import { allowsInlineSwitch } from '../src/switching.mjs'
import { isDowngrade, tierOf } from '../src/tiers.mjs'
import { isCorrection } from '../src/regret.mjs'
import { taskLabel } from '../src/task-label.mjs'
import { memoryBreaker } from '../src/breaker.mjs'
import { createBufferedLog } from '../src/buffered-log.mjs'

type Effort = 'low' | 'medium' | 'high'
type Decision = { placement: string; model: string | null; effort: Effort | null; toolset?: string; agent?: string; title?: string; confidence: number | null }
type Vars = Record<string, string | undefined>

const DEADLINE_MS = 4000
const TURN_CHARS = 1500
const SIBLING_QUIET_PROMPTS = 10

const breaker = memoryBreaker()

const state = {
  config: resolveConfig(),
  env: {} as Vars,
  jevEnv: {} as Vars,
  baseline: null as string | null,
  isManual: false,
  latest: null as Decision | null,
  pending: new Map<string, Promise<Decision | null>>(),
  byText: new Map<string, Promise<Decision | null>>(),
  spawned: new Set<string>(),
  typedPrompts: 0,
  lastStopAt: 0,
  lastWasDowngrade: false,
  siblingQuietUntil: 0,
  home: '',
  missed: new WeakSet<object>(),
  logs: new Map<string, (entry: Record<string, unknown>) => Promise<void>>(),
}

const fetchLike =
  ($: EngineInterface) =>
  async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs: number }) => {
    const timeout = new Promise<never>((_, reject) => $.clock.after(init.timeoutMs, () => reject(new Error('timeout'))))
    const res = await Promise.race([$.http.fetch(url, { method: init.method, headers: init.headers, body: init.body }), timeout])
    return { ok: res.ok, status: res.status, json: async () => JSON.parse(res.text) }
  }

async function load($: EngineInterface) {
  const home = (await $.env.get('HOME')) ?? ''
  state.home = home
  const read = async (dir: string) => resolveConfig(JSON.parse(await $.fs.read(`${home}/.config/${dir}/config.json`)))
  state.config = await read('jev-relayer').catch(() => read('jev-relay')).catch(() => resolveConfig())
  try {
    state.jevEnv = parseEnv(await $.fs.read(`${home}/.config/jev-opus/.env`)) as Vars
  } catch {
    state.jevEnv = {}
  }
  const real: Vars = {
    JEV_RELAYER: await $.env.get('JEV_RELAYER'),
    JEV_RELAY: await $.env.get('JEV_RELAY'),
    OPENROUTER_API_KEY: await $.env.get('OPENROUTER_API_KEY'),
    TYPESAFE_API_KEY: await $.env.get('TYPESAFE_API_KEY'),
    JEV_API_KEY: await $.env.get('JEV_API_KEY'),
  }
  state.env = Object.fromEntries(Object.entries(real).filter(([, value]) => value))
}

async function remoteOf($: EngineInterface, cwd: string) {
  try {
    const result = await $.process.run(['git', '-C', cwd, 'remote', 'get-url', 'origin'], { timeoutMs: 2000 })
    return result.stdout.trim()
  } catch {
    return ''
  }
}

const isUnavailable = (err: unknown) => err instanceof TypeError || /unavailable|not available|CLI|ENOENT|failed to start/i.test(String(err))

const TYPED_ORIGINS = ['composer', 'bridge', 'sdk']
const RESULT_PREFIX = 'jev-relayer: the subagent finished.'
const EFFORTS = ['low', 'medium', 'high', 'xhigh']
const isAlias = (model: string) => ['haiku', 'sonnet', 'opus'].includes(model.toLowerCase())
const isSameModel = (a: string, b: string) => {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()]
  return x === y || (isAlias(x) && y.includes(x)) || (isAlias(y) && x.includes(y))
}

const isOn = () => isEnabled(state.config, 'claude', state.env)

async function publish($: EngineInterface, status: Record<string, unknown>) {
  try {
    const tmp = ((await $.env.get('TMPDIR')) ?? '/tmp').replace(/\/+$/, '')
    const id = (await $.session.id()).replace(/[^\w-]/g, '')
    await $.fs.write(`${tmp}/jev-claude/${id}.json`, JSON.stringify(status))
  } catch {
    // The status line is cosmetic and must never interfere with a turn.
  }
}

async function record($: EngineInterface, entry: Record<string, unknown>) {
  try {
    const session = (await $.session.id()).replace(/[^\w-]/g, '')
    if (!state.logs.has(session)) {
      const path = `${state.home}/.local/state/jev-relayer/mod/${session}.jsonl`
      const existing = await $.fs.read(path).catch(() => '')
      state.logs.set(session, createBufferedLog((text: string) => $.fs.write(path, text), typeof existing === 'string' ? existing : ''))
    }
    await state.logs.get(session)!({ agent: 'claude', session, ...entry })
  } catch {
    // Metrics are best effort and must never interfere with a turn.
  }
}

async function notify($: EngineInterface, message: string) {
  const home = (await $.env.get('HOME')) ?? ''
  const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${home}/.claude`
  const path = transcriptPath({ configDir, cwd: await $.session.cwd(), id: await $.session.id() })
  await sendNotification({
    message,
    readTranscript: () => $.fs.read(path),
    run: (argv: string[]) => $.process.run(argv, { timeoutMs: 3000 }),
  })
}

async function decide($: EngineInterface, prompt: string, trigger: string, isFirstPrompt = false): Promise<Decision | null> {
  const providers = createProviders(state.config, {
    config: state.config,
    env: state.env,
    fetch: fetchLike($),
    readJevEnv: () => state.jevEnv,
  })
  const cwd = await $.session.cwd()
  const remote = await remoteOf($, cwd)
  const signals = {
    text: `user: ${prompt.slice(0, TURN_CHARS)}`,
    prompt,
    agent: 'claude',
    contextTokens: (await $.session.usage()).context.tokens ?? 0,
    idleMs: 0,
    cwd,
    isFirstPrompt,
  }
  const classified = await classify(signals, state.config, { providers, remoteOf: () => remote, breaker })
  const { result } = classified
  void record($, {
    event: 'decision',
    trigger,
    contextTokens: signals.contextTokens,
    promptChars: prompt.length,
    ...classifyFields(classified),
  })
  if (result.heuristic || (!result.verdict.model && !result.verdict.effort)) return null
  const changed = isChange(state.latest, result.verdict)
  state.latest = result.verdict
  if (state.config.macNotifications && changed) void notify($, decisionLabel(result.verdict))
  return result.verdict
}

async function spawnSibling($: EngineInterface, prompt: string, model: string, toolset?: string, title?: string) {
  const cwd = await $.session.cwd()
  const flags = claudeToolsetFlags(toolset ? state.config.toolsets[toolset] : undefined, state.home)
  try {
    const ran = await $.process.run(['claude', '--bg', '--model', model, ...flags, ...(flags.length ? ['--'] : []), prompt], { cwd, timeoutMs: 30_000 })
    return ran.exitCode === 0
  } catch (err) {
    if (!isUnavailable(err)) return false
  }
  try {
    const started = await $.agent.spawn({ prompt, model, subagentType: 'general-purpose', name: 'jev-sibling', description: title ?? taskLabel(prompt), cwd })
    if ('agentId' in started && started.agentId) state.spawned.add(started.agentId)
    return 'agentId' in started
  } catch {
    return false
  }
}

async function act($: EngineInterface, prompt: string, decision: Decision, isFirstPrompt: boolean): Promise<string | null> {
  const model = decision.model ?? 'sonnet'
  if (decision.placement === 'subagent') {
    const started = await $.agent.spawn({ prompt, model, subagentType: decision.agent ?? 'general-purpose', description: decision.title ?? taskLabel(prompt) }).catch(() => null)
    if (started && 'agentId' in started && started.agentId) {
      state.spawned.add(started.agentId)
      void record($, { event: 'action', placement: 'subagent', outcome: 'spawned', model })
      return `jev-relayer: reply with exactly "jev-relayer: started a subagent (${started.model}) for this request." and stop; its result arrives when it finishes.`
    }
    void record($, { event: 'action', placement: 'subagent', outcome: 'delegated-to-model', model })
    return `jev-relayer: delegate this request to a subagent (model ${model}) with the Agent tool, using ${decision.agent ?? 'Explore for read-only searches'}. Do not do the work in this conversation.`
  }
  if (decision.placement !== 'sibling') return null
  if (isFirstPrompt) {
    void record($, { event: 'action', placement: 'sibling', outcome: 'skipped-first-prompt', model })
    return null
  }

  if (state.typedPrompts <= state.siblingQuietUntil) {
    void record($, { event: 'action', placement: 'sibling', outcome: 'quiet-after-decline', model })
    return null
  }
  const answer = await $.ui.ask(`Run this in a background session (${model})?`, { options: ['Keep here', 'Run in background'], header: 'jev-relayer' })
  if (answer !== 'Run in background') {
    state.siblingQuietUntil = state.typedPrompts + SIBLING_QUIET_PROMPTS
    void record($, { event: 'action', placement: 'sibling', outcome: 'declined', model })
    return null
  }
  if (!(await spawnSibling($, prompt, model, decision.toolset, decision.title))) {
    void record($, { event: 'action', placement: 'sibling', outcome: 'spawn-failed', model })
    return null
  }
  void record($, { event: 'action', placement: 'sibling', outcome: 'accepted', model })
  return `jev-relayer: the user's request was handed to a background session (${model}). Reply with one short sentence saying so and stop; do not do the work here.`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await load($)
    state.typedPrompts = 0
    state.lastStopAt = 0
    state.lastWasDowngrade = false
    state.siblingQuietUntil = 0
    state.baseline = await $.session.model()
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId || state.isManual || !isOn() || e.text.trim() === '' || e.text.includes(RESULT_PREFIX)) return result

    const sessionModel = await $.session.model()
    if (sessionModel !== state.baseline) {
      state.isManual = true
      void record($, { event: 'manual', where: 'turn.start', baseline: state.baseline, model: sessionModel })
      await publish($, { manual: true })
      return result
    }
    state.pending.set(e.turnId, state.byText.get(e.text) ?? decide($, e.text, 'turn').catch(() => null))
    state.byText.delete(e.text)
    return result
  })

  on('prompt.submit', async ($, e, next) => {
    if (!TYPED_ORIGINS.includes(e.origin.kind) || e.command || state.isManual || !isOn() || e.text.trim() === '' || e.text.includes(RESULT_PREFIX)) return next(e)

    const isFirstPrompt = state.typedPrompts++ === 0
    if (state.lastWasDowngrade && isCorrection(e.text)) void record($, { event: 'regret' })
    state.lastWasDowngrade = false
    const pending = decide($, e.text, 'submit', isFirstPrompt).catch(() => null)
    state.byText.set(e.text, pending)
    const deadline = new Promise<undefined>(resolve => $.clock.after(DEADLINE_MS, () => resolve(undefined)))
    const decision = await Promise.race([pending, deadline])
    if (decision === undefined) {
      state.missed.add(pending)
      void record($, { event: 'deadline-miss', where: 'submit', deadlineMs: DEADLINE_MS })
    }
    const directive = decision ? await act($, e.text, decision, isFirstPrompt).catch(() => null) : null
    return next(directive ? { ...e, context: [...(e.context ?? []), directive] } : e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined || state.isManual) return yield* next(e)
    if (!isOn()) {
      if (e.index === 0) void publish($, {})
      return yield* next(e)
    }

    const deadline = new Promise<undefined>(resolve => $.clock.after(DEADLINE_MS, () => resolve(undefined)))
    const pending = state.pending.get(e.turnId)
    const decision = await Promise.race([pending, deadline])
    if (decision === undefined && pending && !state.missed.has(pending) && e.index === 0) {
      state.missed.add(pending)
      void record($, { event: 'deadline-miss', where: 'step', deadlineMs: DEADLINE_MS })
    }
    const current = await $.session.model().catch(() => null)
    if (current === null) return yield* next(e)
    if (current !== state.baseline) {
      state.isManual = true
      void record($, { event: 'manual', where: 'turn.step', baseline: state.baseline, model: current })
      return yield* next(e)
    }
    const picked = decision?.placement === 'inline' ? decision.model : null
    const wantsSwitch = picked !== null && !isSameModel(picked, current)
    const contextTokens = wantsSwitch ? ((await $.session.usage().catch(() => null))?.context.tokens ?? 0) : 0
    const idleMs = state.lastStopAt ? Date.now() - state.lastStopAt : 0
    const allowed = wantsSwitch && allowsInlineSwitch({ current, picked, contextTokens, idleMs }, state.config.gate)
    const model = allowed ? picked : null
    const downgrade = Boolean(model) && isDowngrade(current, model)
    const wanted = decision?.placement === 'inline' ? decision.effort : null
    const effort = wanted && EFFORTS.includes(wanted) && e.effort !== undefined ? wanted : null
    if (e.index === 0 && state.config.statusNotice && decision && (picked || effort)) {
      const text = appliedNotice({ current, picked, effort, switched: Boolean(model), blocked: wantsSwitch && !allowed, contextTokens, confidence: decision.confidence })
      $.ui.log(text)
    }
    const stream = next(model || effort ? { ...e, ...(model && { model }), ...(effort && { effort }) } : e)
    for await (const chunk of stream) {
      if (e.index === 0 && chunk.kind === 'stop') {
        const served = chunk.usage?.model
        void record($, {
          event: 'applied',
          placement: decision?.placement ?? null,
          picked,
          effortWanted: wanted,
          effortApplied: effort,
          sessionModel: current,
          switched: Boolean(model),
          served: served ?? null,
          servedMatches: picked && served ? isSameModel(picked, served) : null,
          inputTokens: chunk.usage?.input_tokens ?? null,
          cacheReadTokens: chunk.usage?.cache_read_input_tokens ?? null,
          cacheCreationTokens: chunk.usage?.cache_creation_input_tokens ?? 0,
          downgrade,
          downgradeBlocked: wantsSwitch && !allowed,
          outputTokens: chunk.usage?.output_tokens ?? null,
        })
        state.lastStopAt = Date.now()
        state.lastWasDowngrade = downgrade
        if (picked && served) void publish($, { tier: tierOf(served) ?? served.toLowerCase(), model: served, effort })
      }
      yield chunk
    }
    return await stream.result
  })

  on('turn.complete', async ($, e, next) => {
    state.pending.delete(e.turnId)
    if (e.agentId && state.spawned.delete(e.agentId) && e.answer) {
      void $.prompt.submit({ text: `${RESULT_PREFIX} Its result:\n\n${e.answer}\n\nTell the user what it found.` })
    }
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    if (e.fork || e.model || !isOn()) return next(e)
    const timedOut = Symbol('timeout')
    const deadline = new Promise<typeof timedOut>(resolve => $.clock.after(DEADLINE_MS, () => resolve(timedOut)))
    const raced = await Promise.race([decide($, e.prompt, 'spawn').catch(() => null), deadline])
    const decision = raced === timedOut ? null : raced
    if (raced === timedOut) void record($, { event: 'deadline-miss', where: 'spawn', deadlineMs: DEADLINE_MS })
    void record($, { event: 'spawn-model', picked: decision?.model ?? null })
    return next(decision?.model ? { ...e, model: decision.model } : e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const verdict = state.latest
    if (!state.config.band.enabled || !verdict) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const target = verdict.model
    const confidence = verdict.confidence == null ? '' : ` · ${verdict.confidence.toFixed(2)}`
    const isSwitch = target !== null && !(await $.session.model()).toLowerCase().includes(target.toLowerCase())

    return (
      <Box>
        <Text dimColor>
          jev: {verdict.placement} · {target ?? 'default'}
          {confidence}{' '}
        </Text>
        {isSwitch && <Button key="model" label={`🟢 Switch to ${target}`} onPress={() => $.command.run({ command: 'model', args: target })} />}
      </Box>
    )
  })
}
