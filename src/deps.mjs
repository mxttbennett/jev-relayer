import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { AGENTS } from "./agents.mjs";
import { createBreaker } from "./breaker.mjs";
import { gitOriginArgv } from "./defaults.mjs";
import { parseEnv } from "./envfile.mjs";
import { breakerFile, jevEnvFile } from "./paths.mjs";
import { createProviders } from "./providers.mjs";
import { STATE_DIR, createStateStore } from "./state.mjs";
import { parseTranscript } from "./transcripts.mjs";

const TAIL_BYTES = 1_000_000;
const BREAKER_FILE = breakerFile(STATE_DIR);

function readTail(path) {
  try {
    const fd = openSync(path, "r");
    try {
      const { size } = fstatSync(fd);
      const length = Math.min(size, TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      const text = buffer.toString("utf8");
      return size > length ? text.slice(text.indexOf("\n") + 1) : text;
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

function readEnvFile(path) {
  try {
    return parseEnv(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function gitRemote(cwd) {
  const [cmd, ...args] = gitOriginArgv(cwd);
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).trim();
  } catch {
    return "";
  }
}

const fileBreaker = () =>
  createBreaker({
    read: () => JSON.parse(readFileSync(BREAKER_FILE, "utf8")),
    write: (entries) => {
      mkdirSync(dirname(BREAKER_FILE), { recursive: true });
      writeFileSync(BREAKER_FILE, JSON.stringify(entries));
    },
  });

const timedFetch = (url, { timeoutMs, ...init }) => fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });

export function defaultDeps(agent, config) {
  const spec = AGENTS[agent];
  if (!spec) throw new Error(`unsupported agent: ${agent}`);
  const env = process.env;
  const home = homedir();
  return {
    env,
    home,
    now: Date.now,
    remoteOf: gitRemote,
    state: createStateStore(),
    breaker: fileBreaker(),
    readTranscript: (path) => parseTranscript(readTail(path), spec.parseLine),
    providers: createProviders(config, { env, fetch: timedFetch, readJevEnv: () => readEnvFile(jevEnvFile(home)) }),
  };
}
