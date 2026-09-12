import type { ExtensionContext } from "@code-yeongyu/senpi";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { OWNER_ENV, type HerdrEnvironment } from "./environment.ts";
import { displayText } from "./metadata.ts";
import type { DeliveryHealth, Reporter } from "./reporter.ts";
import { runCli } from "./transport.ts";

export function environmentIssues(env: NodeJS.ProcessEnv): string[] {
  const issues: string[] = [];
  if (env.HERDR_ENV !== "1") issues.push("Start OmO inside a Herdr pane (HERDR_ENV is not 1).");
  if (!env.HERDR_BIN_PATH || !isAbsolute(env.HERDR_BIN_PATH)) issues.push("HERDR_BIN_PATH must point to an absolute Herdr executable path.");
  if (!env.HERDR_SOCKET_PATH?.trim()) issues.push("HERDR_SOCKET_PATH is missing.");
  if (!env.HERDR_PANE_ID?.trim()) issues.push("HERDR_PANE_ID is missing.");
  return issues;
}

function delivery(label: string, health: DeliveryHealth | undefined): string {
  if (!health?.lastAttemptAt) return `${label}: no report attempted`;
  const lastSuccess = health.lastSuccessAt ? new Date(health.lastSuccessAt).toISOString() : "never";
  return `${label}: ${health.succeeded ? "OK" : `delivery failed (${health.failures} consecutive attempts)`}; last success ${lastSuccess}`;
}

export async function doctorReport(
  ctx: ExtensionContext, environment: HerdrEnvironment | undefined,
  reporter: Reporter | undefined, metadataEnabled: boolean, probe: boolean,
): Promise<string> {
  const issues = environmentIssues(process.env);
  let version = "unknown";
  try { version = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version; } catch { /* Diagnostic only. */ }
  const lines = [`omo-herdr ${displayText(version)} · Node ${process.versions.node}`, `Mode: ${ctx.mode}; UI: ${ctx.hasUI ? "yes" : "no"}`];
  if (probe) {
    try { const { VERSION } = await import("@code-yeongyu/senpi"); lines.push(`Senpi: ${displayText(VERSION)}`); } catch { lines.push("Senpi version unavailable"); }
  }
  if (ctx.mode !== "tui" || !ctx.hasUI) issues.push("Only interactive TUI sessions report to Herdr.");
  const inheritedOwner = process.env[OWNER_ENV];
  lines.push(`Reporter: ${reporter ? "owns this pane" : inheritedOwner && inheritedOwner !== String(process.pid) ? "inactive: nested OmO process" : "inactive: no claim (not started, stopped, or another extension instance owns it)"}`);
  lines.push(`Metadata: ${metadataEnabled ? "enabled" : "disabled by OMO_HERDR_METADATA=0"}`);
  const health = reporter?.diagnostics();
  lines.push(delivery("State", health?.state));
  if (metadataEnabled) lines.push(delivery("Metadata", health?.metadata));
  if (health) lines.push(`Queue: ${health.inFlight ? "sending" : "idle"}${health.pending ? ", latest update pending" : ""}`);
  if (environment) {
    lines.push(`Pane: ${displayText(environment.pane)}; source: custom:omo`);
    lines.push(`Binary: ${displayText(environment.bin, 400)}`);
    lines.push(`Socket: ${displayText(environment.socket, 400)}`);
    if (probe) {
      const [versionResult, paneResult] = await Promise.all([
        runCli(environment, ["--version"], 1500), runCli(environment, ["pane", "get", environment.pane], 1500),
      ]);
      lines.push(`Herdr: ${versionResult.ok ? displayText(versionResult.stdout) : `version probe failed (${versionResult.failure})`}`);
      if (!paneResult.ok) {
        lines.push(`Connection/pane probe failed (${paneResult.failure}). Check that this Herdr server and pane still exist.`);
      } else {
        try {
          const reply = JSON.parse(paneResult.stdout);
          const pane = reply.result?.pane;
          if (reply.error || pane?.pane_id !== environment.pane) throw new Error("unexpected response");
          lines.push(`Connection: OK; Herdr reports ${displayText(pane.agent_status) ?? "unknown"} (${displayText(pane.agent) ?? "no agent"})`);
        } catch { lines.push("Connection: unexpected pane response; check the Herdr version."); }
      }
    }
  }
  lines.push(...issues);
  if (health?.state.succeeded === false || health?.metadata.succeeded === false) lines.push("Failed reports retry automatically. Use /reload after repairing the connection if necessary.");
  return lines.join("\n");
}
