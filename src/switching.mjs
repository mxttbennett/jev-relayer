import { cacheExpired } from "./heuristics.mjs";
import { isDowngrade } from "./tiers.mjs";

export function allowsInlineSwitch({ current, picked, contextTokens, idleMs }, gate) {
  if (!isDowngrade(current, picked)) return true;
  return contextTokens < gate.coldMinTokens || cacheExpired(idleMs, gate);
}
