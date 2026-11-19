import type { EngineInterface } from 'claude-code'

export type Decision = { placement: string; model: string | null; effort: string | null; toolset: string | null; agent?: string; title?: string; confidence: number | null; provider?: string; context?: string }
export type Vars = Record<string, string | undefined>

export const DEADLINE_MS = 4000

export function fetchLike($: EngineInterface) {
  return async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs: number }) => {
    const timeout = new Promise<never>((_, reject) => $.clock.after(init.timeoutMs, () => reject(new Error('timeout'))))
    const res = await Promise.race([$.http.fetch(url, { method: init.method, headers: init.headers, body: init.body }), timeout])
    return { ok: res.ok, status: res.status, json: async () => JSON.parse(res.text) }
  }
}

export const isUnavailable = (err: unknown) => err instanceof TypeError || /unavailable|not available|CLI|ENOENT|failed to start/i.test(String(err))

const ENGINE_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const
export type EngineEffort = (typeof ENGINE_EFFORTS)[number]
export const isEngineEffort = (effort: string | null | undefined): effort is EngineEffort => ENGINE_EFFORTS.some(known => known === effort)
export const MISSING_CONTEXT = /\b(lack|lacking|missing|without|(?:do not|don't|doesn't|does not|cannot|can't) (?:have|see|tell))\b[^.\n]{0,40}\b(context|conversation|earlier turns|previous turns)\b/i
export const MISSING_CONTEXT_MAX_CHARS = 600

export const MISSED = Symbol('missed')

export function withinDeadline<T>($: EngineInterface, pending: Promise<T> | undefined) {
  return Promise.race([pending, new Promise<typeof MISSED>(resolve => $.clock.after(DEADLINE_MS, () => resolve(MISSED)))])
}

export const modelLabel = (tag: string, description = '') =>
  description.startsWith(`[${tag}] `) || description.startsWith(`[${tag} · `) ? description : `[${tag}] ${description}`.trimEnd()

const GIT_STATE = [['branch', ['branch', '--show-current']], ['status', ['status', '--short']], ['diff', ['diff', '--stat', 'HEAD']]] as const

export async function repoState($: EngineInterface, cwd: string) {
  const parts: string[] = []
  for (const [label, args] of GIT_STATE) {
    const ran = await $.process.run(['git', '-C', cwd, ...args], { timeoutMs: 3000 }).catch(() => null)
    const out = ran?.exitCode === 0 ? String(ran.stdout ?? '').trim().slice(0, 1500) : ''
    if (out) parts.push(`${label}:\n${out}`)
  }
  return parts.join('\n\n')
}

export function composeBrief(prompt: string, context: string | undefined, repo: string, role: string) {
  const earlier = context && context !== `user: ${prompt}`
  const note = `You are ${role} in the same repository. Tool results and attachments from the conversation are not included, so re-read files you need.`
  return [earlier ? `## Conversation so far\n${context}` : `## Request\n${prompt}`, repo && `## Repository state\n${repo}`, `## Instructions\n${earlier ? 'Answer the last user message above, using the earlier turns as context. ' : ''}${note}`].filter(Boolean).join('\n\n')
}
