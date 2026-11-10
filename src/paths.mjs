export const configDir = (home) => `${home}/.config/jev-relayer`;
export const configFile = (home) => `${configDir(home)}/config.json`;
export const legacyConfigFile = (home) => `${home}/.config/jev-relay/config.json`;
export const jevEnvFile = (home) => `${home}/.config/jev-opus/.env`;
export const stateDir = (home) => `${home}/.local/state/jev-relayer`;
export const relayLogFile = (state) => `${state}/relay.log`;
export const sessionsDir = (state) => `${state}/sessions`;
export const breakerFile = (state) => `${state}/breaker.json`;
export const modLogDir = (state) => `${state}/mod`;
export const modLogFile = (state, session) => `${modLogDir(state)}/${session}.jsonl`;

export const legacyDirs = (home) => [
  [`${home}/.config/jev-relay`, configDir(home)],
  [`${home}/.local/state/jev-relay`, stateDir(home)],
];
