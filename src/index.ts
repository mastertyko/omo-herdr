import type { ExtensionAPI, ExtensionContext, UIPromptKind } from "@code-yeongyu/senpi";
import { isAbsolute } from "node:path";
import { claimPane, readEnvironment } from "./environment.ts";
import { cliTransport, Reporter } from "./reporter.ts";

export default function omoHerdr(pi: ExtensionAPI): void {
  const environment = readEnvironment(process.env);
  if (!environment) return;

  let reporter: Reporter | undefined;
  let releaseClaim: (() => void) | undefined;
  let active = false;
  let prompts: Array<{ kind: UIPromptKind; title?: string }> = [];

  function publish(ctx: ExtensionContext): void {
    if (!reporter) return;
    const prompt = prompts.at(-1);
    const file = ctx.sessionManager.getSessionFile();
    reporter.report({
      state: prompt ? "blocked" : active ? "working" : "idle",
      // Avoid copying arbitrary prompt text or secrets into Herdr's status/history.
      message: prompt ? "Waiting for user input" : undefined,
      sessionId: ctx.sessionManager.getSessionId(),
      sessionPath: file && isAbsolute(file) ? file : undefined,
    });
  }

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui" || !ctx.hasUI || reporter) return;
    releaseClaim = claimPane();
    if (!releaseClaim) return;
    reporter = new Reporter(environment.pane, cliTransport(environment));
    prompts = [];
    active = !ctx.isIdle() || ctx.hasPendingMessages() || (ctx.isCompacting?.() ?? false);
    publish(ctx);
  });

  pi.on("agent_start", (_event, ctx) => {
    active = true;
    publish(ctx);
  });

  // agent_end can precede retries, compaction and queued continuations.
  pi.on("agent_settled", (_event, ctx) => {
    active = false;
    publish(ctx);
  });

  pi.on("session_abort", (_event, ctx) => {
    active = false;
    publish(ctx);
  });

  pi.on("ui_prompt_start", (event, ctx) => {
    prompts.push({ kind: event.kind, title: event.title });
    publish(ctx);
  });

  pi.on("ui_prompt_end", (event, ctx) => {
    const index = prompts.findLastIndex((prompt) => prompt.kind === event.kind && prompt.title === event.title);
    if (index < 0) return;
    prompts.splice(index, 1);
    publish(ctx);
  });

  pi.on("session_info_changed", (_event, ctx) => publish(ctx));

  pi.on("session_shutdown", async () => {
    const closing = reporter;
    reporter = undefined;
    try { await closing?.close(); } finally {
      releaseClaim?.();
      releaseClaim = undefined;
      prompts = [];
      active = false;
    }
  });
}
