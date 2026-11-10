import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULTS, merge } from "../src/defaults.mjs";
import { createProviders } from "../src/providers.mjs";
import { handlePrompt as run, pickSubagentModel } from "../src/relay.mjs";

const handlePrompt = async (args) => (await run(args))?.context ?? null;

function setup({ providers, config = DEFAULTS, snapshot, remote = "git@github-personal:mxttbennett/x.git" } = {}) {
  const store = new Map();
  const logs = [];
  const deps = {
    env: {},
    now: () => 1_000_000,
    remoteOf: () => remote,
    readTranscript: () => snapshot ?? { contextTokens: 150000, lastAt: 1_000_000, turns: [] },
    providers,
    state: {
      load: (id) => structuredClone(store.get(id) ?? {}),
      save: (id, s) => store.set(id, structuredClone(s)),
      log: (e) => logs.push(e),
    },
  };
  return { deps, store, logs, config };
}

const answer = (verdict, remote = false) => ({ remote, heuristic: false, run: async () => verdict });
const down = (remote = false) => ({ remote, heuristic: false, run: async () => { throw new Error("down"); } });
const heuristics = { remote: false, heuristic: true, run: async () => ({ placement: "inline", model: null, confidence: 0.5 }) };
const priorTurn = { contextTokens: 150000, lastAt: 1_000_000, turns: [{ role: "user", text: "earlier prompt" }] };
const input = { session_id: "s", prompt: "audit the repo", cwd: "/x", transcript_path: "/t" };

test("silent below the gate", async () => {
  const { deps, config } = setup({ providers: { jev: answer({ placement: "subagent", model: "haiku" }, true), heuristics }, snapshot: { contextTokens: 30000, lastAt: 1_000_000, turns: [1, 2, 3].map((n) => ({ role: "user", text: `earlier ${n}` })) } });
  assert.equal(await handlePrompt({ input, agent: "claude", config, deps }), null);
});

test("nudges to a subagent and caches the model pick", async () => {
  const { deps, config, store } = setup({ providers: { jev: answer({ placement: "subagent", model: "haiku", confidence: 0.9 }, true), heuristics } });
  const out = await handlePrompt({ input, agent: "claude", config, deps });
  assert.match(out, /subagent with model haiku/);
  assert.equal(store.get("s").model.value, "haiku");
  assert.equal(await pickSubagentModel({ input: { session_id: "s", tool_input: { prompt: "p" } }, agent: "claude", config, deps }), "haiku");
});

test("a remote verdict below minConfidence is treated as inline", async () => {
  const { deps, config, store } = setup({ providers: { jev: answer({ placement: "subagent", model: "haiku", confidence: 0.4 }, true), heuristics } });
  assert.equal(await handlePrompt({ input, agent: "claude", config, deps }), null);
  assert.equal(store.get("s").model, undefined);
});

test("heuristic verdicts ignore minConfidence", async () => {
  const { deps, config } = setup({ providers: { heuristics: { remote: false, heuristic: true, run: async () => ({ placement: "subagent", model: null, confidence: 0.5 }) } } });
  assert.match(await handlePrompt({ input, agent: "claude", config, deps }), /subagent/);
});

test("sibling nudge names the native background command", async () => {
  const { deps, config } = setup({ providers: { jev: answer({ placement: "sibling", model: "sonnet" }, true), heuristics }, snapshot: priorTurn });
  assert.match(await handlePrompt({ input, agent: "claude", config, deps }), /claude --bg/);
});

test("cooldown silences the next prompts, then re-evaluates", async () => {
  const { deps, config } = setup({ providers: { jev: answer({ placement: "subagent", model: "haiku" }, true), heuristics } });
  await handlePrompt({ input, agent: "claude", config, deps });
  for (let i = 0; i < 3; i += 1) assert.equal(await handlePrompt({ input, agent: "claude", config, deps }), null);
  assert.match(await handlePrompt({ input, agent: "claude", config, deps }), /subagent/);
});

test("a redaction hit keeps the prompt away from remote providers in personal and work repos", async () => {
  for (const remote of ["git@github-personal:mxttbennett/x.git", "git@github.com:acme-corp/work-app.git"]) {
    // Arrange
    let called = false;
    const jev = { remote: true, heuristic: false, run: async () => { called = true; return { placement: "inline", model: "sonnet" }; } };
    const { deps, config } = setup({ providers: { jev, heuristics }, remote });
    // Act
    await handlePrompt({ input: { ...input, prompt: "email jo@acme.com about it" }, agent: "claude", config, deps });
    // Assert
    assert.equal(called, false, remote);
  }
});

test("a local provider between jev and heuristics still answers when a redaction hit drops jev", async () => {
  // Arrange
  const jev = down(true);
  const pc = answer({ placement: "subagent", model: "sonnet" });
  const config = merge(DEFAULTS, { chain: ["jev", "pc", "heuristics"] });
  const { deps } = setup({ providers: { jev, pc, heuristics } });
  // Act
  const context = await handlePrompt({ input: { ...input, prompt: "email jo@acme.com about it" }, agent: "claude", config, deps });
  // Assert
  assert.match(context, /subagent with model sonnet/);
});

