import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { costSummary } from "./cost.mjs";
import { modLogDir } from "./paths.mjs";
import { STATE_DIR } from "./state.mjs";

const DAY_MS = 86_400_000;
const BUCKETS = [
  ["<0.5", (c) => c < 0.5],
  ["0.5-0.6", (c) => c < 0.6],
  ["0.6-0.8", (c) => c < 0.8],
  ["0.8-0.9", (c) => c < 0.9],
  [">=0.9", () => true],
];

function readLines(path) {
  try {
    return readFileSync(path, "utf8").split("\n");
  } catch {
    return [];
  }
}

const parseLines = (path, extra) =>
  readLines(path).flatMap((line) => {
    try {
      return [{ ...JSON.parse(line), ...extra }];
    } catch {
      return [];
    }
  });

export function readEvents(dir = STATE_DIR, { days, now = Date.now() } = {}) {
  let modFiles = [];
  try {
    modFiles = readdirSync(modLogDir(dir)).map((f) => join(modLogDir(dir), f));
  } catch {}
  const since = days ? now - days * DAY_MS : 0;
  const events = [
    ...parseLines(join(dir, "relay.log"), {}),
    ...modFiles.flatMap((file) => parseLines(file, { origin: "mod" })),
  ];
  return events.filter((entry) => Date.parse(entry.at) >= since).sort((a, b) => a.at.localeCompare(b.at));
}

export const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};

const count = (items, key) => {
  const out = {};
  for (const item of items) {
    const k = key(item);
    if (k != null) out[k] = (out[k] ?? 0) + 1;
  }
  return out;
};

const rate = (n, total) => (total ? Number((n / total).toFixed(3)) : null);
const sorted = (obj) => Object.fromEntries(Object.entries(obj).sort((a, b) => b[1] - a[1]));

