#!/usr/bin/env node
import { runHook } from "../src/hook.mjs";
import { modelNotice } from "../src/nudge.mjs";
import { pickSubagentModel } from "../src/relay.mjs";

await runHook("agent-model", async (args) => {
  const model = await pickSubagentModel(args);
  if (!model) return null;
  return {
    systemMessage: modelNotice(model),
    hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { ...args.input.tool_input, model } },
  };
});
