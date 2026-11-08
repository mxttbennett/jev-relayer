import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runChain } from "../src/chain.mjs";
import { DEFAULTS, isEnabled, loadConfig, merge, profileFor } from "../src/config.mjs";
import { resolveConfig } from "../src/defaults.mjs";
import { migrateLegacyDirs } from "../src/legacy.mjs";
import { heuristicVerdict, shouldClassify } from "../src/heuristics.mjs";
import { parseVerdict } from "../src/prompt.mjs";
import { createProviders } from "../src/providers.mjs";
import { redact } from "../src/redact.mjs";
import { readTranscript, claudeLine, codexLine } from "../src/transcripts.mjs";
import { resolveAgents, runCli, setEnabled } from "../src/toggle.mjs";

const gate = DEFAULTS.gate;

test("redact masks strong identifiers and counts them", () => {
  const { text, hits } = redact("mail jo@acme.com ssn 123-45-6789 call 555-123-4567 re Acme", ["Acme"]);
  assert.equal(hits, 4);
  assert.ok(!/acme|123-45|555/i.test(text));
});

test("redact masks weak patterns without counting a hit", () => {
  const { text, hits } = redact("on 3/4/2026 order 1234567\n```\ncode\n```");
  assert.equal(hits, 0);
  assert.equal(text.includes("[date]") && text.includes("[id]") && text.includes("[code block]"), true);
});

test("gate opens on size, or on a cold cache with a non-trivial context", () => {
  assert.equal(shouldClassify({ contextTokens: 150000, idleMs: 0 }, gate), true);
  assert.equal(shouldClassify({ contextTokens: 30000, idleMs: 400000 }, gate), true);
  assert.equal(shouldClassify({ contextTokens: 5000, idleMs: 400000 }, gate), false);
  assert.equal(shouldClassify({ contextTokens: 30000, idleMs: 1000 }, gate), false);
});

test("gate opens for the first earlyPrompts prompts whatever the context size", () => {
  assert.equal(shouldClassify({ contextTokens: 62000, idleMs: 0, priorPrompts: 0 }, gate), true);
  assert.equal(shouldClassify({ contextTokens: 62000, idleMs: 0, priorPrompts: gate.earlyPrompts - 1 }, gate), true);
  assert.equal(shouldClassify({ contextTokens: 62000, idleMs: 0, priorPrompts: gate.earlyPrompts }, gate), false);
});

test("heuristics nudge only on a clear signal", () => {
  const big = { contextTokens: 150000, idleMs: 0 };
  assert.equal(heuristicVerdict({ prompt: "audit every file for X", ...big }, gate).placement, "subagent");
  assert.equal(heuristicVerdict({ prompt: "new task: unrelated cleanup", ...big }, gate).placement, "sibling");
  assert.equal(heuristicVerdict({ prompt: "fix that typo", ...big }, gate).placement, "inline");
  assert.equal(heuristicVerdict({ prompt: "audit every file", contextTokens: 30000, idleMs: 0 }, gate).placement, "inline");
});

test("parseVerdict reads JSON inside prose and rejects bad enums", () => {
  assert.deepEqual(parseVerdict('ok {"placement":"subagent","model":"haiku","confidence":0.8}', { haiku: "d" }), {
    placement: "subagent",
    model: "haiku",
    effort: null,
    confidence: 0.8,
  });
  assert.throws(() => parseVerdict('{"placement":"elsewhere","model":"haiku"}', { haiku: "d" }));
  assert.throws(() => parseVerdict("no json"));
});

test("chain falls through failures and flags degraded only when heuristics answers after a failure", async () => {
  const ok = { heuristic: false, run: async () => ({ placement: "inline", model: "sonnet", confidence: 1 }) };
  const bad = { heuristic: false, run: async () => { throw new Error("down"); } };
  const heur = { heuristic: true, run: async () => ({ placement: "inline", model: null, confidence: 0.5 }) };

  const first = await runChain(["bad", "ok", "heur"], { bad, ok, heur }, {});
  assert.equal(first.provider, "ok");
  assert.equal(first.degraded, false);
  assert.equal(first.failures.length, 1);

  const allDown = await runChain(["bad", "heur"], { bad, heur }, {});
  assert.equal(allDown.provider, "heur");
  assert.equal(allDown.degraded, true);

  const onlyHeuristics = await runChain(["heur"], { heur }, {});
  assert.equal(onlyHeuristics.degraded, false);

  const none = await runChain(["bad"], { bad }, {});
  assert.equal(none.degraded, true);
  assert.equal(none.verdict.placement, "inline");
});

