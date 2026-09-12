import { execFile } from "node:child_process";
import type { HerdrEnvironment } from "./environment.ts";
import { nextSequence } from "./environment.ts";

export interface Snapshot {
  state: "idle" | "working" | "blocked";
  message?: string;
  sessionId?: string;
  sessionPath?: string;
}

export type Transport = (args: readonly string[]) => Promise<boolean>;
const SOURCE = "custom:omo";

export function cliTransport(environment: HerdrEnvironment, timeoutMs = 750): Transport {
  return (args) => new Promise((resolve) => {
    execFile(environment.bin, [...args], {
      env: { ...process.env, HERDR_SOCKET_PATH: environment.socket },
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024,
      windowsHide: true,
      shell: false,
    }, (error) => resolve(!error));
  });
}

/** One in-flight report and one pending snapshot. Slow/offline Herdr cannot grow a backlog. */
export class Reporter {
  private transport: Transport;
  private pane: string;
  private retryMs: number;
  private pending?: Snapshot;
  private lastDelivered?: string;
  private inFlight?: Promise<void>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private closing?: Promise<void>;

  constructor(pane: string, transport: Transport, retryMs = 2000) {
    this.pane = pane;
    this.transport = transport;
    this.retryMs = retryMs;
  }

  report(snapshot: Snapshot): void {
    if (this.closed) return;
    this.pending = { ...snapshot };
    this.clearRetry();
    this.startDrain();
  }

  private args(command: string): string[] {
    return ["pane", command, this.pane, "--source", SOURCE, "--agent", "omo", "--seq", String(nextSequence())];
  }

  private async send(args: string[]): Promise<boolean> {
    try { return await this.transport(args); } catch { return false; }
  }

  private startDrain(): void {
    if (this.inFlight || this.closed) return;
    this.inFlight = this.drain().finally(() => {
      this.inFlight = undefined;
      if (this.pending && !this.retryTimer && !this.closed) this.startDrain();
    });
  }

  private async drain(): Promise<void> {
    while (this.pending && !this.closed) {
      const snapshot = this.pending;
      this.pending = undefined;
      const key = JSON.stringify(snapshot);
      if (key === this.lastDelivered) continue;
      const args = [...this.args("report-agent"), "--state", snapshot.state];
      if (snapshot.message) args.push("--message", snapshot.message);
      if (snapshot.sessionId) args.push("--agent-session-id", snapshot.sessionId);
      if (snapshot.sessionPath) args.push("--agent-session-path", snapshot.sessionPath);
      if (await this.send(args)) {
        this.lastDelivered = key;
      } else {
        // A newer state supersedes a failed report. Retry the latest state while otherwise idle.
        this.lastDelivered = undefined;
        this.pending ??= snapshot;
        if (!this.closed) {
          this.retryTimer = setTimeout(() => {
            this.retryTimer = undefined;
            this.startDrain();
          }, this.retryMs);
          this.retryTimer.unref();
        }
        return;
      }
    }
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.pending = undefined;
    this.clearRetry();
    this.closing = (async () => {
      await this.inFlight;
      // A report must never land after this source's release.
      if (!await this.send(this.args("release-agent"))) {
        await this.send(this.args("release-agent"));
      }
    })();
    return this.closing;
  }
}
