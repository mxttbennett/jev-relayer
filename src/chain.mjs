import { emptyVerdict } from "./prompt.mjs";

export async function runChain(names, providers, input, breaker) {
  const failures = [];
  const started = performance.now();
  const elapsed = (since) => Math.round(performance.now() - since);
  for (const name of names) {
    const provider = providers[name];
    if (!provider) {
      failures.push({ name, error: "unknown provider", ms: 0 });
      continue;
    }
    if (breaker?.isOpen(name)) {
      failures.push({ name, error: "circuit open", ms: 0 });
      continue;
    }
    const attempt = performance.now();
    try {
      const verdict = await provider.run(input);
      breaker?.succeed(name);
      const degraded = provider.heuristic && failures.length > 0;
      return {
        verdict,
        provider: name,
        heuristic: provider.heuristic,
        degraded,
        failures,
        providerMs: elapsed(attempt),
        latencyMs: elapsed(started),
      };
    } catch (err) {
      breaker?.fail(name);
      failures.push({ name, error: err.message, ms: elapsed(attempt) });
    }
  }
  return {
    verdict: emptyVerdict("inline"),
    provider: null,
    heuristic: true,
    degraded: true,
    failures,
    providerMs: 0,
    latencyMs: elapsed(started),
  };
}