test("an out-of-range minConfidence falls back to the default", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-"));
  const file = join(dir, "config.json");
  for (const bad of ["high", 1.5, -1]) {
    writeFileSync(file, JSON.stringify({ minConfidence: bad }));
    assert.equal(loadConfig(file).minConfidence, 0.6);
  }
  writeFileSync(file, JSON.stringify({ minConfidence: 0.8 }));
  assert.equal(loadConfig(file).minConfidence, 0.8);
});

test("an out-of-range siblingMinConfidence falls back to the default", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-"));
  const file = join(dir, "config.json");
  writeFileSync(file, JSON.stringify({ siblingMinConfidence: 2 }));
  assert.equal(loadConfig(file).siblingMinConfidence, 0.85);
  writeFileSync(file, JSON.stringify({ siblingMinConfidence: 0.7 }));
  assert.equal(loadConfig(file).siblingMinConfidence, 0.7);
});

test("config merges user overrides, replaces arrays, and classifies repos by profile", () => {
  const merged = merge(DEFAULTS, { chain: ["heuristics"], agents: { codex: { enabled: false } } });
  assert.deepEqual(merged.chain, ["heuristics"]);
  assert.deepEqual(merged.profiles, []);
  assert.equal(isEnabled(merged, "codex", {}), false);
  assert.equal(isEnabled(merged, "claude", {}), true);
  assert.equal(isEnabled(merged, "claude", { JEV_RELAYER: "off" }), false);
  assert.equal(isEnabled(merged, "claude", { JEV_RELAY: "off" }), false);
  assert.equal(isEnabled(merged, "claude", { JEV_RELAY: "off" }), false);
  const config = merge(DEFAULTS, {
    profiles: [
      { name: "personal", match: ["mxttbennett"], chain: ["pc", "heuristics"] },
      { name: "client", match: ["acme-corp"] },
    ],
  });
  const remote = (url) => profileFor(config, "/x", () => url);
  assert.deepEqual(remote("git@github-personal:mxttbennett/dots.git"), { name: "personal", chain: ["pc", "heuristics"] });
  assert.deepEqual(remote("git@github.com:acme-corp/app.git"), { name: "client", chain: DEFAULTS.chain });
  assert.deepEqual(remote("git@github.com:other/app.git"), { name: "default", chain: DEFAULTS.chain });
  assert.deepEqual(profileFor(config, "/x", () => ""), { name: "default", chain: DEFAULTS.chain });
  assert.equal(profileFor(DEFAULTS, "/x", () => "git@github-personal:mxttbennett/dots.git").name, "default");
});

test("jev provider tries OpenRouter then TypeSafe and accepts JEV_API_KEY", async () => {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    if (url.includes("openrouter")) return { ok: false, status: 500 };
    return { ok: true, json: async () => ({ answers: { placement: { choice: "sibling", confidence: 0.9 }, model_choice: { choice: "opus" } } }) };
  };
  const env = { OPENROUTER_API_KEY: "a", JEV_API_KEY: "b" };
  const { jev } = createProviders(DEFAULTS, { config: DEFAULTS, env, fetch });
  assert.deepEqual(await jev.run({ text: "x", models: { opus: "d" } }), { placement: "sibling", model: "opus", effort: null, confidence: 0.9 });
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
  const providers = createProviders(config, { config, env: {}, fetch });
  const verdict = await providers.local.run({ text: "user: hi", models: { sonnet: "d" } });
  assert.equal(body.think, true);
  assert.equal(body.model, "bonsai-2:27b");
  assert.equal(verdict.model, "sonnet");
});

test("claude transcript yields context size, last assistant time and recent prose turns", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-"));
  const file = join(dir, "t.jsonl");
  const rows = [
    { type: "user", message: { role: "user", content: "first question" }, timestamp: "2026-01-01T00:00:00Z" },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "answer" }, { type: "tool_use" }], usage: { input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 5 } }, timestamp: "2026-01-01T00:00:05Z" },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", content: "SECRET ROWS" }] }, timestamp: "2026-01-01T00:00:06Z" },
    { type: "assistant", isSidechain: true, message: { role: "assistant", content: "ignored" } },
  ];
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n"));
  const snap = readTranscript(file, claudeLine);
  assert.equal(snap.contextTokens, 105);
  assert.equal(snap.lastAt, Date.parse("2026-01-01T00:00:05Z"));
  assert.deepEqual(snap.turns.map((t) => t.text), ["first question", "answer"]);
  assert.deepEqual(readTranscript(join(dir, "missing.jsonl"), claudeLine).turns, []);
});

