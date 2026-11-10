import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { relayLogFile, sessionsDir, stateDir } from "./paths.mjs";

export const STATE_DIR = stateDir(homedir());

export function createStateStore() {
  const sessions = sessionsDir(STATE_DIR);
  const file = (id) => join(sessions, `${String(id).replace(/[^\w-]/g, "_")}.json`);
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
        mkdirSync(sessions, { recursive: true });
        writeFileSync(file(id), JSON.stringify(state));
      } catch {}
    },
    log(entry) {
      try {
        mkdirSync(STATE_DIR, { recursive: true });
        appendFileSync(
          relayLogFile(STATE_DIR),
          `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
        );
      } catch {}
    },
  };
}
