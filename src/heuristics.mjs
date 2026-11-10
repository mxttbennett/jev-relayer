import { emptyVerdict } from "./prompt.mjs";

const FAN_OUT =
  /\b(find all|audit|review (the )?(whole|entire|all)|across (the )?(repo|codebase)|every (file|place|usage)|search (the )?(whole|entire)|investigate|survey)\b/i;
const INDEPENDENT =
  /\b(unrelated|separate (task|thing)|different (task|thing)|new task|meanwhile|in the background)\b/i;

function matches(patterns, prompt) {
  return patterns.some((source) => {
    try {
      return new RegExp(source, "i").test(prompt);
    } catch {
      return false;
    }
  });
}

const isHeavy = (prompt, gate) => matches(gate.heavyPatterns, prompt ?? "");

export function contextOpensGate({ contextTokens, idleMs, prompt }, gate) {
  if (contextTokens >= gate.contextTokens) return true;
  if (idleMs >= gate.cacheTtlMs && contextTokens >= gate.coldMinTokens) return true;
  return contextTokens >= gate.heavyFloorTokens && isHeavy(prompt, gate);
}

export const shouldClassify = (signals, gate) => signals.priorPrompts < gate.earlyPrompts || contextOpensGate(signals, gate);

export function heuristicVerdict(signals, gate) {
  const open = contextOpensGate(signals, gate);
  if (open && INDEPENDENT.test(signals.prompt)) return emptyVerdict("sibling", 0.5);
  if (open && (FAN_OUT.test(signals.prompt) || isHeavy(signals.prompt, gate))) return emptyVerdict("subagent", 0.5);
  return emptyVerdict("inline", 0.5);
}
