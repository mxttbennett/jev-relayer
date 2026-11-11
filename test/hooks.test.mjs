import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sameModel } from "../src/tiers.mjs";

function home({ contextTokens }) {
  const dir = mkdtempSync(join(tmpdir(), "jev-hook-"));
  mkdirSync(join(dir, ".config", "jev-relayer"), { recursive: true });
  writeFileSync(join(dir, ".config", "jev-relayer", "config.json"), JSON.stringify({ chain: ["heuristics"] }));
  const transcript = join(dir, "t.jsonl");
  const usage = { input_tokens: contextTokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  writeFileSync(transcript, `${JSON.stringify({ type: "assistant", message: { content: "ok", usage }, timestamp: new Date().toISOString() })}\n`);
  return { dir, transcript };
}

const runHook = (name, dir, input) =>
  spawnSync(process.execPath, [join(import.meta.dirname, "..", "hooks", `${name}.mjs`), "claude"], {
    input: JSON.stringify(input),
    env: { ...process.env, HOME: dir, JEV_RELAYER: "", JEV_RELAY: "" },
    encoding: "utf8",
  });

test("prompt-submit hook reads the transcript and injects a subagent nudge on a large context", () => {
  const { dir, transcript } = home({ contextTokens: 150000 });
  const run = runHook("prompt-submit", dir, { session_id: "s", prompt: "audit the whole repo for leaks", cwd: dir, transcript_path: transcript });
  const output = JSON.parse(run.stdout);
  assert.equal(output.systemMessage, "↪ jev-relayer: subagent · 0.50 · via heuristics");
  assert.match(output.hookSpecificOutput.additionalContext, /conversation is large \(150k tokens\)/);
});

test("agent-model hook leaves the Agent call alone when only heuristics answer", () => {
  const { dir } = home({ contextTokens: 0 });
  const run = runHook("agent-model", dir, { session_id: "s", cwd: dir, tool_input: { prompt: "list the files" } });
  assert.equal(run.status, 0);
  assert.equal(run.stdout, "");
});

test("sameModel matches a tier alias against a full model id, either way round", () => {
  assert.equal(sameModel("haiku", "claude-haiku-5-5"), true);
  assert.equal(sameModel("claude-opus-5-5", "Opus"), true);
  assert.equal(sameModel("haiku", "claude-opus-5-5"), false);
});

