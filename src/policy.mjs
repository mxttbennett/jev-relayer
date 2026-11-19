const TIER_WORDS = [["haiku", "luna"], ["sonnet", "terra"], ["opus", "sol"]];
const BALANCED_RANK = 1;
const OVERRIDE = new RegExp(`\\b(?:use|switch to|run (?:this )?(?:on|with))\\s+(${TIER_WORDS.flat().join("|")})\\b`, "i");

export function rankOf(model) {
  const tokens = String(model ?? "").toLowerCase().split(/[-_.\s]/);
  const rank = TIER_WORDS.findIndex((words) => words.some((word) => tokens.includes(word)));
  return rank < 0 ? null : rank;
}

export const overrideRank = (prompt) => {
  const named = OVERRIDE.exec(prompt ?? "")?.[1];
  return named ? rankOf(named) : null;
};

export function nearestModel(rank, models) {
  const ranked = models.map((model) => [model, rankOf(model)]).filter(([, r]) => r !== null).sort((a, b) => a[1] - b[1]);
  return (ranked.find(([, r]) => r >= rank) ?? ranked.at(-1))?.[0] ?? null;
}

export function lowConfidenceModel(picked, current, models) {
  const [pickedRank, currentRank] = [rankOf(picked), rankOf(current)];
  if (pickedRank === null || currentRank === null || pickedRank <= currentRank) return null;
  const capped = Math.min(pickedRank, Math.max(currentRank, BALANCED_RANK));
  if (capped === currentRank) return null;
  return capped === pickedRank ? picked : models.find((model) => rankOf(model) === capped) ?? null;
}