test("a local provider answers after jev fails and before heuristics", async () => {
  // Arrange
  const pc = answer({ placement: "subagent", model: "sonnet" });
  const config = merge(DEFAULTS, { chain: ["jev", "pc", "heuristics"] });
  const { deps } = setup({ providers: { jev: down(true), pc, heuristics } });
  // Act
  const context = await handlePrompt({ input, agent: "claude", config, deps });
  // Assert
  assert.match(context, /subagent with model sonnet/);
});

test("ollama and openai-compat providers count as local unless marked remote", () => {
  // Arrange
  const providers = {
    a: { type: "ollama", baseUrl: "http://x" },
    b: { type: "openai-compat", baseUrl: "http://x" },
    c: { type: "ollama", baseUrl: "http://x", remote: true },
  };
  // Act
  const made = createProviders({ providers }, {});
  // Assert
  assert.deepEqual([made.a.remote, made.b.remote, made.c.remote], [false, false, true]);
});

test("a profile picks its own chain by origin URL", async () => {
  // Arrange
  const pc = answer({ placement: "subagent", model: "sonnet" });
  const config = merge(DEFAULTS, { profiles: [{ name: "mine", match: ["mxttbennett"], chain: ["pc"] }] });
  const { deps } = setup({ providers: { jev: down(true), pc, heuristics } });
  // Act
  const context = await handlePrompt({ input, agent: "claude", config, deps });
  // Assert
  assert.match(context, /subagent with model sonnet/);
});

test("work repos classify through the remote provider when the prompt is clean", async () => {
  // Arrange
  const jev = answer({ placement: "subagent", model: "sonnet" }, true);
  const { deps, config } = setup({ remote: "git@github.com:acme-corp/work-app.git", providers: { jev, heuristics } });
  // Act
  const context = await handlePrompt({ input, agent: "claude", config, deps });
  // Assert
  assert.match(context, /subagent with model sonnet/);
});

test("degraded notice appears once per session and re-arms after a success", async () => {
  const config = merge(DEFAULTS, { chain: ["jev", "heuristics"] });
  const providers = { jev: down(true), heuristics };
  const { deps } = setup({ providers, config });
  assert.match(await handlePrompt({ input, agent: "claude", config, deps }), /degraded/);
  assert.equal(await handlePrompt({ input, agent: "claude", config, deps }), null);
  providers.jev = answer({ placement: "inline", model: "sonnet" }, true);
  assert.equal(await run({ input, agent: "claude", config, deps }), null);
  providers.jev = down(true);
  assert.match(await handlePrompt({ input, agent: "claude", config, deps }), /degraded/);
});

test("disabled agent does nothing", async () => {
  const config = merge(DEFAULTS, { agents: { claude: { enabled: false } } });
  const { deps } = setup({ providers: { jev: answer({ placement: "subagent", model: "haiku" }, true), heuristics } });
  assert.equal(await handlePrompt({ input, agent: "claude", config, deps }), null);
  assert.equal(await pickSubagentModel({ input: { tool_input: { prompt: "p" } }, agent: "claude", config, deps }), null);
});

test("codex gets nudges with its sibling command and never a subagent model pick", async () => {
  const { deps, config } = setup({ providers: { jev: answer({ placement: "sibling", model: "sonnet" }, true), heuristics }, snapshot: priorTurn });
  assert.match(await handlePrompt({ input, agent: "codex", config, deps }), /codex exec/);
  assert.equal(await pickSubagentModel({ input: { tool_input: { prompt: "p" } }, agent: "codex", config, deps }), null);
});

test("subagent model pick stays out of the way when the session runs on the Jev Router model", async () => {
  const { deps, config } = setup({ providers: { jev: answer({ placement: "inline", model: "opus" }, true), heuristics } });
  deps.env = { ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: "Jev Router" };
  assert.equal(await pickSubagentModel({ input: { session_id: "n", cwd: "/x", tool_input: { prompt: "p" } }, agent: "claude", config, deps }), null);
});

test("subagent model pick skips explicit models and forks, and classifies on a cache miss", async () => {
  const { deps, config } = setup({ providers: { jev: answer({ placement: "inline", model: "opus" }, true), heuristics } });
  const call = (tool_input) => pickSubagentModel({ input: { session_id: "n", cwd: "/x", tool_input }, agent: "claude", config, deps });
  assert.equal(await call({ prompt: "p", model: "haiku" }), null);
  assert.equal(await call({ prompt: "p", subagent_type: "fork" }), null);
  assert.equal(await call({ prompt: "p" }), "opus");
});