test("codex transcript yields last input tokens, timestamp and prose turns, skipping injected context", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-"));
  const file = join(dir, "rollout.jsonl");
  const rows = [
    { timestamp: "2026-01-01T00:00:00Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions for /x" }] } },
    { timestamp: "2026-01-01T00:00:01Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "refactor the parser" }] } },
    { timestamp: "2026-01-01T00:00:02Z", type: "response_item", payload: { type: "reasoning", summary: [] } },
    { timestamp: "2026-01-01T00:00:03Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 22906 } } } },
    { timestamp: "2026-01-01T00:00:04Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] } },
  ];
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n"));
  const snap = readTranscript(file, codexLine);
  assert.equal(snap.contextTokens, 22906);
  assert.equal(snap.lastAt, Date.parse("2026-01-01T00:00:03Z"));
  assert.deepEqual(snap.turns, [
    { role: "user", text: "refactor the parser" },
    { role: "assistant", text: "done" },
  ]);
});

test("toggle writes per-agent flags and reports status", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-"));
  const path = join(dir, "config.json");
  assert.equal(runCli(["status"], path), "claude: on\ncodex: on\nband: off");
  assert.equal(runCli(["off", "codex"], path), "claude: on\ncodex: off\nband: off");
  assert.equal(runCli(["on", "all"], path), "claude: on\ncodex: on\nband: off");
  assert.equal(runCli(["band", "on"], path), "claude: on\ncodex: on\nband: on");
  assert.throws(() => runCli(["band", "maybe"], path));
  assert.deepEqual(setEnabled({}, ["claude"], false), { agents: { claude: { enabled: false } } });
  assert.throws(() => resolveAgents("gemini"));
  assert.equal(loadConfig(path).agents.codex.enabled, true);
});

test("a heavy prompt opens the gate from the lower floor, and an ordinary one does not", () => {
  const at = (contextTokens, prompt) => shouldClassify({ contextTokens, idleMs: 0, prompt }, gate);
  assert.equal(at(85000, "alright /peer-review-pr"), true);
  assert.equal(at(85000, "fix the typo in the readme"), false);
  assert.equal(at(25000, "/peer-review-pr"), false);
  assert.equal(at(50000, "audit the whole repo for leaks"), true);
  assert.equal(at(50000, "please use /parallel here"), true);
  assert.equal(at(50000, "what does peer-review-pr do"), false);
});

test("an invalid heavy pattern is ignored instead of breaking the gate", () => {
  const broken = { ...gate, heavyPatterns: ["(", "\\bboom\\b"] };
  assert.equal(shouldClassify({ contextTokens: 50000, idleMs: 0, prompt: "boom" }, broken), true);
  assert.equal(shouldClassify({ contextTokens: 50000, idleMs: 0, prompt: "calm" }, broken), false);
});

test("heuristics call a heavy slash command a subagent task once the gate is open", () => {
  assert.equal(heuristicVerdict({ prompt: "/deep-plan x", contextTokens: 60000, idleMs: 0 }, gate).placement, "subagent");
});

test("the status notice is on by default and a user config can turn it off", () => {
  // Arrange
  const user = { statusNotice: false };

  // Act
  const defaults = resolveConfig();
  const overridden = resolveConfig(user);

  // Assert
  assert.equal(defaults.statusNotice, true);
  assert.equal(overridden.statusNotice, false);
});

test("notification helpers build an escape-free osascript call and detect changes", async () => {
  const { notifyCommand, decisionLabel, isChange } = await import("../src/notify.mjs");
  // Arrange
  const verdict = { placement: "inline", model: "haiku", effort: "low", confidence: 0.9 };
  // Act & Assert
  assert.deepEqual(notifyCommand('say "hi"').slice(-2), ['say "hi"', "jev-relayer"]);
  assert.equal(decisionLabel(verdict), "inline · haiku · low · 0.90");
  assert.equal(isChange(null, verdict), true);
  assert.equal(isChange(verdict, { ...verdict, confidence: 0.5 }), false);
  assert.equal(isChange(verdict, { ...verdict, model: "opus" }), true);
});

test("session title is the latest ai-title in the transcript", async () => {
  const { sessionTitle } = await import("../src/transcripts.mjs");
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  // Arrange
  const path = join(mkdtempSync(join(tmpdir(), "jr-")), "s.jsonl");
  writeFileSync(path, ['{"type":"ai-title","aiTitle":"old"}', '{"type":"user"}', '{"type":"ai-title","aiTitle":"new name"}'].join("\n") + "\n");
  // Act & Assert
  assert.equal(sessionTitle(path), "new name");
  assert.equal(sessionTitle("/nope/missing.jsonl"), "");
});

