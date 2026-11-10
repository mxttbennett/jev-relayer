import { cpSync, existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { legacyDirs } from "./paths.mjs";

export function migrateLegacyDirs(home = homedir()) {
  for (const [source, target] of legacyDirs(home)) {
    if (!existsSync(source)) continue;
    try {
      cpSync(source, target, { recursive: true, force: false, errorOnExist: false });
      rmSync(source, { recursive: true, force: true });
    } catch {}
  }
}