export function summarize(events, pricing) {
  const of = (name) => events.filter((e) => e.event === name);
  const decisions = events.filter((e) => e.event === "prompt" || e.event === "decision");
  const hookPrompts = of("prompt");
  const skips = of("skip");
  const modTurns = of("decision").filter((e) => e.trigger !== "spawn");
  const isHeuristic = (e) => e.heuristic ?? (e.provider == null || e.provider === "heuristics");
  const modSessions = new Set(events.filter((e) => e.origin === "mod").map((e) => e.session));
  const agents = of("agent");
  const applied = of("applied");
  const actions = of("action");
  const hookTurns = hookPrompts.length + skips.length;
  const remote = decisions.filter((e) => !isHeuristic(e));
  const withConfidence = remote.filter((e) => (e.rawVerdict ?? e.verdict)?.confidence != null);

  const providerStats = {};
  for (const name of Object.keys(count(decisions, (e) => e.provider))) {
    const answered = decisions.filter((e) => e.provider === name);
    const ms = answered.map((e) => e.providerMs).filter((v) => v != null);
    const attempts = answered.length + decisions.flatMap((e) => e.failures ?? []).filter((f) => f.name === name).length;
    providerStats[name] = {
      answered: answered.length,
      answerRate: rate(answered.length, attempts),
      p50Ms: percentile(ms, 50),
      p95Ms: percentile(ms, 95),
    };
  }
  const failureCounts = count(
    decisions.flatMap((e) => e.failures ?? []),
    (f) => `${f.name}: ${f.error}`,
  );
  for (const [name, entry] of Object.entries(providerStats)) {
    entry.failures = Object.values(
      Object.fromEntries(Object.entries(failureCounts).filter(([k]) => k.startsWith(`${name}:`))),
    ).reduce((a, b) => a + b, 0);
  }

  const lat = decisions.map((e) => e.latencyMs).filter((v) => v != null);
  const conf = withConfidence.map((e) => (e.rawVerdict ?? e.verdict).confidence);
  const submitted = applied.length;
  const manual = of("manual").length;
  const sibling = actions.filter((a) => a.placement === "sibling");
  const spawns = of("spawn-model");

  return {
    window: { from: events[0]?.at ?? null, to: events.at(-1)?.at ?? null, events: events.length },
    volume: {
      turns: hookTurns + modTurns.length,
      classified: decisions.length,
      gateSkipRate: rate(skips.filter((e) => e.reason === "gate").length, hookTurns),
      cooldownSkipRate: rate(skips.filter((e) => e.reason === "cooldown").length, hookTurns),
      sessions: new Set(events.map((e) => e.session).filter(Boolean)).size,
    },
    health: {
      degradedRate: rate(decisions.filter((e) => e.degraded).length, decisions.length),
      heuristicRate: rate(decisions.filter(isHeuristic).length, decisions.length),
      redactionHitRate: rate(decisions.filter((e) => e.redactionHits > 0).length, decisions.length),
      latencyMs: { p50: percentile(lat, 50), p95: percentile(lat, 95), max: lat.length ? Math.max(...lat) : null },
      hookCrashes: sorted(count(of("crash"), (e) => `${e.hook}: ${e.error}`)),
      deadlineMisses: of("deadline-miss").length,
      deadlineMissRate: rate(of("deadline-miss").length, decisions.length),
      providers: providerStats,
      failures: sorted(failureCounts),
    },
    verdicts: {
      placement: sorted(count(decisions, (e) => (e.rawVerdict ?? e.verdict)?.placement)),
      model: sorted(count(decisions, (e) => e.verdict?.model ?? "none")),
      effort: sorted(count(decisions, (e) => e.verdict?.effort ?? "none")),
      byRepoClass: sorted(count(decisions, (e) => e.repoClass)),
      lowConfidenceRate: rate(decisions.filter((e) => e.lowConfidence).length, remote.length),
      confidence: Object.fromEntries(
        BUCKETS.map(([label, test], i) => [
          label,
          conf.filter((c) => test(c) && (i === 0 || !BUCKETS[i - 1][1](c))).length,
        ]),
      ),
      meanConfidence: conf.length ? Number((conf.reduce((a, b) => a + b, 0) / conf.length).toFixed(3)) : null,
    },
    outcomes: {
      nudgeRate: rate(decisions.filter((e) => e.nudged).length, decisions.filter((e) => e.event === "prompt").length),
      inlineSwitchRate: rate(applied.filter((e) => e.switched).length, submitted),
      servedMismatchRate: rate(
        applied.filter((e) => e.servedMatches === false).length,
        applied.filter((e) => e.servedMatches != null).length,
      ),
      manualOverrides: manual,
      manualOverrideRate: rate(manual, modSessions.size),
      siblingAcceptRate: rate(sibling.filter((a) => a.outcome === "accepted").length, sibling.length),
      siblingSpawnFailures: sibling.filter((a) => a.outcome === "spawn-failed").length,
      subagentActions: sorted(count(actions.filter((a) => a.placement === "subagent"), (a) => a.outcome)),
      subagentModelSource: sorted(count(agents, (e) => e.source)),
      subagentModelPicks: sorted(count(agents.filter((e) => e.model), (e) => e.model)),
      spawnPickRate: rate(spawns.filter((e) => e.picked).length, spawns.length),
      downgrades: applied.filter((e) => e.downgrade).length,
      blockedDowngrades: applied.filter((e) => e.downgradeBlocked).length,
      regretRate: rate(of("regret").length, applied.filter((e) => e.downgrade).length),
    },
    cost: {
      modelByServed: sorted(count(applied, (e) => e.served)),
      estimate: costSummary(applied.filter((e) => e.cacheCreationTokens !== undefined), pricing),
      meanInputTokens: (() => {
        const v = applied.map((e) => e.inputTokens).filter((x) => x != null);
        return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null;
      })(),
    },
  };
}

const ms = (v) => (v == null ? "n/a" : `${v}ms`);
const pct = (v) => (v == null ? "n/a" : `${(v * 100).toFixed(1)}%`);
const table = (obj) => Object.entries(obj).map(([k, v]) => `  ${k}: ${v}`).join("\n") || "  none";

