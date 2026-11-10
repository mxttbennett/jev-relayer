import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { stateDir } from "./paths.mjs";

export const STATE_DIR = stateDir(homedir());

export function createStateStore(dir = STATE_DIR) {
  const file = (id) => join(dir, "sessions", `${String(id).replace(/[^\w-]/g, "_")}.json`);
  return {
    load(id) {
      try {
        return JSON.parse(readFileSync(file(id), "utf8"));
      } catch {
        return {};
      }
    },
    save(id, state) {
      try {
        mkdirSync(join(dir, "sessions"), { recursive: true });
        writeFileSync(file(id), JSON.stringify(state));
      } catch {}
    },
    log(entry) {
      try {
        mkdirSync(dir, { recursive: true });
        appendFileSync(
          join(dir, "relay.log"),
          `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
        );
      } catch {}
    },
  };
}
