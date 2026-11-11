const TIERS = ["haiku", "sonnet", "opus"];

export const tierOf = (model) => TIERS.find((tier) => String(model ?? "").toLowerCase().includes(tier)) ?? null;

export function isDowngrade(from, to) {
  const [a, b] = [TIERS.indexOf(tierOf(from)), TIERS.indexOf(tierOf(to))];
  return a >= 0 && b >= 0 && b < a;
}

export function sameModel(a, b) {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()];
  return x === y || (TIERS.includes(x) && y.includes(x)) || (TIERS.includes(y) && x.includes(y));
}
