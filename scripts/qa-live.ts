/** Public Senpi host + official Herdr server, all in disposable directories. No model calls. */
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { createConnection, type Socket } from "node:net";
import { createInterface } from "node:readline";
import {
  createEventBus, discoverAndLoadExtensions, ExtensionRunner, SessionManager,
  type ExtensionActions, type ExtensionContext, type ExtensionContextActions,
  type ExtensionUIContext, type ModelRegistry,
} from "@code-yeongyu/senpi";

const bin = process.env.HERDR_BIN_PATH;
assert.ok(bin && isAbsolute(bin), "Set HERDR_BIN_PATH to an absolute official Herdr executable path");
assert.notEqual(process.platform, "win32", "Live QA currently supports macOS/Linux");
const run = promisify(execFile);
const version = (await run(bin, ["--version"])).stdout.trim();
assert.equal(version, "herdr 0.9.0", "Live QA pins official Herdr 0.9.0");
const base = await mkdtemp(join(tmpdir(), "omo-live-"));
const entry = process.env.OMO_HERDR_QA_ENTRY ?? new URL("../src/index.ts", import.meta.url).pathname;
const env: NodeJS.ProcessEnv = {
  ...process.env, XDG_CONFIG_HOME: join(base, "config"), XDG_STATE_HOME: join(base, "state"),
  XDG_RUNTIME_DIR: join(base, "runtime"), HERDR_SOCKET_PATH: join(base, "api.sock"),
  SHELL: "/bin/sh", OMO_CODING_AGENT_DIR: join(base, "agent"), OMO_HERDR_METADATA: "1",
};
for (const key of ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_SESSION", "HERDR_CLIENT_SOCKET_PATH", "HERDR_CONFIG_PATH", "OMO_HERDR_OWNER_PID"]) delete env[key];
const command = async (...args: string[]) => (await run(bin, args, { env, timeout: 5000 })).stdout;
const call = async (...args: string[]) => JSON.parse(await command(...args));
let server: ChildProcess | undefined;
let subscription: Socket | undefined;
const changes = new EventEmitter();
let serverOutput = "";
const runners: ExtensionRunner[] = [];
const errors: unknown[] = [];
const observations: string[] = [];
const notices: string[] = [];
const bus = createEventBus();
let dagListenerEvents = 0;
bus.on("senpi:extension-rpc-event", () => { dagListenerEvents++; });
let paneId: string;
async function eventually(predicate: () => Promise<boolean>, label: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let checking = false, changed = false, finished = false;
    const cleanup = () => { finished = true; clearTimeout(deadline); changes.off("change", check); };
    const deadline = setTimeout(() => {
      cleanup();
      reject(new Error(`Missing ${label}. Errors: ${JSON.stringify(errors)}; server: ${serverOutput.slice(-2000)}`));
    }, 6000);
    const check = () => {
      changed = true;
      if (checking || finished) return;
      checking = true;
      void (async () => {
        try {
          while (changed && !finished) {
            changed = false;
            if (await predicate()) { observations.push(label); cleanup(); resolve(); }
          }
        } catch (error) { cleanup(); reject(error); }
        finally { checking = false; }
      })();
    };
    changes.on("change", check);
    check();
  });
}
const pane = async () => (await call("pane", "get", paneId)).result.pane;
const state = async (value: string) => eventually(async () => {
  const current = await pane();
  return current.agent_status === value || value === "idle" && current.agent_status === "done";
}, `state ${value}`);
const token = async (key: string, value?: string) => eventually(async () => (await pane()).tokens?.[key] === value, `${key}=${value ?? "cleared"}`);
let contextUsage = { tokens: 420, percent: 42, contextWindow: 1000 };
let model: ExtensionContext["model"] = { provider: "qa", id: "first-model" } as ExtensionContext["model"];