test("modules the mod imports use no node builtins", async () => {
  const { readFileSync } = await import("node:fs");
  // Arrange
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    for (const [, spec] of source.matchAll(/from ['"]([^'"]+)['"]/g)) {
      // Act & Assert
      assert.ok(!spec.startsWith("node:"), `${file} imports ${spec}`);
      if (spec.startsWith(".")) walk(new URL(spec, new URL(file, import.meta.url)).href);
    }
  };
  walk("../hooks/register.tsx");
});

test("sendNotification titles the notification from the transcript for any caller", async () => {
  const { sendNotification, transcriptPath } = await import("../src/notify.mjs");
  const ran = [];
  const run = (argv) => ran.push(argv);
  // Arrange
  const transcript = '{"type":"ai-title","aiTitle":"Fix login"}\n';
  // Act
  await sendNotification({ message: "m", readTranscript: () => transcript, run });
  await sendNotification({ message: "m", readTranscript: () => Promise.reject(new Error("x")), run });
  // Assert
  assert.equal(ran[0].at(-1), "Fix login");
  assert.equal(ran[1].at(-1), "jev-relayer");
  assert.equal(transcriptPath({ configDir: "/c", cwd: "/a/b_c", id: "i" }), "/c/projects/-a-b-c/i.jsonl");
});

test("sendNotification finds an ai-title that sits before the last megabyte", async () => {
  const { sendNotification } = await import("../src/notify.mjs");
  const ran = [];
  // Arrange
  const transcript = '{"type":"ai-title","aiTitle":"Early title"}\n' + '{"type":"user","text":"x"}\n'.repeat(60_000);
  // Act
  await sendNotification({ message: "m", readTranscript: () => transcript, run: (argv) => ran.push(argv) });
  // Assert
  assert.equal(ran[0].at(-1), "Early title");
});

test("breaker skips a provider after repeated failures until the cooldown ends", async () => {
  const { memoryBreaker } = await import("../src/breaker.mjs");
  const { runChain } = await import("../src/chain.mjs");
  let t = 0;
  let calls = 0;
  const breaker = memoryBreaker({ now: () => t, threshold: 2, cooldownMs: 1000 });
  const providers = {
    bad: { heuristic: false, run: async () => { calls++; throw new Error("down"); } },
    ok: { heuristic: false, run: async () => ({ placement: "inline" }) },
  };
  for (let i = 0; i < 4; i++) await runChain(["bad", "ok"], providers, {}, breaker);
  assert.equal(calls, 2);
  const skipped = await runChain(["bad", "ok"], providers, {}, breaker);
  assert.equal(skipped.failures[0].error, "circuit open");
  t = 1001;
  await runChain(["bad", "ok"], providers, {}, breaker);
  assert.equal(calls, 3);
  await runChain(["bad", "ok"], providers, {}, breaker);
  assert.equal(calls, 3);
});

test("legacy jev-relay config and state move to jev-relayer without overwriting newer files", () => {
  const home = mkdtempSync(join(tmpdir(), "jev-"));
  mkdirSync(join(home, ".config", "jev-relay"), { recursive: true });
  mkdirSync(join(home, ".local", "state", "jev-relay", "mod"), { recursive: true });
  mkdirSync(join(home, ".local", "state", "jev-relayer"), { recursive: true });
  writeFileSync(join(home, ".config", "jev-relay", "config.json"), '{"report":"every-turn"}');
  writeFileSync(join(home, ".local", "state", "jev-relay", "relay.log"), "old\n");
  writeFileSync(join(home, ".local", "state", "jev-relay", "mod", "s.jsonl"), "old-mod\n");
  writeFileSync(join(home, ".local", "state", "jev-relayer", "relay.log"), "new\n");
  migrateLegacyDirs(home);
  assert.equal(readFileSync(join(home, ".config", "jev-relayer", "config.json"), "utf8"), '{"report":"every-turn"}');
  assert.equal(readFileSync(join(home, ".local", "state", "jev-relayer", "relay.log"), "utf8"), "new\n");
  assert.equal(readFileSync(join(home, ".local", "state", "jev-relayer", "mod", "s.jsonl"), "utf8"), "old-mod\n");
  assert.equal(existsSync(join(home, ".config", "jev-relay")), false);
});
