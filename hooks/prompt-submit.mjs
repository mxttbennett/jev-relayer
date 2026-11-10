#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { runHook } from "../src/hook.mjs";
import { sendNotification } from "../src/notify.mjs";
import { handlePrompt } from "../src/relay.mjs";

await runHook("prompt-submit", async (args) => {
  const advice = await handlePrompt(args);
  if (!advice) return null;
  if (args.config.macNotifications && advice.notice) {
    await sendNotification({
      message: advice.notice,
      readTranscript: () => readFileSync(args.input.transcript_path, "utf8"),
      run: ([cmd, ...argv]) => void execFile(cmd, argv, { timeout: 3000 }, () => {}),
    });
  }
  const output = { systemMessage: advice.notice };
  if (advice.context) {
    output.hookSpecificOutput = { hookEventName: "UserPromptSubmit", additionalContext: advice.context };
  }
  return output;
});
