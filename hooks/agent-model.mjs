#!/usr/bin/env node
import { runHook } from "../src/hook.mjs";
import { modelNotice } from "../src/nudge.mjs";
import { pickSubagent } from "../src/relay.mjs";

await runHook("agent-model", async (args) => {
  const pick = await pickSubagent(args);
  if (!pick) return null;
  const { model, effort } = pick;
  return {
    systemMessage: modelNotice({ model, effort }),
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      updatedInput: { ...args.input.tool_input, ...(model && { model }), ...(effort && { effort }) },
    },
  };
});