export function formatSummary(s) {
  const lines = [
    `Window: ${s.window.from ?? "n/a"} → ${s.window.to ?? "n/a"} (${s.window.events} events, ${s.volume.sessions} sessions)`,
    "",
    "Volume",
    `  turns ${s.volume.turns} · classified ${s.volume.classified} · gate skips ${pct(s.volume.gateSkipRate)} · cooldown skips ${pct(s.volume.cooldownSkipRate)}`,
    "",
    "Health",
    `  degraded ${pct(s.health.degradedRate)} · heuristic fallback ${pct(s.health.heuristicRate)} · redaction hits ${pct(s.health.redactionHitRate)}`,
    `  latency p50 ${ms(s.health.latencyMs.p50)} · p95 ${ms(s.health.latencyMs.p95)} · max ${ms(s.health.latencyMs.max)}`,
    `  deadline misses ${s.health.deadlineMisses} (${pct(s.health.deadlineMissRate)}) · hook crashes ${Object.values(s.health.hookCrashes).reduce((a, b) => a + b, 0)}`,
    ...(Object.keys(s.health.hookCrashes).length ? ["  crashes:", table(s.health.hookCrashes)] : []),
    "  providers:",
    ...Object.entries(s.health.providers).map(
      ([n, p]) => `    ${n}: answered ${p.answered} (${pct(p.answerRate)}), failures ${p.failures}, p50 ${ms(p.p50Ms)}, p95 ${ms(p.p95Ms)}`,
    ),
    "  failures:",
    table(s.health.failures),
    "",
    "Verdicts",
    "  placement:",
    table(s.verdicts.placement),
    "  model:",
    table(s.verdicts.model),
    "  effort:",
    table(s.verdicts.effort),
    `  low-confidence (< minConfidence) ${pct(s.verdicts.lowConfidenceRate)} · mean confidence ${s.verdicts.meanConfidence ?? "n/a"}`,
    "  confidence:",
    table(s.verdicts.confidence),
    "",
    "Outcomes",
    `  nudge rate ${pct(s.outcomes.nudgeRate)} · inline model switches ${pct(s.outcomes.inlineSwitchRate)} · served ≠ picked ${pct(s.outcomes.servedMismatchRate)}`,
    `  manual overrides ${s.outcomes.manualOverrides} (${pct(s.outcomes.manualOverrideRate)} of mod sessions)`,
    `  sibling accepted ${pct(s.outcomes.siblingAcceptRate)} · spawn failures ${s.outcomes.siblingSpawnFailures}`,
    "  subagent actions:",
    table(s.outcomes.subagentActions),
    "  subagent model source:",
    table(s.outcomes.subagentModelSource),
    "  subagent model picks:",
    table(s.outcomes.subagentModelPicks),
    `  agent.spawn picked a model ${pct(s.outcomes.spawnPickRate)}`,
    `  downgrades ${s.outcomes.downgrades} · blocked by warm cache ${s.outcomes.blockedDowngrades} · regret ${pct(s.outcomes.regretRate)}`,
    "",
    "Served models",
    table(s.cost.modelByServed),
    `  mean uncached input tokens ${s.cost.meanInputTokens ?? "n/a"}`,
    `  estimated cost $${s.cost.estimate.actual.toFixed(2)} vs $${s.cost.estimate.baseline.toFixed(2)} on the session model · saved $${s.cost.estimate.saved.toFixed(2)} (${s.cost.estimate.turns} turns)`,
  ];
  return lines.join("\n");
}

export function runStats(args, { pricing, dir = STATE_DIR, now = Date.now() }) {
  const json = args.includes("--json");
  const daysIndex = args.indexOf("--days");
  const days = daysIndex >= 0 ? Number(args[daysIndex + 1]) : undefined;
  if (daysIndex >= 0 && !(days > 0)) throw new Error("usage: jev-relayer stats [--days N] [--json]");
  const summary = summarize(readEvents(dir, { days, now }), pricing);
  return json ? JSON.stringify(summary, null, 2) : formatSummary(summary);
}
