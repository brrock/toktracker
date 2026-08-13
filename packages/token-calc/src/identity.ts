/* eslint-disable func-style, no-misleading-character-class, prefer-named-capture-group, require-unicode-regexp, unicorn/prefer-array-find */
// Regexes intentionally mirror upstream normalization rules.
export function inferProvider(model: string): string | undefined {
  const id = model.toLowerCase();
  if (/claude|anthropic/.test(id)) {
    return "anthropic";
  }
  if (/^(gpt|o[134]|codex)|openai/.test(id)) {
    return "openai";
  }
  if (/gemini|google/.test(id)) {
    return "google";
  }
  if (/deepseek/.test(id)) {
    return "deepseek";
  }
  if (/qwen/.test(id)) {
    return "alibaba";
  }
  if (/grok/.test(id)) {
    return "xai";
  }
  if (/mistral|codestral/.test(id)) {
    return "mistral";
  }
  return undefined;
}

export function canonicalProvider(provider: string): string {
  const id = provider.trim().toLowerCase();
  const aliases = {
    "azure-openai": "azure",
    copilot: "github-copilot",
    github: "github-copilot",
    "google-generative-ai": "google",
    "google-vertex": "google",
  } as const;
  return Object.entries(aliases).find(([alias]) => alias === id)?.[1] ?? id;
}

interface NormalizedWorkspace {
  key?: string;
  label?: string;
}

export function normalizeWorkspace(raw?: string): NormalizedWorkspace {
  if (!raw?.trim()) {
    return {};
  }
  const unc = raw.trim().startsWith("//") || raw.trim().startsWith("\\\\");
  let key = raw
    .trim()
    .replaceAll("\\", "/")
    .replaceAll(/\/{2,}/g, "/");
  if (unc) {
    key = `//${key.replace(/^\/+/, "")}`;
  }
  if (key.length > (unc ? 2 : 1)) {
    key = key.replace(/\/+$/, "");
  }
  return { key, label: key.split("/").filter(Boolean).at(-1) };
}

const titleWord = (word: string) =>
  ["ui", "ux", "api"].includes(word.toLowerCase())
    ? word.toUpperCase()
    : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
export function normalizeAgent(agent: string): string {
  const clean = agent
    .replaceAll(/[\u200B\u200C\u200D\uFEFF]/g, "")
    .trim()
    .replace(/^(astrape:|oh-my-claudecode:|oh-my-codex:)/i, "")
    .replaceAll(/\s+/g, " ");
  const low = clean.toLowerCase();
  if (
    /^sisyphus( \(ultraworker\)| - ultraworker| ultraworker)?$/.test(low) ||
    low === "omo"
  ) {
    return "Sisyphus";
  }
  if (/^hephaestus( \(deep agent\)| - deep agent| deep agent)?$/.test(low)) {
    return "Hephaestus";
  }
  if (
    /^prometheus( \((plan builder|planner)\)| - plan builder| plan builder)?$/.test(
      low
    )
  ) {
    return "Prometheus";
  }
  if (
    /^atlas( \(plan executor\)| - plan executor| plan executor)?$/.test(low) ||
    low === "orchestrator-sisyphus"
  ) {
    return "Atlas";
  }
  if (
    /^metis( \(plan consultant\)| - plan consultant| plan consultant)?$/.test(
      low
    )
  ) {
    return "Metis";
  }
  if (
    /^momus( \((plan critic|plan reviewer)\)| - plan critic| plan critic)?$/.test(
      low
    )
  ) {
    return "Momus";
  }
  if (
    low.includes("plan") &&
    (low.includes("omo") || low.includes("sisyphus"))
  ) {
    return "Planner-Sisyphus";
  }
  return clean
    .split(/[-\s]+/)
    .map(titleWord)
    .join(" ");
}
