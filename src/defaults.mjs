const FAST =
  "Lookups, explaining code, git, test and build chores, renames, formatting, boilerplate, and edits whose change is already specified. Prefer this whenever the task is clear and low-risk";
const BALANCED =
  "Feature work and debugging where the approach is not yet obvious, and edits spanning several files. Not for work that is merely long or tedious";
const STRONG =
  "Architecture decisions, hard debugging, security-sensitive work, large multi-file refactors, complex planning";

const CLAUDE_MODELS = { haiku: FAST, sonnet: BALANCED, opus: STRONG };
const CODEX_MODELS = { "gpt-6-luna": FAST, "gpt-6.1-terra": BALANCED, "gpt-6.1-sol": STRONG };

const KNOWN_MODELS = { ...CLAUDE_MODELS, ...CODEX_MODELS };

function describeModels(models) {
  const entries = Array.isArray(models) ? models.map((name) => [name, ""]) : Object.entries(models);
  return Object.fromEntries(entries.map(([name, why]) => [name, why || KNOWN_MODELS[name] || ""]));
}

export const DEFAULTS = {
  agents: { claude: { enabled: true }, codex: { enabled: true } },
  gate: {
    contextTokens: 100000,
    cacheTtlMs: 300000,
    coldMinTokens: 20000,
    earlyPrompts: 3,
    heavyFloorTokens: 40000,
    heavyPatterns: [
      "(^|\\s)/(peer-review-pr|deep-plan|quick-wins|untested|code-review|security-review|parallel|babysit-pr)\\b",
      "\\b(audit|review) (the )?(whole|entire|all)\\b",
      "\\bacross (the )?(repo|codebase)\\b",
      "\\bfind all\\b",
      "\\bevery (file|usage|place)\\b",
    ],
  },
  cooldown: { prompts: 3, growth: 0.25 },
  pricing: {
    haiku: { input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 5 },
    sonnet: { input: 3, cacheRead: 0.3, cacheWrite: 3.75, output: 15 },
    opus: { input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 25 },
  },
  minConfidence: 0.6,
  siblingMinConfidence: 0.85,
  band: { enabled: false },
  statusNotice: true,
  macNotifications: false,
  report: "changes",
  profiles: [],
  models: { claude: CLAUDE_MODELS, codex: CODEX_MODELS },
  efforts: {
    low: "Mechanical, lookup or clearly specified work. The default unless the task needs weighing options",
    medium: "Coding or review that needs weighing options or tracing behavior across files",
    high: "Hard debugging, design and multi-step reasoning",
    xhigh: "The hardest work where extra reasoning pays off",
  },
  toolsets: {},
  redact: { names: [] },
  chain: ["jev", "heuristics"],
  providers: {
    jev: { type: "jev", timeoutMs: 5000 },
    heuristics: { type: "heuristics" },
  },
};

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export function merge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) return override ?? base;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) out[key] = merge(base[key], value);
  return out;
}

const REPLACED_LISTS = ["efforts", "toolsets"];
const UNIT_INTERVAL = ["minConfidence", "siblingMinConfidence"];

export function resolveConfig(user = {}) {
  const config = merge(DEFAULTS, user);
  for (const key of UNIT_INTERVAL) if (!(config[key] >= 0 && config[key] <= 1)) config[key] = DEFAULTS[key];
  for (const key of REPLACED_LISTS) if (user[key]) config[key] = user[key];
  const written = Object.entries(user.models ?? {}).map(([agent, models]) => [agent, describeModels(models)]);
  config.models = { ...DEFAULTS.models, ...Object.fromEntries(written) };
  return config;
}

const OFF_SWITCHES = ["JEV_RELAYER", "JEV_RELAY"];
const MODEL_OPTION_NAME = "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME";
export const RELAY_ENV_NAMES = [...OFF_SWITCHES, MODEL_OPTION_NAME];

export const isSelfRouted = (env) => env[MODEL_OPTION_NAME] === "Jev Router";

export function isEnabled(config, agent, env = {}) {
  if (OFF_SWITCHES.some((name) => env[name] === "off")) return false;
  return config.agents[agent]?.enabled !== false;
}

export const gitOriginArgv = (cwd) => ["git", "-C", cwd, "remote", "get-url", "origin"];

export function profileFor(config, cwd, remoteOf) {
  const remote = cwd ? remoteOf(cwd) : "";
  const entry = config.profiles.find((r) => r.match?.some((m) => remote.includes(m)));
  return { name: entry?.name ?? "default", chain: entry?.chain ?? config.chain };
}
