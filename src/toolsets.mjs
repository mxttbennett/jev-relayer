export function toolsetDescriptions(toolsets = {}) {
  return Object.fromEntries(Object.entries(toolsets).map(([name, p]) => [name, p.description ?? ""]));
}

export function claudeToolsetFlags(toolset, home) {
  const claude = toolset?.claude;
  if (!claude) return [];
  const flags = ["--strict-mcp-config"];
  if (claude.mcpConfig) flags.push("--mcp-config", claude.mcpConfig.replace(/^~(?=\/)/, home));
  if (claude.tools?.length) flags.push("--tools", claude.tools.join(","));
  return flags;
}
