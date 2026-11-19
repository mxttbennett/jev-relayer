import assert from "node:assert/strict";
import test from "node:test";
import { lowConfidenceModel, nearestModel, overrideRank, rankOf } from "../src/policy.mjs";

const claude = ["haiku", "sonnet", "opus"];

test("rankOf places claude and codex model names on one scale", () => {
  assert.equal(rankOf("claude-opus-5"), 2);
  assert.equal(rankOf("gpt-6-luna"), 0);
  assert.equal(rankOf("gpt-6.1-terra"), 1);
  assert.equal(rankOf("unknown"), null);
});

test("overrideRank reads an explicit model request and ignores a mention", () => {
  assert.equal(overrideRank("use opus for this"), 2);
  assert.equal(overrideRank("please switch to haiku"), 0);
  assert.equal(overrideRank("run this on sonnet"), 1);
  assert.equal(overrideRank("explain how opus differs from sonnet"), null);
  assert.equal(overrideRank("use the sonnet api"), null);
});

test("nearestModel prefers the next stronger model, then the strongest cheaper one", () => {
  assert.equal(nearestModel(1, ["haiku", "opus"]), "opus");
  assert.equal(nearestModel(2, ["haiku", "sonnet"]), "sonnet");
  assert.equal(nearestModel(0, claude), "haiku");
  assert.equal(nearestModel(0, ["x"]), null);
});

test("lowConfidenceModel never downgrades and caps an upgrade at sonnet", () => {
  assert.equal(lowConfidenceModel("haiku", "opus", claude), null);
  assert.equal(lowConfidenceModel("opus", "haiku", claude), "sonnet");
  assert.equal(lowConfidenceModel("sonnet", "haiku", claude), "sonnet");
  assert.equal(lowConfidenceModel("opus", "sonnet", claude), null);
  assert.equal(lowConfidenceModel("opus", "unknown", claude), null);
});
