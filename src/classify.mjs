import { AGENTS } from "./agents.mjs";
import { runChain } from "./chain.mjs";
import { profileFor } from "./defaults.mjs";
import { emptyVerdict } from "./prompt.mjs";
import { redact } from "./redact.mjs";
import { toolsetDescriptions } from "./toolsets.mjs";

const TURN_CHARS = 1500;
const TEXT_CHARS = 6000;
const PROMPT_LOG_CHARS = 200;

export function excerptOf(turns, prompt) {
  const earlier = turns.at(-1)?.role === "user" && turns.at(-1).text === prompt ? turns.slice(0, -1) : turns;
  const lines = earlier.map((t) => `${t.role}: ${t.text.slice(0, TURN_CHARS)}`);
  return [...lines, `user: ${prompt.slice(0, TURN_CHARS)}`].join("\n\n");
}

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
  const input = {
    text: text.slice(-TEXT_CHARS),
    offered,
    prompt: signals.prompt,
    contextTokens: signals.contextTokens,
    idleMs: signals.idleMs,
  };
  const result = await runChain(names, deps.providers, input, deps.breaker);
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
