import { fileURLToPath } from "node:url";
import { AGENTS, siblingFlags } from "./agents.mjs";
import { classify, excerptOf } from "./classify.mjs";
import { isEnabled, isModLoaded, isSelfRouted } from "./defaults.mjs";
import { cacheExpired, shouldClassify } from "./heuristics.mjs";
import {
  DEGRADED_BADGE,
  DEGRADED_NOTICE,
  buildNotice,
  buildNudge,
  cooldownSkipNotice,
  gateSkipNotice,
} from "./nudge.mjs";

const MODEL_TTL_MS = 10 * 60 * 1000;

function coolingDown(nudge, contextTokens, cooldown) {
  return (
    Boolean(nudge) &&
    nudge.promptsSince < cooldown.prompts &&
    contextTokens < nudge.tokens * (1 + cooldown.growth)
  );
}

export const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

export async function handlePrompt({ input, agent, config, deps }) {
  if (!isEnabled(config, agent, deps.env)) return null;
  if (agent === "claude" && isModLoaded(deps.env, deps.env.HOME ?? "", REPO_ROOT)) {
    deps.state.log({ event: "skip", reason: "mod", agent, session: input.session_id });
    return null;
  }
  const snapshot = deps.readTranscript(input.transcript_path);
  const contextTokens = snapshot.contextTokens;
  const idleMs = snapshot.lastAt ? deps.now() - snapshot.lastAt : 0;
  const priorPrompts = snapshot.turns.filter((t) => t.role === "user" && t.text !== input.prompt).length;
  const everyTurn = config.report === "every-turn";
  if (!shouldClassify({ contextTokens, idleMs, prompt: input.prompt, priorPrompts }, config.gate)) {
    const cache = cacheExpired(idleMs, config.gate) ? "cold" : "warm";
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
      text: excerptOf(snapshot.turns, input.prompt, config.excerptTurns),
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
  const flags = siblingFlags(agent, verdict.toolset, config, deps.home);
  const nudge = buildNudge(verdict, { agent, contextTokens, flags });
  if (nudge) {
    lines.push(nudge);
    notices.push(buildNotice(verdict, fields.provider));
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
  if (isSelfRouted(deps.env)) return null;
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
