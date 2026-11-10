import assert from "node:assert/strict";
import { test } from "node:test";
import { taskLabel } from "../src/task-label.mjs";

test("uses the first non-empty line of the prompt", () => {
  // Arrange
  const prompt = "\n\n  fix the flaky login test  \nthen update the docs";

  // Act
  const label = taskLabel(prompt);

  // Assert
  assert.equal(label, "fix the flaky login test");
});

test("collapses inner whitespace", () => {
  assert.equal(taskLabel("rename   the\tconfig  key"), "rename the config key");
});

test("truncates long prompts with an ellipsis", () => {
  // Act
  const label = taskLabel("a".repeat(200));

  // Assert
  assert.equal(label.length, 60);
  assert.ok(label.endsWith("…"));
});

test("falls back to a generic label for blank prompts", () => {
  assert.equal(taskLabel("   \n "), "Background task");
  assert.equal(taskLabel(undefined), "Background task");
});
