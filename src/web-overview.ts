import type { ExtensionAPI, ExtensionContext } from "@code-yeongyu/senpi";
import { basename } from "node:path";
import { displayText } from "./metadata.ts";
import { object } from "./tasks.ts";
import { WebModel, type State } from "./web-model.ts";
import { startWebServer, type WebServer } from "./web-server.ts";

export class WebOverview {
  readonly model = new WebModel();
  private unsubscribe?: () => void;
  private server?: WebServer;
  private opening?: Promise<WebServer>;
  private generation = 0;
  private sessionId?: string;
  private createServer: typeof startWebServer;
  private pi: ExtensionAPI;
  constructor(
    pi: ExtensionAPI,
    createServer: typeof startWebServer = startWebServer,
  ) {
    this.pi = pi;
    this.createServer = createServer;
    this.subscribe();
  }
  private subscribe(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.pi.events?.on(
      "senpi:extension-rpc-event",
      (event) => {
        const e = object(event);
        if (typeof e?.name === "string") this.model.receive(e.name, e.data);
      },
    );
  }
  start(ctx: ExtensionContext): void {
    const sessionId = ctx.sessionManager.getSessionId();
    if (this.sessionId !== undefined && this.sessionId !== sessionId)
      void this.stop(true);
    this.sessionId = sessionId;
    this.subscribe();
    this.model.start({
      id: ctx.sessionManager.getSessionId(),
      title:
        displayText(ctx.sessionManager.getSessionName?.()) ?? "OmO session",
      project: displayText(basename(ctx.cwd ?? process.cwd())) ?? "Project",
      state: "idle",
    });
    // Ask an opt-in research producer to announce current capabilities when
    // extension load order or reload means its initial announcement was missed.
    this.pi.events?.emit?.("omo.research.request", { parent_session_id: sessionId });
  }
  update(ctx: ExtensionContext, state: State, activity?: string): void {
    if (this.sessionId !== ctx.sessionManager.getSessionId()) return;
    this.model.update({
      title:
        displayText(ctx.sessionManager.getSessionName?.()) ?? "OmO session",
      state,
      activity,
      model: ctx.model
        ? displayText(ctx.model.name ?? ctx.model.id)
        : undefined,
    });
  }
  async open(ctx: ExtensionContext): Promise<void> {
    if (
      !this.sessionId ||
      this.sessionId !== ctx.sessionManager.getSessionId()
    ) {
      ctx.ui.notify(
        "Web overview requires an active OmO session in this Herdr pane.",
        "warning",
      );
      return;
    }
    const generation = this.generation;
    this.opening ??= this.server
      ? Promise.resolve(this.server)
      : this.createServer(() => {
          if (generation !== this.generation)
            throw new Error("Session has closed.");
          return this.model.snapshot();
        });
    try {
      const server = await this.opening;
      if (generation !== this.generation) {
        await server.close();
        return;
      }
      this.server = server;
      const command =
        process.platform === "darwin"
          ? "open"
          : process.platform === "win32"
            ? undefined
            : "xdg-open";
      if (command) {
        try {
          await this.pi.exec(command, [server.url], { timeout: 5000 });
        } catch {
          /* The link below remains usable. */
        }
      }
      if (generation === this.generation)
        ctx.ui.notify(`Agent overview: ${server.url}`, "info");
    } catch (error) {
      if (generation === this.generation)
        ctx.ui.notify(
          error instanceof Error
            ? error.message
            : "Could not open agent overview.",
          "warning",
        );
    } finally {
      if (generation === this.generation) this.opening = undefined;
    }
  }
  async stop(replacing = false): Promise<void> {
    this.generation++;
    this.sessionId = undefined;
    const server = this.server;
    const opening = this.opening;
    this.server = undefined;
    this.opening = undefined;
    this.model.clear();
    if (!replacing) {
      this.unsubscribe?.();
      this.unsubscribe = undefined;
    }
    await server?.close();
    if (opening) {
      try {
        const pending = await opening;
        if (pending !== server) await pending.close();
      } catch {}
    }
  }
}
