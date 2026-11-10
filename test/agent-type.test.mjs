import test from "node:test";
import assert from "node:assert/strict";
import { classifierPrompt, jevQuestions, toVerdict } from "../src/prompt.mjs";

test("toVerdict keeps a known agent type and drops an unknown or missing one", () => {
  assert.equal(toVerdict({ placement: "subagent", agent: "Explore" }).agent, "Explore");
  assert.equal("agent" in toVerdict({ placement: "subagent", agent: "dotnet-core-expert" }), false);
  assert.equal("agent" in toVerdict({ placement: "subagent" }), false);
});

test("classifierPrompt and jevQuestions ask for the agent type", () => {
  assert.match(classifierPrompt("x"), /"agent":"\.\.\."/);
  assert.ok(Object.hasOwn(jevQuestions().agent_choice.criteria, "Explore"));
});
