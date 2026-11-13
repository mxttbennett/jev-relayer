import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULTS } from "../src/defaults.mjs";
import { runChain } from "../src/chain.mjs";
import { handlePrompt, pickSubagent } from "../src/relay.mjs";
import { formatSummary, percentile, readEvents, runStats, summarize } from "../src/stats.mjs";
import { createBufferedLog } from "../src/buffered-log.mjs";

const heuristics = { remote: false, heuristic: true, run: async () => ({ placement: "inline", model: null, confidence: 0.5 }) };
const answer = (verdict) => ({ remote: true, heuristic: false, run: async () => verdict });
const input = { session_id: "s", prompt: "audit the repo", cwd: "/x", transcript_path: "/t" };

function setup(providers, snapshot) {
  const logs = [];
  const deps = {
    env: {},
    now: () => 1_000_000,
    remoteOf: () => "git@github-personal:mxttbennett/x.git",
    readTranscript: () => snapshot ?? { contextTokens: 150000, lastAt: 1_000_000, turns: [] },
    providers,
    state: { load: () => ({}), save() {}, log: (e) => logs.push(e) },
  };
  return { deps, logs };
}

test("runChain times each attempt and the whole chain", async () => {
  const slow = { run: async () => { await new Promise((r) => setTimeout(r, 15)); throw new Error("down"); } };
  const result = await runChain(["slow", "heuristics"], { slow, heuristics }, {});
  assert.equal(result.failures[0].name, "slow");
  assert.ok(result.failures[0].ms >= 10);
  assert.ok(result.latencyMs >= result.failures[0].ms);
  assert.equal(typeof result.providerMs, "number");
});

test("a classified prompt logs latency, nudge and the raw verdict behind a low-confidence override", async () => {
  const { deps, logs } = setup({ jev: answer({ placement: "subagent", model: "haiku", confidence: 0.4 }), heuristics });
  await handlePrompt({ input, agent: "claude", config: DEFAULTS, deps });
  const [entry] = logs;
  assert.equal(entry.event, "prompt");
  assert.equal(entry.lowConfidence, true);
  assert.equal(entry.rawVerdict.placement, "subagent");
  assert.equal(entry.prompt, input.prompt);
  assert.equal(entry.verdict.placement, "inline");
  assert.equal(entry.nudged, false);
  assert.equal(entry.promptChars, input.prompt.length);
  assert.equal(typeof entry.latencyMs, "number");
});

test("gate and cooldown skips are logged with their reason", async () => {
  const small = setup({ jev: answer({ placement: "inline" }), heuristics }, { contextTokens: 30000, lastAt: 1_000_000, turns: [1, 2, 3].map((n) => ({ role: "user", text: `earlier ${n}` })) });
  await handlePrompt({ input, agent: "claude", config: DEFAULTS, deps: small.deps });
  assert.deepEqual(small.logs.map((e) => [e.event, e.reason]), [["skip", "gate"]]);

  let store = {};
  const big = setup({ jev: answer({ placement: "subagent", model: "haiku", confidence: 0.9 }), heuristics });
  big.deps.state.load = () => structuredClone(store);
  big.deps.state.save = (_, s) => { store = structuredClone(s); };
  await handlePrompt({ input, agent: "claude", config: DEFAULTS, deps: big.deps });
  await handlePrompt({ input, agent: "claude", config: DEFAULTS, deps: big.deps });
  assert.deepEqual(big.logs.map((e) => e.event === "skip" ? e.reason : e.event), ["prompt", "cooldown"]);
});

test("subagent model picks log where the model came from", async () => {
  const { deps, logs } = setup({ jev: answer({ placement: "inline", model: "opus" }), heuristics });
  const call = (tool_input) => pickSubagent({ input: { session_id: "n", cwd: "/x", tool_input }, agent: "claude", config: DEFAULTS, deps });
  await call({ prompt: "p", model: "haiku" });
  await call({ prompt: "p" });
  assert.deepEqual(logs.map((e) => e.source), ["explicit", "classifier"]);
  assert.equal(logs[1].model, "opus");
});

test("createBufferedLog rewrites the whole session file in order", async () => {
  const writes = [];
  const log = createBufferedLog(async (text) => { writes.push(text); });
  log({ event: "a" });
  await log({ event: "b" });
  const last = writes.at(-1).trim().split("\n").map((l) => JSON.parse(l).event);
  assert.deepEqual(last, ["a", "b"]);
});

test("percentile uses the nearest rank", () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([10, 20, 30, 40], 50), 20);
  assert.equal(percentile([10, 20, 30, 40], 95), 40);
});

