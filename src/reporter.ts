import { nextSequence } from "./environment.ts";
import { metadataArgs, METADATA_REFRESH_MS, type Metadata } from "./metadata.ts";
import type { Transport } from "./transport.ts";
export { cliTransport, type Transport } from "./transport.ts";

export interface Snapshot {
  state: "idle" | "working" | "blocked";
  message?: string;
  sessionId?: string;
  sessionPath?: string;
  metadata?: Metadata;
}

export interface DeliveryHealth {
  lastAttemptAt?: number;
  lastSuccessAt?: number;
  succeeded?: boolean;
  failures: number;
}

/** One in-flight command and one pending snapshot; metadata never changes lifecycle authority. */
export class Reporter {
  private transport: Transport;
  private pane: string;
  private retryMs: number;
  private refreshMs: number;
  private pending?: Snapshot;
  private latest?: Snapshot;
  private lastState?: string;
  private lastMetadata?: string;
  private metadataAttempted = false;
  private inFlight?: Promise<void>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private closing?: Promise<void>;
  private health = {
    state: { failures: 0 } as DeliveryHealth,
    metadata: { failures: 0 } as DeliveryHealth,
    release: { failures: 0 } as DeliveryHealth,
  };

  constructor(pane: string, transport: Transport, retryMs = 2000, refreshMs = METADATA_REFRESH_MS) {
    this.pane = pane;
    this.transport = transport;
    this.retryMs = retryMs;
    this.refreshMs = refreshMs;
  }

  diagnostics() {
    return { state: { ...this.health.state }, metadata: { ...this.health.metadata },
      release: { ...this.health.release }, pending: !!this.pending, inFlight: !!this.inFlight, closed: this.closed };
  }

  report(snapshot: Snapshot): void {
    if (this.closed) return;
    this.latest = { ...snapshot, metadata: snapshot.metadata ? { ...snapshot.metadata } : undefined };
    this.pending = this.latest;
    this.clearRetry();
    this.startDrain();
  }

  private args(command: string): string[] {
    return ["pane", command, this.pane, "--source", "custom:omo", "--agent", "omo", "--seq", String(nextSequence())];
  }

  private async send(args: string[], channel: keyof Reporter["health"]): Promise<boolean> {
    const health = this.health[channel];
    health.lastAttemptAt = Date.now();
    let ok = false;
    try { ok = await this.transport(args); } catch { /* Retry without exposing command output. */ }
    health.succeeded = ok;
    if (ok) { health.lastSuccessAt = Date.now(); health.failures = 0; }
    else health.failures++;
    return ok;
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
      const { metadata, ...state } = snapshot;
      const stateKey = JSON.stringify(state);
      let delivered = true;
      if (stateKey !== this.lastState) {
        const args = [...this.args("report-agent"), "--state", state.state];
        if (state.message) args.push("--message", state.message);
        if (state.sessionId) args.push("--agent-session-id", state.sessionId);
        if (state.sessionPath) args.push("--agent-session-path", state.sessionPath);
        delivered = await this.send(args, "state");
        this.lastState = delivered ? stateKey : undefined;
      }
      // Prefer an already queued newer lifecycle state over stale presentation.
      if (this.pending) continue;
      if (this.closed) return;
      if (metadata && delivered) {
        const key = JSON.stringify(metadata);
        if (key !== this.lastMetadata || Date.now() - (this.health.metadata.lastSuccessAt ?? 0) >= this.refreshMs) {
          this.metadataAttempted = true;
          delivered = await this.send(metadataArgs(metadata, nextSequence(), this.pane), "metadata");
          this.lastMetadata = delivered ? key : undefined;
        }
        this.scheduleRefresh();
      }
      if (!delivered) {
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

  private scheduleRefresh(): void {
    if (this.refreshTimer || this.closed) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      if (this.latest?.metadata && !this.closed) this.report(this.latest);
    }, this.refreshMs);
    this.refreshTimer.unref();
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.pending = undefined;
    this.latest = undefined;
    this.clearRetry();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    this.closing = (async () => {
      await this.inFlight;
      if (this.metadataAttempted) {
        if (!await this.send(metadataArgs(undefined, nextSequence(), this.pane), "metadata")) {
          await this.send(metadataArgs(undefined, nextSequence(), this.pane), "metadata");
        }
      }
      if (!await this.send(this.args("release-agent"), "release")) {
        await this.send(this.args("release-agent"), "release");
      }
    })();
    return this.closing;
  }
}
