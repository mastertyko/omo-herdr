/** Real Senpi loader + ExtensionRunner + UI prompt events + Herdr CLI; isolated mock socket server. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import {
  discoverAndLoadExtensions, ExtensionRunner, SessionManager,
  type ExtensionUIContext, type ExtensionActions, type ExtensionContextActions, type ModelRegistry,
} from "@code-yeongyu/senpi";

const bin = process.env.HERDR_BIN_PATH;
assert.ok(bin, "Set HERDR_BIN_PATH to the installed Herdr executable");
const { stdout: clientStatus } = await promisify(execFile)(bin, ["status", "client"], { timeout: 5000 });
const protocol = Number(clientStatus.match(/^protocol: (\d+)$/m)?.[1]);
assert.ok(Number.isInteger(protocol), "Could not read Herdr client protocol");
const directory = await mkdtemp(join(tmpdir(), "omo-herdr-qa-"));
const endpoint = join(directory, "herdr.sock");
const requests: Array<{ id: string; method: string; params: Record<string, unknown> }> = [];
const server = createServer((socket) => {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("error", () => {});
  socket.on("data", (chunk) => {
    buffer += chunk;
    if (!buffer.includes("\n")) return;
    const request = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
    if (request.method !== "ping") requests.push(request);
    const result = request.method === "ping" ? { type: "pong", protocol, version: "qa" } : { type: "ok" };
    socket.end(JSON.stringify({ id: request.id, result }) + "\n");
  });
});

let runner: ExtensionRunner | undefined;
const errors: unknown[] = [];
try {
  server.listen(endpoint);
  await once(server, "listening");
  Object.assign(process.env, {
    HERDR_ENV: "1", HERDR_BIN_PATH: bin, HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: endpoint,
  });
  delete process.env.OMO_HERDR_OWNER_PID;
  const loaded = await discoverAndLoadExtensions([new URL("../src/index.ts", import.meta.url).pathname], directory, directory);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  assert.equal(requests.length, 0, "factory must not start reporting");
  // No model or provider is used by these host lifecycle/UI calls.
  const session = SessionManager.inMemory(directory);
  runner = new ExtensionRunner(loaded.extensions, loaded.runtime, directory, session, {} as ModelRegistry);
  runner.bindCore({appendEntry: (type: string, data: unknown) => { session.appendCustomEntry(type, data); }} as unknown as ExtensionActions, {getModel:()=>undefined, isIdle:()=>true, hasPendingMessages:()=>false, isCompacting:()=>false, getContextUsage:()=>undefined} as ExtensionContextActions);
  runner.onError((error) => errors.push(error));
  let answer!: (value: boolean) => void;
  runner.setUIContext({ confirm: () => new Promise<boolean>((resolve) => { answer = resolve; }) } as unknown as ExtensionUIContext, "tui");

  async function waitFor(state: string) {
    for (let i = 0; i < 200; i++) {
      if (requests.filter(request => request.method === "pane.report_agent").at(-1)?.params.state === state) { await delay(30); return; }
      await delay(10);
    }
    throw new Error(`Missing ${state}: ${JSON.stringify({ requests, errors })}`);
  }

  await runner.emit({ type: "session_start", reason: "startup" });
  await waitFor("idle");
  await runner.emit({ type: "agent_start" });
  await waitFor("working");
  const prompt = runner.getUIContext().confirm("QA confirmation", "Continue?");
  await waitFor("blocked");
  answer(true);
  assert.equal(await prompt, true);
  await waitFor("working");
  await runner.emit({ type: "agent_settled" });
  await waitFor("idle");
  await runner.emit({ type: "session_shutdown", reason: "quit" });
  runner = undefined;
  assert.deepEqual(errors, []);
  assert.deepEqual(requests.filter(request => request.method !== "pane.report_metadata").map((request) => request.method === "pane.release_agent" ? "release" : request.params.state),
    ["idle", "working", "blocked", "working", "idle", "release"]);
  assert.ok(requests.every((request) => ["custom:omo", "custom:omo:metadata"].includes(String(request.params.source)) && request.params.agent === "omo"));
  assert.equal(requests[0]?.params.agent_session_id, session.getSessionId());
  console.log("PASS: Senpi loader, lifecycle and real UI prompt events through Herdr CLI to an isolated mock socket.");
  console.log("No model requests, user sessions or global configuration were used.");
} finally {
  await runner?.emit({ type: "session_shutdown", reason: "quit" });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
}