test("summarize rates failures, fallbacks, overrides and sibling acceptance", () => {
  const prompt = (extra) => ({ at: "2026-11-04T00:00:00Z", event: "prompt", session: "s", provider: "jev", verdict: { placement: "inline", model: "sonnet", confidence: 0.9 }, failures: [], latencyMs: 100, providerMs: 100, ...extra });
  const events = [
    prompt({}),
    prompt({ latencyMs: 300, providerMs: 100, failures: [{ name: "qwen", error: "fetch failed", ms: 200 }] }),
    prompt({ provider: "heuristics", degraded: true, verdict: { placement: "inline", model: null, confidence: 0.5 } }),
    prompt({ lowConfidence: true, rawVerdict: { placement: "subagent", model: "haiku", confidence: 0.3 }, verdict: { placement: "inline", model: null, confidence: 0.3 } }),
    { at: "2026-11-04T00:00:01Z", event: "skip", reason: "gate", session: "s" },
    { at: "2026-11-04T00:00:02Z", event: "action", placement: "sibling", outcome: "accepted" },
    { at: "2026-11-04T00:00:03Z", event: "action", placement: "sibling", outcome: "declined" },
    { at: "2026-11-04T00:00:04Z", event: "manual", session: "s" },
    { at: "2026-11-04T00:00:05Z", event: "applied", session: "s", switched: true, picked: "haiku", served: "claude-sonnet-5-5", servedMatches: false },
    { at: "2026-11-04T00:00:06Z", event: "deadline-miss", where: "submit" },
  ];
  const s = summarize(events, DEFAULTS.pricing);
  assert.equal(s.volume.turns, 5);
  assert.equal(s.volume.gateSkipRate, 0.2);
  assert.equal(s.health.degradedRate, 0.25);
  assert.equal(s.health.providers.jev.failures, 0);
  assert.equal(s.health.failures["qwen: fetch failed"], 1);
  assert.equal(s.health.latencyMs.p50, 100);
  assert.equal(s.verdicts.lowConfidenceRate, 0.333);
  assert.equal(s.verdicts.placement.subagent, 1);
  assert.equal(s.outcomes.siblingAcceptRate, 0.5);
  assert.equal(s.outcomes.servedMismatchRate, 1);
  assert.equal(s.outcomes.inlineSwitchRate, 1);
  assert.equal(s.health.deadlineMisses, 1);
});

test("readEvents merges relay.log and per-session mod logs and honours --days", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-stats-"));
  mkdirSync(join(dir, "mod"));
  const now = Date.parse("2026-11-04T12:00:00Z");
  writeFileSync(join(dir, "relay.log"), `${JSON.stringify({ at: "2026-10-01T00:00:00Z", event: "prompt" })}\n${JSON.stringify({ at: "2026-11-04T01:00:00Z", event: "prompt" })}\nnot json\n`);
  writeFileSync(join(dir, "mod", "a.jsonl"), `${JSON.stringify({ at: "2026-11-04T02:00:00Z", event: "decision" })}\n`);
  assert.deepEqual(readEvents(dir, { now }).map((e) => e.origin ?? "hook"), ["hook", "hook", "mod"]);
  assert.equal(readEvents(dir, { days: 7, now }).length, 2);
  const options = { dir, now, pricing: DEFAULTS.pricing };
  assert.match(runStats(["--days", "7"], options), /classified 2/);
  assert.equal(JSON.parse(runStats(["--json"], options)).volume.classified, 3);
  assert.throws(() => runStats(["--days", "x"], options), /usage/);
});

test("createBufferedLog keeps events already on disk", async () => {
  const writes = [];
  const log = createBufferedLog(async (text) => { writes.push(text); }, `${JSON.stringify({ event: "old" })}\n`);
  await log({ event: "new" });
  assert.deepEqual(writes.at(-1).trim().split("\n").map((l) => JSON.parse(l).event), ["old", "new"]);
});

test("summarize keeps spawn decisions out of turns and measures gate skips against hook turns", () => {
  const at = "2026-11-04T00:00:00Z";
  const mod = { at, origin: "mod" };
  const s = summarize([
    { at, event: "prompt", session: "h", provider: "jev", verdict: { placement: "inline" }, failures: [] },
    { at, event: "skip", reason: "gate", session: "h" },
    { ...mod, event: "decision", trigger: "submit", session: "m", provider: "jev", verdict: { placement: "inline" }, failures: [] },
    { ...mod, event: "decision", trigger: "spawn", session: "m", provider: "jev", verdict: { placement: "inline" }, failures: [] },
    { ...mod, event: "manual", session: "m" },
    { ...mod, event: "decision", trigger: "submit", session: "n", provider: "jev", verdict: { placement: "inline" }, failures: [] },
  ], DEFAULTS.pricing);
  assert.equal(s.volume.turns, 4);
  assert.equal(s.volume.gateSkipRate, 0.5);
  assert.equal(s.outcomes.manualOverrideRate, 0.5);
});

test("a heuristic provider under a custom name is counted as heuristic", () => {
  const at = "2026-11-04T00:00:00Z";
  const s = summarize([
    { at, event: "prompt", provider: "rules", heuristic: true, verdict: { placement: "inline", confidence: 0.5 }, failures: [] },
    { at, event: "prompt", provider: "jev", heuristic: false, verdict: { placement: "inline", confidence: 0.9 }, failures: [] },
  ], DEFAULTS.pricing);
  assert.equal(s.health.heuristicRate, 0.5);
  assert.equal(s.verdicts.meanConfidence, 0.9);
});

test("summarize counts hook crashes by hook and message", () => {
  const at = "2026-11-04T00:00:00Z";
  const s = summarize([
    { at, event: "crash", hook: "prompt-submit", error: "boom" },
    { at, event: "crash", hook: "prompt-submit", error: "boom" },
    { at, event: "crash", hook: "agent-model", error: "bad" },
  ], DEFAULTS.pricing);
  assert.deepEqual(s.health.hookCrashes, { "prompt-submit: boom": 2, "agent-model: bad": 1 });
  assert.match(formatSummary(s), /hook crashes 3/);
});

for (const hook of ["prompt-submit", "agent-model"]) {
  test(`${hook} hook logs a crash and still exits cleanly`, () => {
    const home = mkdtempSync(join(tmpdir(), "jev-crash-"));
    const run = spawnSync(process.execPath, [join(import.meta.dirname, "..", "hooks", `${hook}.mjs`)], {
      input: "not json",
      env: { ...process.env, HOME: home },
    });
    assert.equal(run.status, 0);
    const [entry] = readFileSync(join(home, ".local", "state", "jev-relayer", "relay.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(entry.event, "crash");
    assert.equal(entry.hook, hook);
  });
}
