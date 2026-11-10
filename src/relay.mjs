import { AGENTS } from "./agents.mjs";
import { runChain } from "./chain.mjs";
import { isEnabled, profileFor } from "./defaults.mjs";
import { shouldClassify } from "./heuristics.mjs";
import {
  DEGRADED_BADGE,
  DEGRADED_NOTICE,
  buildNotice,
  buildNudge,
  cooldownSkipNotice,
  gateSkipNotice,
} from "./nudge.mjs";
import { emptyVerdict } from "./prompt.mjs";
import { redact } from "./redact.mjs";
import { toolsetDescriptions } from "./toolsets.mjs";

const TURN_CHARS = 1500;
const TEXT_CHARS = 6000;
const PROMPT_LOG_CHARS = 200;
const MODEL_TTL_MS = 10 * 60 * 1000;

function offeredChoices(config, agent) {
  return {
    model: config.models[agent] ?? {},
    effort: config.efforts,
    toolset: AGENTS[agent].toolsetFlags ? toolsetDescriptions(config.toolsets) : {},
  };
}

function downgradeReason(raw, { heuristic, isFirstPrompt }, config) {
  const scored = !heuristic && raw.confidence != null;
  if (scored && raw.confidence < config.minConfidence) return "low-confidence";
  if (raw.placement !== "sibling") return null;
  if (isFirstPrompt) return "first-prompt";
  return scored && raw.confidence < config.siblingMinConfidence ? "weak-sibling" : null;
}

export async function classify(signals, config, deps) {
  const profile = profileFor(config, signals.cwd, deps.remoteOf);
  const { text, hits } = redact(signals.text, config.redact.names);
  const names = profile.chain.filter((name) => !(hits > 0 && deps.providers[name]?.remote));
  const offered = offeredChoices(config, signals.agent);
  const result = await runChain(names, deps.providers, { ...signals, offered, text: text.slice(-TEXT_CHARS) }, deps.breaker);
  const raw = result.verdict;
  const downgraded = downgradeReason(raw, { heuristic: result.heuristic, isFirstPrompt: signals.isFirstPrompt }, config);
  const low = downgraded === "low-confidence";
  const verdict = downgraded ? emptyVerdict("inline", raw.confidence) : raw;
  const prompt = low ? redact(signals.prompt, config.redact.names).text.slice(0, PROMPT_LOG_CHARS) : undefined;
  return {
    verdict,
    heuristic: result.heuristic,
    degraded: result.degraded,
    low,
    fields: {
      repoClass: profile.name,
      redactionHits: hits,
      provider: result.provider,
      heuristic: result.heuristic,
      verdict,
      ...(low && { lowConfidence: true, prompt }),
      ...(downgraded && { downgraded, rawVerdict: raw }),
      degraded: result.degraded,
      latencyMs: result.latencyMs,
      providerMs: result.providerMs,
      failures: result.failures,
    },
  };
}

function coolingDown(nudge, contextTokens, cooldown) {
  return (
    Boolean(nudge) &&
    nudge.promptsSince < cooldown.prompts &&
    contextTokens < nudge.tokens * (1 + cooldown.growth)
  );
}

export function excerptOf(turns, prompt) {
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
    deps.state.log({ event: "skip", reason: "gate", agent, session: input.session_id, contextTokens, idleMs, cache });
    return everyTurn ? { context: "", notice: gateSkipNotice(contextTokens, cache) } : null;
  }

  const state = deps.state.load(input.session_id);
  if (coolingDown(state.nudge, contextTokens, config.cooldown)) {
    state.nudge.promptsSince += 1;
    deps.state.save(input.session_id, state);
    deps.state.log({ event: "skip", reason: "cooldown", agent, session: input.session_id, contextTokens, idleMs });
    return everyTurn ? { context: "", notice: cooldownSkipNotice(state.nudge.promptsSince, config.cooldown.prompts) } : null;
  }

  const { verdict, heuristic, degraded, low, fields } = await classify(
    {
      isFirstPrompt: priorPrompts === 0,
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

  const lines = [];
  const notices = [];
  if (degraded && !state.degradedWarned) {
    lines.push(DEGRADED_NOTICE);
    notices.push(DEGRADED_BADGE);
    state.degradedWarned = true;
  } else if (!heuristic) {
    state.degradedWarned = false;
  }
  if (low) delete state.model;
  else if (!heuristic && verdict.model) state.model = { value: verdict.model, at: deps.now() };
  const flags = (verdict.toolset && AGENTS[agent].toolsetFlags?.(config.toolsets[verdict.toolset], deps.home)) || [];
  const nudge = buildNudge(verdict, { agent, contextTokens, flags });
  if (nudge) {
    lines.push(nudge);
    notices.push(buildNotice(verdict));
    state.nudge = { promptsSince: 0, tokens: contextTokens };
  } else {
    delete state.nudge;
  }
  deps.state.log({
    event: "prompt",
    agent,
    session: input.session_id,
    contextTokens,
    idleMs,
    promptChars: input.prompt.length,
    nudged: Boolean(nudge),
    ...fields,
  });
  deps.state.save(input.session_id, state);
  if (lines.length) return { context: lines.join("\n"), notice: notices.join("\n") };
  return null;
}

export async function pickSubagentModel({ input, agent, config, deps }) {
  if (!isEnabled(config, agent, deps.env) || !AGENTS[agent].subagentModel) return null;
  if (deps.env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME === "Jev Router") return null;
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

  const { verdict, heuristic, fields } = await classify(
    { text: excerptOf([], tool.prompt), prompt: tool.prompt, agent, contextTokens: 0, idleMs: 0, cwd: input.cwd },
    config,
    deps,
  );
  deps.state.log({ ...base, source: "classifier", model: verdict.model, ...fields });
  return heuristic ? null : verdict.model;
}
