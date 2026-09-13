import type { ExtensionAPI, ExtensionContext, UIPromptKind } from "@code-yeongyu/senpi";
import { isAbsolute } from "node:path";
import { doctorReport } from "./doctor.ts";
import { claimPane, readEnvironment } from "./environment.ts";
import { displayText, metadataFor } from "./metadata.ts";
import { Overview } from "./overview.ts";
import { cliTransport, Reporter } from "./reporter.ts";

export default function omoHerdr(pi: ExtensionAPI): void {
  const environment = readEnvironment(process.env);
  const metadataEnabled = process.env.OMO_HERDR_METADATA !== "0";
  let reporter: Reporter | undefined;
  let releaseClaim: (() => void) | undefined;
  let active = false;
  let compacting = false;
  const tools = new Map<string, string>();
  const userInputs = new Set<string>();
  let prompts: Array<{ kind: UIPromptKind; title?: string }> = [];

  pi.registerCommand("herdr", {
    description: "Inspect the Herdr integration",
    argumentHint: "[status|doctor]",
    handler: async (args, ctx) => {
      const action = args.trim() || "status";
      if (action !== "doctor" && action !== "status") {
        ctx.ui.notify("Usage: /herdr [status|doctor]", "warning");
        return;
      }
      ctx.ui.notify(await doctorReport(ctx, environment, reporter, metadataEnabled, action === "doctor"), "info");
    },
  });
  if (!environment) return;
  const overview = metadataEnabled ? new Overview(pi, publish) : undefined;

  function reset(): void {
    active = false;
    compacting = false;
    tools.clear();
    userInputs.clear();
    prompts = [];
  }

  function publish(ctx: ExtensionContext): void {
    if (!reporter) return;
    const prompt = prompts.at(-1);
    const file = ctx.sessionManager.getSessionFile();
    const running = Array.from(tools.values());
    const activity = compacting ? "Compacting context" : running.length
      ? `Running ${running.at(-1)}${running.length > 1 ? ` (+${running.length - 1})` : ""}` : undefined;
    reporter.report({
      state: prompt ? "blocked" : active || compacting ? "working" : "idle",
      message: prompt ? "Waiting for user input" : undefined,
      sessionId: ctx.sessionManager.getSessionId(),
      sessionPath: file && isAbsolute(file) ? file : undefined,
      metadata: metadataEnabled ? { ...metadataFor(ctx, activity), ...overview?.metadata(!!prompt, Date.now(), activity) } : undefined,
    });
  }

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    if (!reporter) {
      releaseClaim = claimPane();
      if (!releaseClaim) return;
      reporter = new Reporter(environment.pane, cliTransport(environment));
    }
    // New/resumed/forked sessions can reuse the same extension instance.
    reset();
    overview?.start(ctx);
    active = !ctx.isIdle() || ctx.hasPendingMessages();
    compacting = ctx.isCompacting?.() ?? false;
    if (active || compacting) overview?.begin();
    publish(ctx);
  });

  // Input is only a candidate until interception and admission have completed.
  pi.on("input", event => {
    if (reporter && overview && event.source !== "extension") userInputs.add(event.inputId);
  });
  pi.on("input_disposition", (event, ctx) => {
    if (!userInputs.delete(event.inputId)) return;
    if (event.disposition !== "started" && event.disposition !== "queued") return;
    overview?.newWork();
    publish(ctx);
  });
  // Autonomous turns and active resumes restart timing, not explicit metadata.
  pi.on("agent_start", (_event, ctx) => { if (!reporter) return; active = true; overview?.begin(); publish(ctx); });
  // agent_end can precede retries, compaction and queued continuations.
  pi.on("agent_settled", (_event, ctx) => {
    if (!reporter) return;
    active = false;
    overview?.settle();
    tools.clear();
    publish(ctx);
  });
  pi.on("session_abort", (_event, ctx) => {
    if (!reporter) return;
    active = false;
    compacting = false;
    overview?.settle(true);
    tools.clear();
    publish(ctx);
  });
  pi.on("ui_prompt_start", (event, ctx) => {
    if (!reporter) return;
    prompts.push({ kind: event.kind, title: event.title });
    publish(ctx);
  });
  pi.on("ui_prompt_end", (event, ctx) => {
    if (!reporter) return;
    const index = prompts.findLastIndex((prompt) => prompt.kind === event.kind && prompt.title === event.title);
    if (index < 0) return;
    prompts.splice(index, 1);
    publish(ctx);
  });
  pi.on("tool_execution_start", (event, ctx) => {
    if (!reporter) return;
    tools.set(event.toolCallId, displayText(event.toolName, 64) ?? "tool");
    active = true;
    publish(ctx);
  });
  pi.on("tool_execution_end", (event, ctx) => {
    if (!reporter) return;
    tools.delete(event.toolCallId);
    publish(ctx);
  });
  pi.on("session_before_compact", (_event, ctx) => {
    if (!reporter) return;
    compacting = true;
    publish(ctx);
  });
  pi.on("session_compact", (event, ctx) => {
    if (!reporter) return;
    compacting = false;
    active ||= event.willRetry;
    publish(ctx);
  });
  pi.on("session_compact_failed", (event, ctx) => {
    if (!reporter) return;
    compacting = false;
    // Failure is not evidence of a scheduled retry; agent_settled/abort owns settling an active run.
    if (event.aborted) active = false;
    publish(ctx);
  });
  pi.on("session_info_changed", (_event, ctx) => publish(ctx));
  pi.on("model_select", (_event, ctx) => publish(ctx));
  pi.on("message_end", (_event, ctx) => publish(ctx));
  pi.on("session_shutdown", async event => {
    overview?.stop(["new", "resume", "fork"].includes(event.reason));
    const closing = reporter;
    reporter = undefined;
    try { await closing?.close(); } finally {
      releaseClaim?.();
      releaseClaim = undefined;
      reset();
    }
  });
}
