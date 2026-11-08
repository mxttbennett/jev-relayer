import { AGENT_META } from "./agent-meta.mjs";
import { runChain } from "./chain.mjs";
import { isEnabled, repoFor } from "./defaults.mjs";
import { shouldClassify } from "./heuristics.mjs";
import {
  DEGRADED_BADGE,
  DEGRADED_NOTICE,
  buildNotice,
  buildNudge,
  skipNotice,
} from "./nudge.mjs";
import { claudeProfileFlags, profileDescriptions } from "./profiles.mjs";
import { redact } from "./redact.mjs";

const TURN_CHARS = 1500;
const TEXT_CHARS = 6000;
const PROMPT_LOG_CHARS = 200;
const MODEL_TTL_MS = 10 * 60 * 1000;

export function classifyFields({ result, cls, hits, low, raw, downgraded, prompt }) {
  return {
    repoClass: cls,
    redactionHits: hits,
    provider: result.provider,
    heuristic: result.heuristic,
    verdict: result.verdict,
    ...(low && { lowConfidence: true, prompt }),
    ...(downgraded && { downgraded, rawVerdict: raw }),
    degraded: result.degraded,
    latencyMs: result.latencyMs,
    providerMs: result.providerMs,
    failures: result.failures,
  };
}

export async function classify(signals, config, deps) {
  const repo = repoFor(config, signals.cwd, deps.remoteOf);
  const cls = repo.name;
  const { text, hits } = redact(signals.text, config.redact.names);
  const models = config.models[signals.agent] ?? {};
  const { efforts } = config;
  const profiles = signals.agent === "claude" ? profileDescriptions(config.profiles) : {};
  const names = repo.chain.filter(
    (name) => !(hits > 0 && deps.providers[name]?.remote),
  );
  const result = await runChain(names, deps.providers, { ...signals, models, efforts, profiles, text: text.slice(-TEXT_CHARS) }, deps.breaker);
  const low = !result.heuristic && result.verdict.confidence != null && result.verdict.confidence < config.minConfidence;
  const raw = result.verdict;
  const weakSibling =
    !result.heuristic && raw.placement === "sibling" && raw.confidence != null && raw.confidence < config.siblingMinConfidence;
  const downgraded = low
    ? "low-confidence"
    : signals.isFirstPrompt && raw.placement === "sibling"
      ? "first-prompt"
      : weakSibling
        ? "weak-sibling"
        : null;
  if (downgraded) result.verdict = { placement: "inline", model: null, effort: null, confidence: raw.confidence };
  const prompt = low ? redact(signals.prompt, config.redact.names).text.slice(0, PROMPT_LOG_CHARS) : undefined;
  return { result, cls, hits, low, raw, downgraded, prompt };
}

function coolingDown(nudge, contextTokens, cooldown) {
  return (
    Boolean(nudge) &&
    nudge.promptsSince < cooldown.prompts &&
    contextTokens < nudge.tokens * (1 + cooldown.growth)
  );
}

function excerptOf(turns, prompt) {
  const earlier = turns.at(-1)?.role === "user" && turns.at(-1).text === prompt ? turns.slice(0, -1) : turns;
  const lines = earlier.map((t) => `${t.role}: ${t.text.slice(0, TURN_CHARS)}`);
  return [...lines, `user: ${prompt.slice(0, TURN_CHARS)}`].join("\n\n");
}

