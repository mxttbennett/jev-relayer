import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolveConfig } from "./defaults.mjs";
import { configFile } from "./paths.mjs";

export const CONFIG_PATH = configFile(homedir());

export function loadConfig(path = CONFIG_PATH) {
  let user = {};
  try {
    user = JSON.parse(readFileSync(path, "utf8"));
  } catch {}
  return resolveConfig(user);
}
