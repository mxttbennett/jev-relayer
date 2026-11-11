import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.mjs";
import { DEFAULTS, merge, resolveConfig } from "../src/defaults.mjs";
import { classifierPrompt, jevQuestions, parseVerdict, toVerdict } from "../src/prompt.mjs";
import { createProviders } from "../src/providers.mjs";
import { classify } from "../src/classify.mjs";
import { handlePrompt as run } from "../src/relay.mjs";

const handlePrompt = async (args) => (await run(args))?.context ?? null;

const two = { haiku: "fast things", sonnet: "everyday things" };

test("a model outside the offered list is rejected, so the chain moves on", () => {
  assert.equal(toVerdict({ placement: "inline", model: "sonnet" }, { model: two }).model, "sonnet");
  assert.throws(() => toVerdict({ placement: "inline", model: "opus" }, { model: two }), /bad model/);
  assert.throws(() => parseVerdict('{"placement":"inline","model":"gpt"}', { model: two }));
  assert.equal(toVerdict({ placement: "inline" }, {}).model, null);
});

test("the classifier is only offered the listed models, with their descriptions", () => {
  const prompt = classifierPrompt("x", { model: two });
  assert.match(prompt, /- sonnet: everyday things/);
  assert.doesNotMatch(prompt, /opus/);
  assert.deepEqual(jevQuestions({ model: two }).model_choice.criteria, two);
  assert.equal(jevQuestions({}).model_choice, undefined);
  assert.doesNotMatch(classifierPrompt("x", { model: {} }), /"model"/);
});

test("the jev request carries only the listed models", async () => {
  let body;
  const fetch = async (_url, init) => {
    body = JSON.parse(init.body);
    return { ok: true, json: async () => ({ answers: { placement: { choice: "inline" }, model_choice: { choice: "sonnet" } } }) };
  };
  const { jev } = createProviders(DEFAULTS, { env: { OPENROUTER_API_KEY: "k" }, fetch });
  const verdict = await jev.run({ text: "x", offered: { model: two } });
  assert.deepEqual(Object.keys(body.questions.model_choice.criteria), ["haiku", "sonnet"]);
  assert.equal(verdict.model, "sonnet");
});

test("a user models list replaces the default list for that agent only", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-"));
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({ models: { claude: { sonnet: "only this" } } }));
  const config = loadConfig(path);
  assert.deepEqual(config.models.claude, { sonnet: "only this" });
  assert.deepEqual(Object.keys(config.models.codex), Object.keys(DEFAULTS.models.codex));
});

test("classify passes each agent its own models, and none when an agent lists none", async () => {
  const seen = [];
  const providers = { heuristics: { remote: false, heuristic: true, run: async (input) => { seen.push(Object.keys(input.offered.model)); return { placement: "inline", model: null }; } } };
  const config = merge(DEFAULTS, { chain: ["heuristics"] });
  config.models = { claude: two, codex: {} };
  const deps = { providers, remoteOf: () => "" };
  await classify({ text: "x", prompt: "x", agent: "claude", cwd: "/x" }, config, deps);
  await classify({ text: "x", prompt: "x", agent: "codex", cwd: "/x" }, config, deps);
  assert.deepEqual(seen, [["haiku", "sonnet"], []]);
});

function relayDeps(provider) {
  return {
    env: {}, now: () => 1_000_000, remoteOf: () => "git@github-personal:mxttbennett/x.git",
    readTranscript: () => ({ contextTokens: 150000, lastAt: 1_000_000, turns: [{ role: "user", text: "earlier prompt" }] }),
    providers: { jev: provider },
    state: { load: () => ({}), save() {}, log() {} },
  };
}
const input = { session_id: "s", prompt: "do the other thing", cwd: "/x", transcript_path: "/t" };

test("codex sibling command carries the Codex model name the classifier chose", async () => {
  const jev = { remote: true, heuristic: false, run: async () => ({ placement: "sibling", model: "gpt-6.1-terra" }) };
  const out = await handlePrompt({ input, agent: "codex", config: DEFAULTS, deps: relayDeps(jev) });
  assert.match(out, /codex exec -m gpt-6\.1-terra "<brief>"/);
});

