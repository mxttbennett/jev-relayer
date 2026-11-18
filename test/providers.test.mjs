import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULTS, merge } from "../src/defaults.mjs";
import { defaultDeps } from "../src/deps.mjs";
import { createProviders } from "../src/providers.mjs";

test("jev provider tries OpenRouter then TypeSafe and accepts JEV_API_KEY", async () => {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    if (url.includes("openrouter")) return { ok: false, status: 500 };
    return { ok: true, json: async () => ({ answers: { placement: { choice: "sibling", confidence: 0.9 }, model_choice: { choice: "opus" } } }) };
  };
  const env = { OPENROUTER_API_KEY: "a", JEV_API_KEY: "b" };
  const { jev } = createProviders(DEFAULTS, { env, fetch });
  assert.deepEqual(await jev.run({ text: "x", offered: { model: { opus: "d" } } }), { placement: "sibling", model: "opus", effort: null, toolset: null, confidence: 0.9 });
  assert.equal(calls.length, 2);
  assert.ok(calls[1].includes("typesafe"));
});

test("ollama provider sends think:true and reads message.content", async () => {
  let body;
  const fetch = async (_url, init) => {
    body = JSON.parse(init.body);
    return { ok: true, json: async () => ({ message: { content: '{"placement":"inline","model":"sonnet"}' } }) };
  };
  const config = merge(DEFAULTS, { providers: { local: { type: "ollama", baseUrl: "http://127.0.0.1:11435", model: "bonsai-2:27b", timeoutMs: 6000 } } });
  const providers = createProviders(config, { env: {}, fetch });
  const verdict = await providers.local.run({ text: "user: hi", offered: { model: { sonnet: "d" } } });
  assert.equal(body.think, true);
  assert.equal(body.model, "bonsai-2:27b");
  assert.equal(verdict.model, "sonnet");
});

test("apple provider sends the tail of the excerpt with every choice list and parses the helper's JSON", async () => {
  let argv;
  const run = async (args) => {
    argv = args;
    return { exitCode: 0, stdout: '{"placement":"subagent","agent":"Explore","model":"haiku","title":"Find exports","confidence":0.7}' };
  };
  const config = merge(DEFAULTS, { providers: { apple: { type: "apple", binary: "/bin/helper", timeoutMs: 8000 } } });
  const { apple } = createProviders(config, { env: {}, run });
  const verdict = await apple.run({ text: "user: tail", offered: { model: { haiku: "d" } } });
  const request = JSON.parse(argv[1]);
  assert.equal(argv[0], "/bin/helper");
  assert.ok(request.prompt.includes("user: tail"));
  assert.deepEqual(request.choices.model, ["haiku"]);
  assert.deepEqual(request.choices.placement, ["inline", "subagent", "sibling"]);
  assert.equal(apple.remote, false);
  assert.deepEqual(verdict, { placement: "subagent", agent: "Explore", model: "haiku", effort: null, toolset: null, title: "Find exports", confidence: 0.7 });
});

test("apple provider throws when the helper fails so the chain moves on", async () => {
  const config = merge(DEFAULTS, { providers: { apple: { type: "apple" } } });
  const { apple } = createProviders(config, { env: {}, run: async () => ({ exitCode: 69, stdout: "" }) });
  await assert.rejects(apple.run({ text: "user: hi", offered: {} }), /exited 69/);
});

test("apple provider runs the helper as a real process through the default deps", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-apple-"));
  const ok = join(dir, "ok");
  writeFileSync(ok, `#!/bin/sh\necho '{"placement":"inline","agent":"Plan","title":"t","confidence":0.5}'\n`, { mode: 0o755 });
  const providersFor = (binary) => defaultDeps("claude", merge(DEFAULTS, { providers: { apple: { type: "apple", binary, timeoutMs: 5000 } } })).providers;
  assert.equal((await providersFor(ok).apple.run({ text: "user: hi", offered: {} })).placement, "inline");
  await assert.rejects(providersFor("/usr/bin/false").apple.run({ text: "user: hi", offered: {} }), /exited 1/);
});
