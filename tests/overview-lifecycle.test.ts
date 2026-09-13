import assert from "node:assert/strict";
import { EventEmitter, on, once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  discoverAndLoadExtensions, ExtensionRunner, SessionManager,
  type ExtensionActions, type ExtensionContextActions, type ExtensionUIContext,
  type InputDispositionEvent, type InputSource, type ModelRegistry,
} from "@code-yeongyu/senpi";

// Drive the public loader/runner and observe the real reporter's serialized CLI
// output. A unique title is a publication barrier, not the value being asserted.
test("overview resets only for admitted user work at the extension-event boundary", async t => {
  const directory = await mkdtemp(join(tmpdir(), "herdr-lifecycle-"));
  const endpoint = join(directory, "cli.sock");
  const bin = join(directory, "herdr.mjs");
  const calls = new EventEmitter();
  const errors: unknown[] = [];
  const server = createServer(socket => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("error", error => errors.push(error));
    socket.on("data", chunk => { buffer += chunk; });
    socket.on("end", () => {
      calls.emit("call", JSON.parse(buffer) as string[]);
      socket.end();
    });
  });
  const original = { ...process.env };
  let runner: ExtensionRunner | undefined;
  let idle = true;
  let pending = false;
  let compacting = false;
  let sequence = 0;
  const session = SessionManager.inMemory(directory);
  try {
    await writeFile(bin, `#!${process.execPath}
import { connect } from "node:net";
const socket = connect(process.env.HERDR_SOCKET_PATH);
socket.on("connect", () => socket.end(JSON.stringify(process.argv.slice(2))));
`, { mode: 0o755 });
    const listening = once(server, "listening");
    server.listen(endpoint);
    await listening;
    Object.assign(process.env, {
      HERDR_ENV: "1", HERDR_BIN_PATH: bin, HERDR_SOCKET_PATH: endpoint,
      HERDR_PANE_ID: "w1:p1", OMO_HERDR_METADATA: "1",
    });
    delete process.env.OMO_HERDR_OWNER_PID;
    const loaded = await discoverAndLoadExtensions([new URL("../src/index.ts", import.meta.url).pathname], directory, directory);
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
    runner = new ExtensionRunner(loaded.extensions, loaded.runtime, directory, session, {} as ModelRegistry);
    runner.bindCore({
      appendEntry: (type: string, data: unknown) => { session.appendCustomEntry(type, data); },
    } as unknown as ExtensionActions, {
      getModel: () => undefined, isIdle: () => idle, hasPendingMessages: () => pending,
      isCompacting: () => compacting, getContextUsage: () => undefined,
    } as ExtensionContextActions);
    runner.setUIContext({} as ExtensionUIContext, "tui");
    runner.onError(error => errors.push(error));
    const host = runner;
    const tool = host.getToolDefinition("herdr_summary")!;
    assert.ok(tool);

    async function summary(value: { task?: string; result?: string; workItem?: string }) {
      const response = await tool.execute("summary", value, undefined, undefined, host.createContext());
      assert.notEqual(response.isError, true);
    }
    async function sample() {
      const title = `sample-${++sequence}`;
      const stream = on(calls, "call", { signal: AbortSignal.timeout(5000) });
      try {
        session.appendSessionInfo(title);
        await host.emit({ type: "session_info_changed", name: title });
        for await (const [args] of stream) {
          const values = args as string[];
          if (values[1] !== "report-metadata" || values[values.indexOf("--title") + 1] !== title) continue;
          return Object.fromEntries(values.flatMap<[string, string | undefined]>((value, i) => {
            if (values[i - 1] === "--clear-token") return [[value, undefined]];
            if (values[i - 1] !== "--token") return [];
            const split = value.indexOf("=");
            return [[value.slice(0, split), value.slice(split + 1)]];
          }));
        }
      } finally { await stream.return?.(); }
      assert.fail("metadata stream ended without the publication marker");
    }
    function saved() {
      const entry = session.getBranch().findLast(entry => entry.type === "custom" && entry.customType === "omo-herdr:overview");
      assert.equal(entry?.type, "custom");
      return entry.data;
    }
    const expected = { task: "Review fix", result: "Verified fixture", workItem: "PR #42" };
    async function assertSummary(value = expected) {
      const metadata = await sample();
      assert.deepEqual({ task: metadata.omo_task, result: metadata.omo_result, workItem: metadata.omo_work_item }, value);
      assert.deepEqual(saved(), value);
    }
    async function assertCleared() {
      const metadata = await sample();
      assert.deepEqual([metadata.omo_task, metadata.omo_result, metadata.omo_work_item], [undefined, undefined, undefined]);
      assert.deepEqual(saved(), {});
    }
    async function seed() {
      await host.emit({ type: "session_shutdown", reason: "new" });
      session.newSession();
      idle = true;
      pending = compacting = false;
      await host.emit({ type: "session_start", reason: "new" });
      await host.emit({ type: "agent_start" });
      await summary(expected);
      await host.emit({ type: "agent_settled" });
    }
    async function input(id: string, source: InputSource, streamingBehavior?: "steer" | "followUp") {
      await host.emitInput("opaque fixture input", undefined, source, streamingBehavior, id);
    }
    async function disposition(id: string, disposition: InputDispositionEvent["disposition"]) {
      await host.emit({ type: "input_disposition", inputId: id, disposition });
    }

    await t.test("settled autonomous continuations retain task, result and explicit PR", async () => {
      await seed();
      await assertSummary();
      await host.emit({ type: "agent_start" });
      await assertSummary();
      await host.emit({ type: "agent_settled" });
      await host.emit({ type: "agent_start" });
      await assertSummary();
    });
    await t.test("active, pending and compacting resumes restore explicit metadata", async () => {
      for (const activity of ["active", "pending", "compacting"] as const) {
        await seed();
        await host.emit({ type: "session_shutdown", reason: "resume" });
        idle = activity !== "active";
        pending = activity === "pending";
        compacting = activity === "compacting";
        await host.emit({ type: "session_start", reason: "resume" });
        await assertSummary();
      }
    });
    await t.test("only admitted interactive/RPC work clears all fields, including queued input", async () => {
      for (const source of ["interactive", "rpc"] as const) {
        for (const behavior of [undefined, "steer", "followUp"] as const) {
          await seed();
          if (behavior) { idle = false; await host.emit({ type: "agent_start" }); }
          await input("user", source, behavior);
          await assertSummary();
          await disposition("user", behavior ? "queued" : "started");
          await assertCleared();
          await summary(expected);
          await host.emit({ type: "agent_start" });
          await assertSummary();
        }
      }
    });
    await t.test("extension input never owns a new-work reset", async () => {
      for (const outcome of ["started", "queued"] as const) {
        await seed();
        await input("extension", "extension", outcome === "queued" ? "followUp" : undefined);
        await disposition("extension", outcome);
        await host.emit({ type: "agent_start" });
        await assertSummary();
      }
    });
    await t.test("handled/rejected and interleaved input cannot arm a later autonomous reset", async () => {
      await seed();
      await input("handled", "interactive");
      await input("rejected", "rpc");
      await input("extension", "extension");
      await disposition("rejected", "rejected");
      await disposition("extension", "started");
      await disposition("handled", "handled");
      await host.emit({ type: "agent_start" });
      await assertSummary();
      await host.emit({ type: "agent_settled" });
      await host.emit({ type: "agent_start" });
      await assertSummary();
    });
    await t.test("explicit clear persists across autonomous continuation and resume", async () => {
      await seed();
      await summary({ workItem: "" });
      await host.emit({ type: "agent_start" });
      const cleared = { ...expected, workItem: undefined };
      const metadata = await sample();
      assert.deepEqual({ task: metadata.omo_task, result: metadata.omo_result, workItem: metadata.omo_work_item }, cleared);
      await host.emit({ type: "session_shutdown", reason: "resume" });
      await host.emit({ type: "session_start", reason: "resume" });
      assert.equal((await sample()).omo_work_item, undefined);
    });
    await t.test("session replacement discards metadata and pending input ownership", async () => {
      await seed();
      await input("old-session", "interactive");
      await host.emit({ type: "session_shutdown", reason: "new" });
      session.newSession();
      await host.emit({ type: "session_start", reason: "new" });
      const metadata = await sample();
      assert.deepEqual([metadata.omo_task, metadata.omo_result, metadata.omo_work_item], [undefined, undefined, undefined]);
      await summary(expected);
      await disposition("old-session", "started");
      await host.emit({ type: "agent_start" });
      await assertSummary();
    });
    assert.deepEqual(errors, []);
  } finally {
    await runner?.emit({ type: "session_shutdown", reason: "quit" });
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
