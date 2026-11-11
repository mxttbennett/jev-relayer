import assert from "node:assert/strict";
import { test } from "node:test";
import { costSummary, turnCost } from "../src/cost.mjs";
import { DEFAULTS } from "../src/defaults.mjs";
import { appliedNotice } from "../src/nudge.mjs";
import { isCorrection } from "../src/regret.mjs";
import { formatSummary, summarize } from "../src/stats.mjs";
import { allowsInlineSwitch } from "../src/switching.mjs";
import { isDowngrade, tierOf } from "../src/tiers.mjs";

const { gate, pricing } = DEFAULTS;
const warmLarge = { contextTokens: 80_000, idleMs: 10_000 };

test("tierOf and isDowngrade read tiers from full model ids", () => {
  assert.equal(tierOf("claude-opus-5-5"), "opus");
  assert.equal(tierOf("gpt-6"), null);
  assert.equal(isDowngrade("claude-opus-5-5", "haiku"), true);
  assert.equal(isDowngrade("haiku", "opus"), false);
  assert.equal(isDowngrade("opus", "opus"), false);
  assert.equal(isDowngrade("gpt-6", "haiku"), false);
});

test("upgrades always switch inline, even on a warm large context", () => {
  assert.equal(allowsInlineSwitch({ current: "sonnet", picked: "opus", ...warmLarge }, gate), true);
});

test("downgrades are blocked on a warm large context", () => {
  assert.equal(allowsInlineSwitch({ current: "opus", picked: "haiku", ...warmLarge }, gate), false);
});

test("downgrades switch on a small context or a cold cache", () => {
  // Arrange
  const small = { contextTokens: gate.coldMinTokens - 1, idleMs: 0 };
  const cold = { contextTokens: 80_000, idleMs: gate.cacheTtlMs };
  assert.equal(allowsInlineSwitch({ current: "opus", picked: "haiku", ...small }, gate), true);
  assert.equal(allowsInlineSwitch({ current: "opus", picked: "haiku", ...cold }, gate), true);
});

test("isCorrection matches retries and corrections, not new requests", () => {
  for (const text of ["no, that's wrong", "Try again", "still failing", "you missed the second file", "doesn't work"]) {
    assert.equal(isCorrection(text), true, text);
  }
  for (const text of ["now add a test", "nothing else to change", "explain the cache", ""]) {
    assert.equal(isCorrection(text), false, text);
  }
});

test("turnCost prices each token class and skips unknown models", () => {
  // Arrange
  const usage = { inputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheCreationTokens: 1_000_000, outputTokens: 1_000_000 };
  // Act
  const sonnet = turnCost(usage, "claude-sonnet-5-5", pricing);
  // Assert
  assert.equal(sonnet, 3 + 0.3 + 3.75 + 15);
  assert.equal(turnCost(usage, "gpt-6", pricing), null);
});

test("costSummary compares served cost with the session model baseline", () => {
  // Arrange
  const turn = { inputTokens: 1_000_000, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 0 };
  const applied = [
    { ...turn, sessionModel: "opus", served: "haiku" },
    { ...turn, sessionModel: "opus", served: "gpt-6" },
  ];
  // Act
  const { turns, actual, baseline, saved } = costSummary(applied, pricing);
  // Assert
  assert.equal(turns, 1);
  assert.equal(actual, 1);
  assert.equal(baseline, 5);
  assert.equal(saved, 4);
});

test("summarize reports downgrades, blocked downgrades, regret and estimated savings", () => {
  // Arrange
  const base = { inputTokens: 1_000_000, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 0, sessionModel: "opus", session: "s" };
  const events = [
    { at: "2026-11-06T00:00:00Z", event: "applied", ...base, served: "haiku", downgrade: true },
    { at: "2026-11-06T00:00:01Z", event: "applied", ...base, served: "opus", downgradeBlocked: true },
    { at: "2026-11-06T00:00:02Z", event: "regret", session: "s" },
  ];
  // Act
  const s = summarize(events, pricing);
  const text = formatSummary(s);
  // Assert
  assert.equal(s.outcomes.downgrades, 1);
  assert.equal(s.outcomes.blockedDowngrades, 1);
  assert.equal(s.outcomes.regretRate, 1);
  assert.equal(s.cost.estimate.saved, 4);
  assert.match(text, /downgrades 1 · blocked by warm cache 1 · regret 100.0%/);
  assert.match(text, /saved \$4.00 \(2 turns\)/);
});

test("summarize leaves legacy applied events out of the cost estimate", () => {
  // Arrange
  const events = [{ at: "2026-11-06T00:00:00Z", event: "applied", session: "s", sessionModel: "opus", served: "haiku", inputTokens: 5 }];
  // Act
  const s = summarize(events, pricing);
  // Assert
  assert.equal(s.cost.estimate.turns, 0);
});

test("appliedNotice says what happened: switched, blocked or unchanged", () => {
  // Arrange
  const base = { current: "claude-opus-5-5", picked: "haiku", effort: "low", contextTokens: 151_535, confidence: 0.98 };
  assert.equal(appliedNotice({ ...base, switched: true, blocked: false }), "jev → haiku · low · 0.98");
  assert.equal(appliedNotice({ ...base, switched: false, blocked: true }), "jev: staying on opus · haiku skipped, 152k context is cached · low · 0.98");
  assert.equal(appliedNotice({ ...base, picked: "opus", switched: false, blocked: false, confidence: null }), "jev: opus · low");
});