export async function handlePrompt({ input, agent, config, deps }) {
  if (!isEnabled(config, agent, deps.env)) return null;
  const snapshot = deps.readTranscript(input.transcript_path);
  const contextTokens = snapshot.contextTokens;
  const idleMs = snapshot.lastAt ? deps.now() - snapshot.lastAt : 0;
  const priorPrompts = snapshot.turns.filter((t) => t.role === "user" && t.text !== input.prompt).length;
  const everyTurn = config.report === "every-turn";
  if (!shouldClassify({ contextTokens, idleMs, prompt: input.prompt, priorPrompts }, config.gate)) {
    const cache = idleMs >= config.gate.cacheTtlMs ? "cold" : "warm";
    const why = `${Math.round(contextTokens / 1000)}k tokens, cache ${cache}`;
    deps.state.log({ event: "skip", reason: "gate", agent, session: input.session_id, contextTokens, idleMs, cache });
    return everyTurn ? { context: "", notice: skipNotice(why) } : null;
  }

  const state = deps.state.load(input.session_id);
  if (coolingDown(state.nudge, contextTokens, config.cooldown)) {
    state.nudge.promptsSince += 1;
    deps.state.save(input.session_id, state);
    const why = `cooling down (${state.nudge.promptsSince}/${config.cooldown.prompts})`;
    deps.state.log({ event: "skip", reason: "cooldown", agent, session: input.session_id, contextTokens, idleMs });
    return everyTurn ? { context: "", notice: skipNotice(why) } : null;
  }

  const classified = await classify(
    {
      isFirstPrompt: !snapshot.turns.some((t) => t.role === "user" && t.text !== input.prompt),
      text: excerptOf(snapshot.turns, input.prompt),
      prompt: input.prompt,
      agent,
      contextTokens,
      idleMs,
      cwd: input.cwd,
    },
    config,
    deps,
  );
  const { result, low } = classified;
  const isFirstPrompt = !snapshot.turns.some((t) => t.role === "user" && t.text !== input.prompt);
  if (isFirstPrompt && result.verdict.placement === "sibling") {
    result.verdict = { placement: "inline", model: null, effort: null, confidence: result.verdict.confidence };
  }

  const lines = [];
  const notices = [];
  if (result.degraded && !state.degradedWarned) {
    lines.push(DEGRADED_NOTICE);
    notices.push(DEGRADED_BADGE);
    state.degradedWarned = true;
  } else if (!result.heuristic) {
    state.degradedWarned = false;
  }
  if (low) delete state.model;
  else if (!result.heuristic && result.verdict.model) {
    state.model = { value: result.verdict.model, at: deps.now() };
  }
  const flags = agent === "claude" ? claudeProfileFlags(config.profiles[result.verdict.profile], deps.home) : [];
  const nudge = buildNudge(result.verdict, { agent, contextTokens, flags });
  if (nudge) {
    lines.push(nudge);
    notices.push(buildNotice(result.verdict));
    state.nudge = { promptsSince: 0, tokens: contextTokens };
  } else {
    delete state.nudge;
  }
  const inlineModel = !result.heuristic && result.verdict.placement === "inline" ? result.verdict.model : null;
  const switchedInline = inlineModel !== null && inlineModel !== state.inlineModel;
  if (inlineModel !== null) state.inlineModel = inlineModel;
  deps.state.log({
    event: "prompt",
    agent,
    session: input.session_id,
    contextTokens,
    idleMs,
    promptChars: input.prompt.length,
    nudged: Boolean(nudge),
    switchedInline,
    ...classifyFields(classified),
  });
  deps.state.save(input.session_id, state);
  if (lines.length) return { context: lines.join("\n"), notice: notices.join("\n") };
  return null;
}

export async function pickSubagentModel({ input, agent, config, deps }) {
  if (!isEnabled(config, agent, deps.env) || !AGENT_META[agent].subagentModel) return null;
  const tool = input.tool_input ?? {};
  const base = { event: "agent", agent, session: input.session_id };
  if (tool.model || tool.subagent_type === "fork" || !tool.prompt) {
    deps.state.log({ ...base, source: tool.model ? "explicit" : "skipped", model: tool.model ?? null });
    return null;
  }

  const state = deps.state.load(input.session_id);
  if (state.model && deps.now() - state.model.at < MODEL_TTL_MS) {
    deps.state.log({ ...base, source: "cached", model: state.model.value });
    return state.model.value;
  }

  const classified = await classify(
    { text: `user: ${tool.prompt.slice(0, TURN_CHARS)}`, prompt: tool.prompt, agent, contextTokens: 0, idleMs: 0, cwd: input.cwd },
    config,
    deps,
  );
  const { result } = classified;
  deps.state.log({ ...base, source: "classifier", model: result.verdict.model, ...classifyFields(classified) });
  return result.heuristic ? null : result.verdict.model;
}
