import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@code-yeongyu/senpi";
import { basename } from "node:path";
import { gitContext } from "./git.ts";
import { displayText, type Metadata } from "./metadata.ts";
import { compactText, projectLabel, workReference } from "./presentation.ts";
import { object, taskLabels, taskSnapshot, type TaskCounts } from "./tasks.ts";

const ENTRY = "omo-herdr:overview";
export function elapsed(start: number | undefined, now: number): string | undefined {
  if (start === undefined) return;
  const seconds = Math.max(0, Math.floor((now - start) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Session-scoped presentation. Never owns lifecycle state or changes the DAG viewer. */
export class Overview {
  private ctx?: ExtensionContext;
  private unsubscribe?: () => void;
  private snapshots = new Map<string, TaskCounts>();
  private timer?: ReturnType<typeof setInterval>;
  private started?: number;
  private finished?: number;
  private waiting?: number;
  private branch?: string;
  private worktree?: string;
  private task?: string;
  private result?: string;
  private workItem?: string;
  private project?: string;
  private repository?: string;
  private lastGit = 0;
  private gitInFlight = false;
  private generation = 0;

  private pi: Pick<ExtensionAPI, "events" | "registerTool" | "appendEntry">;
  private changed: (ctx: ExtensionContext) => void;

  constructor(pi: Pick<ExtensionAPI, "events" | "registerTool" | "appendEntry">, changed: (ctx: ExtensionContext) => void) {
    this.pi = pi;
    this.changed = changed;
    // Capture initial OmO snapshots even when its session_start handler runs before ours.
    this.subscribe();
    pi.registerTool({
      name: "herdr_summary", label: "Herdr summary",
      description: "Set a short task label or verified outcome in this session's Herdr sidebar. This only changes display metadata. Never include secrets, prompts or full output. Empty strings clear a field.",
      promptSnippet: "Set a 2-4 word Herdr task label, explicit work item, and verified result.",
      promptGuidelines: ["For substantial work in Herdr, call herdr_summary at the start with a 2-4 word task label and an explicit workItem when known (PR #379, Issue #42, owner/repo#379, or a GitHub pull/issues URL). Update workItem whenever it changes; use an empty string to clear it. Before finishing, set a 2-4 word result describing only a verified outcome. Never infer a PR was opened, merged, or passed checks from idle state or task completion. Do not claim tests passed, a commit, or a PR outcome unless you verified it."],
      parameters: { type: "object", properties: {
        workItem: { type: "string", maxLength: 160, description: "Explicit PR/issue reference or short work-item label; empty string clears" },
        task: { type: "string", maxLength: 160, description: "2-4 word task label" },
        result: { type: "string", maxLength: 160, description: "2-4 word verified outcome to retain after completion" },
      }, additionalProperties: false } as ToolDefinition["parameters"],
      execute: async (_id, params, _signal, _update, ctx) => {
        if (!this.ctx || ctx.mode !== "tui" || !ctx.hasUI || ctx.sessionManager.getSessionId() !== this.ctx.sessionManager.getSessionId()) {
          return { content: [{ type: "text", text: "No active Herdr pane owned by this session." }], details: {}, isError: true };
        }
        const value = object(params);
        if (!value || !["workItem", "task", "result"].some(key => typeof value[key] === "string")) {
          return { content: [{ type: "text", text: "Provide workItem, task or result." }], details: {}, isError: true };
        }
        // Keep explicit source intact; sanitization/truncation belongs only to display.
        if (typeof value.workItem === "string") this.workItem = value.workItem || undefined;
        if (typeof value.task === "string") this.task = value.task || undefined;
        if (typeof value.result === "string") this.result = value.result || undefined;
        pi.appendEntry(ENTRY, { workItem: this.workItem, task: this.task, result: this.result });
        this.notify(ctx);
        return { content: [{ type: "text", text: "Herdr summary updated." }], details: {} };
      },
    });
  }

  private notify(ctx: ExtensionContext): void {
    // Async Git/timer/event callbacks must not take down the host if context is transitioning.
    try { this.changed(ctx); } catch { /* The next host event or refresh samples again. */ }
  }

  private subscribe(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.pi.events.on("senpi:extension-rpc-event", event => {
      const envelope = object(event);
      if (envelope?.name !== "omo.task.updated") return;
      const snapshot = taskSnapshot(envelope.data);
      if (!snapshot) return;
      const sessionId = this.ctx?.sessionManager.getSessionId();
      if (sessionId && snapshot.sessionId !== sessionId) return;
      this.snapshots.set(snapshot.sessionId, snapshot.counts);
      if (this.snapshots.size > 4) this.snapshots.delete(this.snapshots.keys().next().value!);
      if (this.ctx) this.notify(this.ctx);
    });
  }

  start(ctx: ExtensionContext): void {
    this.generation++;
    if (this.timer) clearInterval(this.timer);
    this.subscribe();
    this.ctx = ctx;
    const id = ctx.sessionManager.getSessionId();
    const counts = this.snapshots.get(id);
    this.snapshots.clear();
    if (counts) this.snapshots.set(id, counts);
    this.started = this.finished = this.waiting = undefined;
    this.task = this.result = this.workItem = this.branch = this.repository = undefined;
    this.project = basename(ctx.cwd);
    this.worktree = displayText(this.project);
    const entry = ctx.sessionManager.getBranch?.().findLast(entry => entry.type === "custom" && entry.customType === ENTRY);
    const saved = entry?.type === "custom" ? object(entry.data) : undefined;
    if (typeof saved?.workItem === "string") this.workItem = saved.workItem;
    if (typeof saved?.task === "string") this.task = saved.task;
    if (typeof saved?.result === "string") this.result = saved.result;
    this.lastGit = 0;
    this.gitInFlight = false;
    this.refreshGit();
    this.timer = setInterval(() => {
      if (!this.ctx) return;
      this.refreshGit();
      this.notify(this.ctx);
    }, 5000);
    this.timer.unref();
  }

  private refreshGit(): void {
    if (!this.ctx || this.gitInFlight || Date.now() - this.lastGit < 15_000) return;
    const generation = this.generation;
    const ctx = this.ctx;
    this.gitInFlight = true;
    this.lastGit = Date.now();
    void gitContext(ctx.cwd).then(info => {
      if (generation !== this.generation) return;
      this.branch = info.branch;
      this.repository = info.repository;
      this.project = info.project ?? basename(ctx.cwd);
      this.worktree = info.worktree ?? displayText(basename(ctx.cwd));
      this.notify(ctx);
    }).catch(() => { /* Git/context failures leave presentation unavailable. */ }).finally(() => { if (generation === this.generation) this.gitInFlight = false; });
  }

  begin(now = Date.now()): void {
    if (this.started === undefined || this.finished !== undefined) {
      this.started = now;
      this.finished = undefined;
      this.task = this.result = this.workItem = undefined;
      this.pi.appendEntry(ENTRY, {});
    }
  }
  settle(aborted = false, now = Date.now()): void {
    if (this.started !== undefined && this.finished === undefined) this.finished = now;
    if (aborted) {
      this.result = "Stopped";
      this.pi.appendEntry(ENTRY, { workItem: this.workItem, task: this.task, result: this.result });
    }
  }
  metadata(blocked: boolean, now = Date.now(), activity?: string): Partial<Metadata> {
    if (blocked) this.waiting ??= now;
    else this.waiting = undefined;
    const counts = this.ctx ? this.snapshots.get(this.ctx.sessionManager.getSessionId()) : undefined;
    const labels = taskLabels(counts);
    const attention = blocked ? "Needs your input" : labels.attention;
    const settled = !activity && (this.started === undefined || this.finished !== undefined);
    const activeCounts = counts ? [counts.running ? `${counts.running} active` : undefined, counts.pending ? `${counts.pending} queued` : undefined].filter(Boolean).join(" · ") : undefined;
    const reference = workReference(this.workItem);
    const duration = this.waiting !== undefined ? elapsed(this.waiting, now) : elapsed(this.started, this.finished ?? now);
    return {
      ...labels, task: displayText(this.task), result: displayText(this.result), branch: this.branch, worktree: this.worktree,
      workItem: compactText(reference?.identifier),
      project: projectLabel(reference, { project: this.project, repository: this.repository }),
      summary: compactText(attention) ?? (settled ? compactText(this.result) : undefined) ?? compactText(this.task) ?? compactText(activity) ?? compactText(activeCounts),
      attention, elapsedCompact: duration,
      elapsed: this.waiting !== undefined ? `Waiting ${duration}` : duration,
    };
  }
  stop(replacingSession = false): void {
    this.generation++;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (!replacingSession) {
      this.unsubscribe?.();
      this.unsubscribe = undefined;
    }
    this.ctx = undefined;
    this.snapshots.clear();
  }
}
