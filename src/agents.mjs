import { claudeToolsetFlags } from "./toolsets.mjs";
import { claudeLine, codexLine } from "./transcripts.mjs";

export const AGENTS = {
  claude: {
    parseLine: claudeLine,
    subagentModel: true,
    toolsetFlags: claudeToolsetFlags,
    siblingArgv: (model, flags = []) => [
      "claude",
      "--bg",
      ...(model ? ["--model", model] : []),
      ...flags,
      ...(flags.length ? ["--"] : []),
    ],
  },
  codex: {
    parseLine: codexLine,
    subagentModel: false,
    siblingArgv: (model) => ["codex", "exec", ...(model ? ["-m", model] : [])],
  },
};

export const agentNames = Object.keys(AGENTS);
