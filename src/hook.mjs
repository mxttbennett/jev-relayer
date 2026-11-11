import { loadConfig } from "./config.mjs";
import { defaultDeps } from "./deps.mjs";
import { migrateLegacyDirs } from "./legacy.mjs";
import { createStateStore } from "./state.mjs";

export async function runHook(name, handle) {
  const agent = process.argv[2] ?? "claude";
  migrateLegacyDirs();
  try {
    let raw = "";
    for await (const chunk of process.stdin) raw += chunk;
    const input = JSON.parse(raw);
    const config = loadConfig();
    const output = await handle({ input, agent, config, deps: defaultDeps(agent, config) });
    if (output) console.log(JSON.stringify(output));
  } catch (err) {
    createStateStore().log({ event: "crash", hook: name, agent, error: String(err?.message ?? err) });
  }
  process.exit(0);
}
