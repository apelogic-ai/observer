export const AGENT_COLORS: Record<string, string> = {
  claude_code: "#58a6ff",
  codex: "#3fb950",
  cursor: "#bc8cff",
};

export const TOKEN_COLORS = {
  input: "#58a6ff",
  output: "#3fb950",
  cache_read: "#d29922",
  cache_creation: "#f778ba",
};

export const GIT_COLORS = {
  agent: "#58a6ff",
  human: "#8b949e",
  insertions: "#3fb950",
  deletions: "#f85149",
};

export const CHART_PALETTE = [
  "#58a6ff", "#3fb950", "#bc8cff", "#d29922", "#f778ba",
  "#79c0ff", "#56d364", "#d2a8ff", "#e3b341", "#ff7b72",
];

export function agentColor(agent: string): string {
  return AGENT_COLORS[agent] ?? "#8b949e";
}
