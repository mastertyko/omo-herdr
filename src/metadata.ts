import type { ContextUsage, ExtensionContext } from "@code-yeongyu/senpi";
import { stripVTControlCharacters } from "node:util";

export const METADATA_SOURCE = "custom:omo:metadata";
export const METADATA_REFRESH_MS = 15_000;
export const METADATA_TTL_MS = 45_000;
const TOKEN_FIELDS = {
  omo_model: "model", omo_context: "context", omo_activity: "activity",
  omo_task: "task", omo_tasks: "tasks", omo_attention: "attention", omo_result: "result",
  omo_branch: "branch", omo_worktree: "worktree", omo_elapsed: "elapsed",
  omo_context_meter: "contextMeter", omo_context_percent: "contextPercent",
} as const;
export const METADATA_TOKENS = Object.keys(TOKEN_FIELDS) as Array<keyof typeof TOKEN_FIELDS>;

export interface Metadata {
  title?: string;
  model?: string;
  context?: string;
  activity?: string;
  task?: string;
  tasks?: string;
  attention?: string;
  result?: string;
  branch?: string;
  worktree?: string;
  elapsed?: string;
  contextMeter?: string;
  contextPercent?: string;
}

export function displayText(value: string | undefined, limit = 160): string | undefined {
  if (!value) return undefined;
  const clean = stripVTControlCharacters(value).replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
  // Herdr validates UTF-8 byte lengths. Keep even multibyte labels bounded.
  let result = "";
  for (const char of clean) {
    if (Buffer.byteLength(result + char) > limit) break;
    result += char;
  }
  return result || undefined;
}

export function contextLabel(usage: ContextUsage | undefined): string | undefined {
  if (!usage || !Number.isFinite(usage.contextWindow) || usage.contextWindow <= 0) return undefined;
  if (usage.tokens === null || usage.percent === null) return "unknown";
  if (!Number.isFinite(usage.tokens) || !Number.isFinite(usage.percent) || usage.tokens < 0 || usage.percent < 0) return undefined;
  return `${Math.round(usage.percent)}% (${Math.round(usage.tokens)}/${Math.round(usage.contextWindow)})`;
}

export function metadataFor(ctx: ExtensionContext, activity?: string): Metadata {
  const usage = ctx.getContextUsage();
  const known = usage && contextLabel(usage) !== undefined && usage.tokens !== null && usage.percent !== null;
  const percent = known ? Math.round(usage.percent!) : undefined;
  return {
    contextPercent: percent === undefined ? undefined : String(percent),
    contextMeter: percent === undefined ? "Context unknown" : `${percent >= 90 ? "Critical context" : percent >= 80 ? "High context" : "Context"} ${percent}%`,
    title: displayText(ctx.sessionManager.getSessionName()),
    model: displayText(ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined),
    context: contextLabel(usage),
    activity: displayText(activity),
  };
}

export function metadataArgs(metadata: Metadata | undefined, seq: number, pane: string): string[] {
  const args = ["pane", "report-metadata", pane, "--source", METADATA_SOURCE,
    "--agent", "omo", "--applies-to-source", "custom:omo", "--seq", String(seq),
    "--ttl-ms", String(METADATA_TTL_MS)];
  if (metadata?.title) args.push("--title", metadata.title);
  else args.push("--clear-title");
  if (metadata?.activity) args.push("--state-label", `working=${metadata.activity}`);
  else args.push("--clear-state-labels");
  METADATA_TOKENS.forEach(key => {
    const value = displayText(metadata?.[TOKEN_FIELDS[key]]);
    if (value) args.push("--token", `${key}=${value}`);
    else args.push("--clear-token", key);
  });
  return args;
}
