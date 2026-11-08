import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { profileFor as matchRepo, resolveConfig } from "./defaults.mjs";

export { DEFAULTS, describeModels, isEnabled, merge } from "./defaults.mjs";

export const CONFIG_PATH = join(homedir(), ".config", "jev-relayer", "config.json");

export function loadConfig(path = CONFIG_PATH) {
  let user = {};
  try {
    user = JSON.parse(readFileSync(path, "utf8"));
  } catch {}
  return resolveConfig(user);
}

export function gitRemote(cwd) {
  try {
    return execFileSync("git", ["-C", cwd, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    }).trim();
  } catch {
    return "";
  }
}

export const profileFor = (config, cwd, remoteOf = gitRemote) => matchRepo(config, cwd, remoteOf);