test("claude sibling command names the model, and drops the flag when there is none", async () => {
  const named = { remote: true, heuristic: false, run: async () => ({ placement: "sibling", model: "sonnet" }) };
  assert.match(await handlePrompt({ input, agent: "claude", config: DEFAULTS, deps: relayDeps(named) }), /claude --bg --model sonnet "<brief>"/);
  const none = { remote: true, heuristic: false, run: async () => ({ placement: "sibling", model: null }) };
  assert.match(await handlePrompt({ input, agent: "claude", config: DEFAULTS, deps: relayDeps(none) }), /run: claude --bg "<brief>"/);
});

test("a plain list of model names borrows the built-in descriptions; unknown names keep what you wrote", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-"));
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({ models: { claude: ["sonnet"], codex: { "gpt-6-luna": "", "gpt-x": "my own model" } } }));
  const config = loadConfig(path);
  assert.deepEqual(config.models.claude, { sonnet: DEFAULTS.models.claude.sonnet });
  assert.deepEqual(config.models.codex, { "gpt-6-luna": DEFAULTS.models.codex["gpt-6-luna"], "gpt-x": "my own model" });
});

const levels = { low: "little reasoning", high: "hard reasoning" };

test("an effort outside the offered list is rejected, and none is kept when no efforts are listed", () => {
  // Arrange
  const reply = (effort) => ({ placement: "inline", model: "sonnet", effort });

  assert.equal(toVerdict(reply("high"), { model: two, effort: levels }).effort, "high");
  assert.throws(() => toVerdict(reply("max"), { model: two, effort: levels }), /bad effort/);
  assert.equal(toVerdict(reply("high"), { model: two, effort: {} }).effort, null);
  assert.equal(parseVerdict('{"placement":"inline","model":"sonnet","effort":"low"}', { model: two, effort: levels }).effort, "low");
});

test("the classifier is only asked about the listed efforts", () => {
  // Act
  const prompt = classifierPrompt("x", { model: two, effort: levels });
  const questions = jevQuestions({ model: two, effort: levels });

  // Assert
  assert.match(prompt, /- low: little reasoning/);
  assert.match(prompt, /- high: hard reasoning/);
  assert.match(prompt, /"effort":"\.\.\."/);
  assert.deepEqual(questions.effort_choice.criteria, levels);
  assert.equal(jevQuestions({ model: two, effort: {} }).effort_choice, undefined);
  assert.doesNotMatch(classifierPrompt("x", { model: two, effort: {} }), /effort/);
});

test("the jev provider reads the effort answer", async () => {
  // Arrange
  const fetch = async () => ({
    ok: true,
    json: async () => ({ answers: { placement: { choice: "inline" }, model_choice: { choice: "sonnet" }, effort_choice: { choice: "low" } } }),
  });
  const { jev } = createProviders(DEFAULTS, { env: { OPENROUTER_API_KEY: "k" }, fetch });

  // Act
  const verdict = await jev.run({ text: "x", offered: { model: two, effort: levels } });

  // Assert
  assert.equal(verdict.effort, "low");
});

test("a low-confidence verdict drops its effort along with its model", async () => {
  // Arrange
  const verdict = { placement: "subagent", model: "haiku", effort: "high", confidence: 0.2 };
  const providers = { jev: { remote: false, heuristic: false, run: async () => verdict } };
  const config = merge(DEFAULTS, { chain: ["jev"] });

  // Act
  const { verdict: classified } = await classify({ text: "x", prompt: "x", agent: "claude", cwd: "/x" }, config, { providers, remoteOf: () => "" });

  // Assert
  assert.deepEqual(classified, { placement: "inline", model: null, effort: null, toolset: null, confidence: 0.2 });
});

test("a user efforts list replaces the default list, and an empty one stops the effort question", () => {
  // Act
  const subset = resolveConfig({ efforts: { low: "quick" } });
  const none = resolveConfig({ efforts: {} });

  // Assert
  assert.deepEqual(subset.efforts, { low: "quick" });
  assert.deepEqual(none.efforts, {});
});
