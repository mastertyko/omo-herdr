import type { ContextUsage, ExtensionContext } from "@code-yeongyu/senpi";
import { stripVTControlCharacters } from "node:util";

export const METADATA_SOURCE = "custom:omo:metadata";
export const METADATA_REFRESH_MS = 15_000;
export const METADATA_TTL_MS = 45_000;
export const METADATA_TOKENS = ["omo_model", "omo_context", "omo_activity"] as const;

export interface Metadata {
  title?: string;
  model?: string;
  context?: string;
  activity?: string;
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
  return {
    title: displayText(ctx.sessionManager.getSessionName()),
    model: displayText(ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined),
    context: contextLabel(ctx.getContextUsage()),
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
  const values = [metadata?.model, metadata?.context, metadata?.activity];
  METADATA_TOKENS.forEach((key, index) => {
    const value = values[index];
    if (value) args.push("--token", `${key}=${value}`);
    else args.push("--clear-token", key);
  });
  return args;
}
