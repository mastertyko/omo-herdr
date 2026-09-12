/** Public Senpi host + official Herdr server, all in disposable directories. No model calls. */
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import {
  discoverAndLoadExtensions, ExtensionRunner, SessionManager,
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
let serverOutput = "";
const runners: ExtensionRunner[] = [];
const errors: unknown[] = [];
const observations: string[] = [];
const notices: string[] = [];
let paneId: string;
async function eventually(predicate: () => Promise<boolean>, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) { if (await predicate()) { observations.push(label); return; } await delay(25); }
  throw new Error(`Missing ${label}. Errors: ${JSON.stringify(errors)}; server: ${serverOutput.slice(-2000)}`);
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
  const loaded = await discoverAndLoadExtensions([entry], base, join(base, "empty"));
  assert.deepEqual(loaded.errors, []);
  const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, base, session, {} as ModelRegistry);
  runner.bindCore({} as ExtensionActions, {
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
  await writeFile(join(base, "config/herdr/config.toml"), `onboarding = false
[ui.sidebar.agents]
rows = [
  ["state_icon", "agent", "state_text"],
  ["pane"],
  ["$omo_model", "$omo_context"],
  ["workspace", "tab"],
]
`);
  server = spawn(bin, ["server"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let spawnError: Error | undefined;
  server.on("error", error => { spawnError = error; });
  server.stdout?.on("data", bytes => { serverOutput += bytes; });
  server.stderr?.on("data", bytes => { serverOutput += bytes; });
  await eventually(async () => {
    if (spawnError) throw spawnError;
    try { await call("workspace", "list"); return true; } catch { return false; }
  }, "isolated server ready");
  const workspace = await call("workspace", "create", "--cwd", base, "--label", "omo-herdr-qa");
  paneId = workspace.result.root_pane.pane_id;
  Object.assign(process.env, env, { HERDR_ENV: "1", HERDR_BIN_PATH: bin, HERDR_PANE_ID: paneId });
  delete process.env.OMO_HERDR_OWNER_PID;
  const session = SessionManager.inMemory(base);
  session.appendSessionInfo("QA session");
  const h = await host(session);
  await h.runner.emit({ type: "session_start", reason: "startup" });
  await state("idle");
  await token("omo_model", "qa/first-model");
  await token("omo_context", "42% (420/1000)");
  await eventually(async () => (await pane()).title === "QA session", "session title");
  // A foreign token must survive our refresh, session replacement and cleanup.
  await command("pane", "report-metadata", paneId, "--source", "qa:other", "--token", "other=preserve");
  await h.runner.emit({ type: "agent_start" }); await state("working");
  await h.runner.emit({ type: "tool_execution_start", toolCallId: "qa-tool", toolName: "bash", args: { secret: "not reported" } });
  await token("omo_activity", "Running bash");
  await eventually(async () => (await pane()).state_labels?.working === "Running bash", "working presentation label");
  const question = h.runner.getUIContext().confirm("Private QA title", "Private QA question");
  await state("blocked"); h.answer(false); assert.equal(await question, false); await state("working");
  await h.runner.emit({ type: "agent_end", messages: [] }); await delay(100); await state("working");
  await h.runner.emit({ type: "tool_execution_end", toolCallId: "qa-tool", toolName: "bash", result: {}, isError: false });
  await h.runner.emit({ type: "agent_settled" }); await state("idle"); await token("omo_activity");
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
  await reloaded.runner.emit({ type: "session_shutdown", reason: "quit" }); await state("unknown");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ version, checks: observations, errors }, null, 2));
} finally {
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