test("each nudge carries a short user-facing notice, and the degraded warning has its own", async () => {
  const { deps, config } = setup({ providers: { jev: answer({ placement: "subagent", model: "haiku" }, true), heuristics } });
  assert.equal((await run({ input, agent: "claude", config, deps })).notice, "↪ jev-relayer: subagent · haiku");

  const sibling = setup({ providers: { jev: answer({ placement: "sibling", model: null }, true), heuristics }, snapshot: priorTurn });
  assert.equal((await run({ input, agent: "claude", config: sibling.config, deps: sibling.deps })).notice, "↪ jev-relayer: sibling session");

  const down = setup({ providers: { jev: { remote: true, heuristic: false, run: async () => { throw new Error("x"); } }, heuristics } });
  assert.equal((await run({ input, agent: "claude", config: down.config, deps: down.deps })).notice, "⚠ jev-relayer: no classifier answered, using heuristics");
});

test("a low-confidence turn drops the cached model so the next pick is fresh", async () => {
  const { deps, config, store } = setup({ providers: { jev: answer({ placement: "subagent", model: "haiku", confidence: 0.4 }, true), heuristics } });
  store.set("s", { model: { value: "opus", at: 1_000_000 } });
  await handlePrompt({ input, agent: "claude", config, deps });
  assert.equal(store.get("s").model, undefined);
});

test("notices show the verdict confidence when the classifier reports one", async () => {
  const sub = setup({ providers: { jev: answer({ placement: "subagent", model: "haiku", confidence: 0.9 }, true), heuristics } });
  assert.equal((await run({ input, agent: "claude", config: sub.config, deps: sub.deps })).notice, "↪ jev-relayer: subagent · haiku · 0.90");
});

test("every-turn reporting says when a turn was skipped or cooling down", async () => {
  const every = (config) => merge(config, { report: "every-turn" });
  const small = setup({ providers: { jev: answer({ placement: "inline", model: "sonnet" }, true), heuristics }, snapshot: { contextTokens: 30000, lastAt: 1_000_000, turns: [1, 2, 3].map((n) => ({ role: "user", text: `earlier ${n}` })) } });
  const skipped = await run({ input, agent: "claude", config: every(small.config), deps: small.deps });
  assert.deepEqual(skipped, { context: "", notice: "· jev-relayer: skipped · 30k tokens, cache warm" });
  assert.equal(await run({ input, agent: "claude", config: small.config, deps: small.deps }), null);

  const cooling = setup({ providers: { jev: answer({ placement: "subagent", model: "haiku" }, true), heuristics } });
  await run({ input, agent: "claude", config: every(cooling.config), deps: cooling.deps });
  const next = await run({ input, agent: "claude", config: every(cooling.config), deps: cooling.deps });
  assert.equal(next.notice, "· jev-relayer: skipped · cooling down (1/3)");
});

test("an inline verdict prints nothing from the hook, with or without every-turn reporting", async () => {
  // Arrange
  const { deps, config } = setup({ providers: { jev: answer({ placement: "inline", model: "haiku", confidence: 0.9 }, true), heuristics } });
  // Act
  const normal = await run({ input, agent: "claude", config, deps });
  const every = await run({ input, agent: "claude", config: merge(config, { report: "every-turn" }), deps });
  // Assert
  assert.equal(normal, null);
  assert.equal(every, null);
});

test("a sibling verdict on the first prompt of a session is not offered", async () => {
  const { deps, config, logs } = setup({ providers: { jev: answer({ placement: "sibling", model: "sonnet", confidence: 0.9 }, true), heuristics } });
  assert.equal(await handlePrompt({ input, agent: "claude", config, deps }), null);
  assert.equal(logs[0].downgraded, "first-prompt");
  assert.equal(logs[0].rawVerdict.placement, "sibling");
});

test("a sibling verdict below siblingMinConfidence is treated as inline, one above it is offered", async () => {
  const weak = setup({ providers: { jev: answer({ placement: "sibling", model: "sonnet", confidence: 0.7 }, true), heuristics }, snapshot: priorTurn });
  assert.equal(await handlePrompt({ input, agent: "claude", config: weak.config, deps: weak.deps }), null);
  assert.equal(weak.logs[0].downgraded, "weak-sibling");
  const strong = setup({ providers: { jev: answer({ placement: "sibling", model: "sonnet", confidence: 0.9 }, true), heuristics }, snapshot: priorTurn });
  assert.match(await handlePrompt({ input, agent: "claude", config: strong.config, deps: strong.deps }), /claude --bg/);
});

test("a low-confidence log entry keeps a redacted, truncated prompt, and a confident one does not", async () => {
  const low = setup({ providers: { jev: answer({ placement: "subagent", model: "haiku", confidence: 0.3 }, true), heuristics }, remote: "git@github.com:work/x.git" });
  const long = `ask about 1234567 ${"x".repeat(400)}`;
  await run({ input: { ...input, prompt: long }, agent: "claude", config: low.config, deps: low.deps });
  assert.ok(low.logs[0].prompt.length <= 200);
  assert.ok(!low.logs[0].prompt.includes("1234567"));
  const high = setup({ providers: { jev: answer({ placement: "subagent", model: "haiku", confidence: 0.9 }, true), heuristics } });
  await run({ input, agent: "claude", config: high.config, deps: high.deps });
  assert.equal("prompt" in high.logs[0], false);
});
