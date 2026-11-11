import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { agentNames } from "./agents.mjs";
import { CONFIG_PATH, loadConfig, readUserConfig } from "./config.mjs";
import { merge } from "./defaults.mjs";
import { runStats } from "./stats.mjs";

function setEnabled(userConfig, agents, enabled) {
  const patch = Object.fromEntries(agents.map((agent) => [agent, { enabled }]));
  return merge(userConfig, { agents: patch });
}

function resolveAgents(target) {
  if (target === "all" || target === undefined) return agentNames;
  if (!agentNames.includes(target)) throw new Error(`unknown agent: ${target} (${[...agentNames, "all"].join(", ")})`);
  return [target];
}

function writeUser(path, config) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

export function runCli(argv, path = CONFIG_PATH) {
  const [command, target] = argv;
  if (command === "stats") return runStats(argv.slice(1), { pricing: loadConfig(path).pricing });
  if (command === "status" || command === undefined) {
    const { agents, band } = loadConfig(path);
    const lines = agentNames.map((a) => `${a}: ${agents[a].enabled === false ? "off" : "on"}`);
    return [...lines, `band: ${band.enabled ? "on" : "off"}`].join("\n");
  }
  if (command === "band") {
    if (target !== "on" && target !== "off") throw new Error("usage: jev-relayer band on|off");
    writeUser(path, merge(readUserConfig(path), { band: { enabled: target === "on" } }));
    return runCli(["status"], path);
  }
  if (command !== "on" && command !== "off") {
    throw new Error(`usage: jev-relayer status|stats|on|off [${[...agentNames, "all"].join("|")}]|band on|off`);
  }
  writeUser(path, setEnabled(readUserConfig(path), resolveAgents(target), command === "on"));
  return runCli(["status"], path);
}
