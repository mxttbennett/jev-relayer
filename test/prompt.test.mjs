import assert from "node:assert/strict";
import { test } from "node:test";
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

test("toVerdict keeps a trimmed title and omits a blank one", () => {
  assert.equal(toVerdict({ placement: "subagent", title: "  Fix login test " }).title, "Fix login test");
  assert.equal("title" in toVerdict({ placement: "subagent", title: "  " }), false);
  assert.equal("title" in toVerdict({ placement: "subagent" }), false);
});

test("classifierPrompt asks for a title", () => {
  assert.match(classifierPrompt("x"), /"title":"\.\.\."/);
});
