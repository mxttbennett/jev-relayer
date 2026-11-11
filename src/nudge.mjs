import { AGENTS } from "./agents.mjs";
import { tierOf } from "./tiers.mjs";

export const DEGRADED_NOTICE =
  "jev-relayer: no classifier answered, so routing advice is degraded to heuristics for this session.";

export const DEGRADED_BADGE = "⚠ jev-relayer: no classifier answered, using heuristics";

const confidenceText = (confidence) => (confidence == null ? null : confidence.toFixed(2));
const tokensText = (tokens) => `${Math.round(tokens / 1000)}k`;
const dotted = (parts) => parts.filter(Boolean).map((part) => ` · ${part}`).join("");

const via = (provider) => provider && `via ${provider}`;

export function buildNotice(verdict, provider) {
  const detail = dotted([verdict.model, confidenceText(verdict.confidence), via(provider)]);
  if (verdict.placement === "subagent") return `↪ jev-relayer: subagent${detail}`;
  if (verdict.placement === "sibling") return `↪ jev-relayer: sibling session${detail}`;
  return null;
}

export const gateSkipNotice = (contextTokens, cache) => `· jev-relayer: skipped · ${tokensText(contextTokens)} tokens, cache ${cache}`;

export const cooldownSkipNotice = (since, prompts) => `· jev-relayer: skipped · cooling down (${since}/${prompts})`;

export function appliedNotice({ current, picked, effort, switched, blocked, contextTokens, confidence, provider }) {
  const tail = dotted([effort, confidenceText(confidence), via(provider)]);
  if (switched) return `jev → ${picked}${tail}`;
  const stay = tierOf(current) ?? current;
  if (blocked) return `jev: staying on ${stay} · ${tierOf(picked) ?? picked} skipped, ${tokensText(contextTokens)} context is cached${tail}`;
  return `jev: ${stay}${tail}`;
}

export const modelNotice = (model) => `↪ jev-relayer: subagent model → ${model}`;

export const decisionLabel = ({ placement, model, effort, confidence }) =>
  [placement, [model, effort].filter(Boolean).join(" · "), confidenceText(confidence)].filter(Boolean).join(" · ");

export const bandLabel = ({ placement, model, confidence }) =>
  `jev: ${placement} · ${model ?? "default"}${dotted([confidenceText(confidence)])}`;

export function buildNudge(verdict, { agent, contextTokens, flags = [] }) {
  const size = `${tokensText(contextTokens)} tokens`;
  const model = verdict.model ? ` with model ${verdict.model}` : "";
  if (verdict.placement === "subagent") {
    return `jev-relayer: this prompt looks self-contained and read-heavy, and the conversation is large (${size}). Prefer a subagent${model} (Explore for searches) over continuing inline.`;
  }
  if (verdict.placement === "sibling") {
    const command = [...AGENTS[agent].siblingArgv(verdict.model, flags), '"<brief>"'].join(" ");
    return `jev-relayer: this prompt looks independent of the conversation, which is large (${size}). Write a short handoff brief without pasting this conversation, show it to the user, and once they approve run: ${command}`;
  }
  return null;
}