async function host(session: SessionManager, mode: "tui" | "rpc" = "tui") {
  const loaded = await discoverAndLoadExtensions([entry], base, join(base, "empty"), bus);
  assert.deepEqual(loaded.errors, []);
  const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, base, session, {} as ModelRegistry);
  runner.bindCore({appendEntry: (type: string, data: unknown) => { session.appendCustomEntry(type, data); }} as unknown as ExtensionActions, {
    getModel: () => model, isIdle: () => true, hasPendingMessages: () => false, isCompacting: () => false,
    getContextUsage: () => contextUsage,
  } as ExtensionContextActions);
  runner.onError(error => errors.push(error));
  let answer!: (value: boolean) => void;
  runner.setUIContext({
    confirm: () => new Promise<boolean>(resolve => { answer = resolve; }),
    notify: (text: string) => notices.push(text),
  } as unknown as ExtensionUIContext, mode);
  runners.push(runner);
  return { runner, answer: (value: boolean) => answer(value) };
}

try {
  await mkdir(join(base, "config/herdr"), { recursive: true });
  await mkdir(join(base, "runtime"), { recursive: true });
  await mkdir(join(base, "agent"), { recursive: true });
  await writeFile(join(base, "config/herdr/config.toml"), "onboarding = false\n" +
    await readFile(new URL("../profiles/sidebar.toml", import.meta.url), "utf8"));
  server = spawn(bin, ["server"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let spawnError: Error | undefined;
  server.on("error", error => { spawnError = error; changes.emit("change"); });
  server.stdout?.on("data", bytes => { serverOutput += bytes; changes.emit("change"); });
  server.stderr?.on("data", bytes => { serverOutput += bytes; changes.emit("change"); });
  await eventually(async () => {
    if (spawnError) throw spawnError;
    try { await call("workspace", "list"); return true; } catch { return false; }
  }, "isolated server ready");
  subscription = createConnection(join(base, "api.sock"));
  await once(subscription, "connect");
  const lines = createInterface({ input: subscription });
  const subscribed = new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("Missing pane event subscription")), 6000);
    lines.on("line", line => {
      const message = JSON.parse(line);
      if (message.id === "qa-subscribe") {
        clearTimeout(deadline);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve();
      }
      changes.emit("change");
    });
  });
  subscription.write(`${JSON.stringify({ id: "qa-subscribe", method: "events.subscribe",
    params: { subscriptions: [{ type: "pane.updated" }] } })}\n`);
  await subscribed;
  const workspace = await call("workspace", "create", "--cwd", base, "--label", "omo-herdr-qa");
  paneId = workspace.result.root_pane.pane_id;
  Object.assign(process.env, env, { HERDR_ENV: "1", HERDR_BIN_PATH: bin, HERDR_PANE_ID: paneId });
  delete process.env.OMO_HERDR_OWNER_PID;
  const session = SessionManager.inMemory(base);
  session.appendSessionInfo("QA session");
  const h = await host(session);
  await h.runner.emit({ type: "session_start", reason: "startup" });
  await state("idle");
  bus.emit("senpi:extension-rpc-event", {name:"omo.task.updated",data:{parent_session_id:session.getSessionId(),tasks:[
    {task_id:"st_a",status:"running"}, {task_id:"st_b",status:"pending"}, {task_id:"st_c",status:"completed"},
  ]}});
  await token("omo_tasks", "1 running · 1 pending · 1 completed");
  bus.emit("senpi:extension-rpc-event", {name:"omo.task.updated",data:{parent_session_id:"unrelated",tasks:[{task_id:"st_bad",status:"error"}]}});
  await token("omo_tasks", "1 running · 1 pending · 1 completed");
  assert.equal(dagListenerEvents, 2, "another extension can observe the same bus events");
  await token("omo_context_meter", "Context 42%");
  await token("omo_model", "qa/first-model");
  await token("omo_context", "42% (420/1000)");
  await eventually(async () => (await pane()).title === "QA session", "session title");
  // A foreign token must survive our refresh, session replacement and cleanup.
  await command("pane", "report-metadata", paneId, "--source", "qa:other", "--token", "other=preserve");
  await h.runner.emit({ type: "agent_start" }); await state("working");
  await h.runner.emit({ type: "tool_execution_start", toolCallId: "qa-tool", toolName: "bash", args: { secret: "not reported" } });
  await token("omo_activity", "Running bash");
  await token("omo_summary", "Running bash");
  assert.equal((await pane()).state_labels?.working, undefined);
  const question = h.runner.getUIContext().confirm("Private QA title", "Private QA question");
  await state("blocked"); await token("omo_attention", "Needs your input"); h.answer(false); assert.equal(await question, false); await state("working");
  await h.runner.emit({ type: "agent_end", messages: [] });
  await h.runner.emit({ type: "tool_execution_end", toolCallId: "qa-tool", toolName: "bash", result: {}, isError: false });
  const summary = h.runner.getToolDefinition("herdr_summary"); assert.ok(summary);
  await summary.execute("qa-summary", {task:"Verify overview",result:"Fixture checks passed",workItem:"PR owner/repo#42"}, undefined, undefined, h.runner.createCommandContext());
  await token("omo_task", "Verify overview"); await token("omo_result", "Fixture checks passed");
  await token("omo_work_item", "PR #42");
  await token("omo_summary", "Verify overview"); await state("working");
  await h.runner.emit({ type: "agent_settled" }); await state("idle"); await token("omo_activity");
  await token("omo_result", "Fixture checks passed");
  // Public events with synthetic compaction data: no provider invocation.
  const before = { type: "session_before_compact", requestId: "qa", reason: "manual", willRetry: false, signal: new AbortController().signal, preparation: {}, branchEntries: [] };
  await h.runner.emit(before as Parameters<ExtensionRunner["emit"]>[0]);
  await state("working"); await token("omo_activity", "Compacting context");
  await h.runner.emit({ type: "session_compact", requestId: "qa", reason: "manual", accepted: false, rejectionCause: "cancelled-by-extension", fromExtension: false, willRetry: false });
  await state("idle"); await token("omo_activity");
  model = { provider: "qa", id: "second-model" } as ExtensionContext["model"];
  contextUsage = { tokens: 50, percent: 5, contextWindow: 1000 };
  session.newSession();
  await h.runner.emit({ type: "session_start", reason: "new" });
  await token("omo_model", "qa/second-model"); await token("omo_context", "5% (50/1000)");
  await eventually(async () => (await pane()).title !== "QA session", "old session title cleared");
  await token("omo_task"); await token("omo_result"); await token("omo_tasks");
  await summary.execute("qa-result", {result:"Saved explicit result"}, undefined, undefined, h.runner.createCommandContext());
  await token("omo_result", "Saved explicit result");
  const duplicate = await host(SessionManager.inMemory(base));
  await duplicate.runner.emit({ type: "session_start", reason: "startup" });
  await duplicate.runner.emit({ type: "agent_start" });
  await duplicate.runner.emit({ type: "session_shutdown", reason: "quit" });
  await state("idle"); await token("omo_model", "qa/second-model");
  const rpc = await host(SessionManager.inMemory(base), "rpc");
  await rpc.runner.emit({ type: "session_start", reason: "startup" });
  await rpc.runner.emit({ type: "agent_start" }); await state("idle");
  const doctor = h.runner.getCommand("herdr"); assert.ok(doctor);
  await doctor.handler("doctor", h.runner.createCommandContext());
  assert.match(notices.at(-1)!, /Connection: OK/);
  observations.push("doctor verifies official Herdr and the current pane");
  await h.runner.emit({ type: "session_shutdown", reason: "reload" });
  await state("unknown"); await token("omo_model"); await token("omo_context"); await token("other", "preserve");
  const reloaded = await host(session);
  await reloaded.runner.emit({ type: "session_start", reason: "reload" });
  await state("idle"); await token("omo_model", "qa/second-model");
  await token("omo_result", "Saved explicit result");
  await reloaded.runner.emit({ type: "session_shutdown", reason: "quit" }); await state("unknown");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ version, checks: observations, errors }, null, 2));
} finally {
  subscription?.destroy();
  for (const runner of runners) await runner.emit({ type: "session_shutdown", reason: "quit" });
  if (server && server.exitCode === null && server.pid) {
    const exited = once(server, "exit");
    const forceStop = setTimeout(() => server?.kill("SIGKILL"), 7000);
    try {
      try { await command("server", "stop"); } catch { server.kill("SIGTERM"); }
      await exited;
    } finally { clearTimeout(forceStop); }
  }
  await rm(base, { recursive: true, force: true });
}
