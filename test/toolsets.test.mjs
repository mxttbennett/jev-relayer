import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveConfig } from "../src/defaults.mjs";
import { buildNudge } from "../src/nudge.mjs";
import { claudeToolsetFlags, toolsetDescriptions } from "../src/toolsets.mjs";
import { classifierPrompt, jevQuestions, parseVerdict, toVerdict } from "../src/prompt.mjs";

const toolsets = {
  lean: { description: "read-only search", claude: { tools: ["Read", "Grep"] } },
  work: { description: "needs Linear", claude: { mcpConfig: "~/mcp-work.json", tools: ["Read", "Bash"] } },
};
const offered = toolsetDescriptions(toolsets);

test("no toolsets key leaves classifier output and verdicts unchanged", () => {
  assert.deepEqual(resolveConfig().toolsets, {});
  assert.doesNotMatch(classifierPrompt({ text: "x" }), /toolset/);
  assert.equal(jevQuestions({}, {}, {}).toolset_choice, undefined);
  assert.equal("toolset" in toVerdict({ placement: "inline" }), false);
});

test("the classifier is offered the user's toolsets and must answer with one", () => {
  assert.match(classifierPrompt({ text: "x", toolsets: offered }), /- work: needs Linear/);
  assert.deepEqual(jevQuestions({}, {}, offered).toolset_choice.criteria, offered);
  assert.equal(parseVerdict('{"placement":"sibling","toolset":"lean"}', {}, {}, offered).toolset, "lean");
  assert.throws(() => toVerdict({ placement: "sibling", toolset: "huge" }, {}, {}, offered), /bad toolset/);
});

test("a toolset becomes claude flags: strict MCP, optional config file, tool list", () => {
  assert.deepEqual(claudeToolsetFlags(toolsets.lean, "/h"), ["--strict-mcp-config", "--tools", "Read,Grep"]);
  assert.deepEqual(claudeToolsetFlags(toolsets.work, "/h"), [
    "--strict-mcp-config",
    "--mcp-config",
    "/h/mcp-work.json",
    "--tools",
    "Read,Bash",
  ]);
  assert.deepEqual(claudeToolsetFlags(undefined), []);
});

test("the sibling command carries the toolset flags before the brief", () => {
  const verdict = { placement: "sibling", model: "haiku", effort: null, confidence: 0.9 };
  const flags = claudeToolsetFlags(toolsets.lean, "/h");
  assert.match(buildNudge(verdict, { agent: "claude", contextTokens: 120000, flags }), /claude --bg --model haiku --strict-mcp-config --tools Read,Grep -- "<brief>"/);
  assert.match(buildNudge(verdict, { agent: "claude", contextTokens: 120000 }), /claude --bg --model haiku "<brief>"/);
});

test("the hook route turns the classifier's toolset into sibling flags", async () => {
  const { handlePrompt } = await import("../src/relay.mjs");
  const config = resolveConfig({ toolsets });
  const seen = [];
  const jev = { remote: true, heuristic: false, run: async (input) => (seen.push(input.toolsets), { placement: "sibling", model: "haiku", effort: "low", toolset: "work", confidence: 0.95 }) };
  const deps = {
    env: {},
    home: "/h",
    now: () => 1_000_000,
    remoteOf: () => "git@github-personal:mxttbennett/x.git",
    readTranscript: () => ({ contextTokens: 150000, lastAt: 1_000_000, turns: [{ role: "user", text: "earlier" }] }),
    providers: { jev },
    state: { load: () => ({}), save() {}, log() {} },
  };
  const out = await handlePrompt({ input: { session_id: "s", prompt: "log my time", cwd: "/x", transcript_path: "/t" }, agent: "claude", config, deps });
  assert.deepEqual(seen[0], offered);
  assert.match(out.context, /--mcp-config \/h\/mcp-work\.json --tools Read,Bash -- "<brief>"/);
});
