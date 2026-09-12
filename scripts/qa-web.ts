/** Real Senpi loader/runner/RPC event bus with fixture OmO events; no model or real browser. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  discoverAndLoadExtensions,
  ExtensionRunner,
  SessionManager,
  type ExtensionUIContext,
  type ExtensionActions,
  type ExtensionContextActions,
  type ModelRegistry,
} from "@code-yeongyu/senpi";
import type { WebSnapshot } from "../src/web-model.ts";

const bin = process.env.HERDR_BIN_PATH;
assert.ok(bin, "Set HERDR_BIN_PATH to the installed Herdr executable");
const { stdout } = await promisify(execFile)(bin, ["status", "client"], {
  timeout: 5000,
});
const protocol = Number(stdout.match(/^protocol: (\d+)$/m)?.[1]);
assert.ok(Number.isInteger(protocol), "Could not read Herdr client protocol");
const directory = await mkdtemp(join(tmpdir(), "omo-herdr-web-qa-"));
const endpoint = join(directory, "herdr.sock");
const messages: string[] = [];
const opened: Array<{ command: string; args: string[] }> = [];
const errors: unknown[] = [];
const savedEnvironment = { ...process.env };
const server = createServer((socket) => {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("error", () => {});
  socket.on("data", (chunk) => {
    buffer += chunk;
    if (!buffer.includes("\n")) return;
    const request = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
    const result =
      request.method === "ping"
        ? { type: "pong", protocol, version: "qa" }
        : { type: "ok" };
    socket.end(JSON.stringify({ id: request.id, result }) + "\n");
  });
});
let runner: ExtensionRunner | undefined;
try {
  server.listen(endpoint);
  await once(server, "listening");
  Object.assign(process.env, {
    HERDR_ENV: "1",
    HERDR_BIN_PATH: bin,
    HERDR_PANE_ID: "w1:p1",
    HERDR_SOCKET_PATH: endpoint,
  });
  delete process.env.OMO_HERDR_OWNER_PID;
  const fixture = join(directory, "fixture.ts");
  // Load the real product entrypoint through Senpi. Only OS browser launching is replaced;
  // commands, RPC emission, bus subscription and context creation use the real host APIs.
  await writeFile(
    fixture,
    `
import omoHerdr from ${JSON.stringify(new URL("../src/index.ts", import.meta.url).pathname)};
export default function fixture(pi) {
  omoHerdr({ ...pi, exec: async (command, args) => {
    pi.events.emit("qa:browser-open", { command, args });
    return { stdout: "", stderr: "", code: 0, killed: false };
  }});
  pi.registerCommand("qa-web-emit", { description: "Emit fixture events", handler: async args => {
    const event = JSON.parse(args);
    pi.rpc.emit(event.name, event.data);
  }});
}
`,
  );
  const loaded = await discoverAndLoadExtensions(
    [fixture],
    directory,
    directory,
  );
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  assert.ok(loaded.eventBus);
  loaded.eventBus.on("qa:browser-open", (value) =>
    opened.push(value as (typeof opened)[number]),
  );
  const session = SessionManager.inMemory(directory);
  runner = new ExtensionRunner(
    loaded.extensions,
    loaded.runtime,
    directory,
    session,
    {} as ModelRegistry,
    loaded.eventBus,
  );
  runner.bindCore(
    {
      appendEntry: (type: string, data: unknown) => {
        session.appendCustomEntry(type, data);
      },
    } as unknown as ExtensionActions,
    {
      getModel: () => undefined,
      isIdle: () => true,
      hasPendingMessages: () => false,
      isCompacting: () => false,
      getContextUsage: () => undefined,
    } as ExtensionContextActions,
  );
  runner.setUIContext(
    {
      notify: (message: string) => messages.push(message),
    } as unknown as ExtensionUIContext,
    "tui",
  );
  runner.onError((error) => errors.push(error));
  const host = runner;
  const command = async (name: string, args: string) => {
    const registered = host.getCommand(name);
    assert.ok(registered, `Missing /${name} command`);
    await registered.handler(args, host.createCommandContext());
  };
  const emit = (name: string, data: unknown) =>
    command("qa-web-emit", JSON.stringify({ name, data }));
  const open = async () => {
    await command("herdr", "web");
    const message = messages.at(-1);
    assert.match(message ?? "", /^Agent overview: http:\/\/127\.0\.0\.1:/);
    const url = new URL(message!.slice("Agent overview: ".length));
    if (process.platform !== "win32") {
      assert.deepEqual(opened.at(-1), {
        command: process.platform === "darwin" ? "open" : "xdg-open",
        args: [url.href],
      });
    }
    return url;
  };
  const snapshot = async (url: URL): Promise<WebSnapshot> => {
    const response = await fetch(`${url.origin}/api/snapshot`, {
      headers: { Authorization: `Bearer ${url.hash.slice(1)}` },
    });
    assert.equal(response.status, 200);
    return (await response.json()) as WebSnapshot;
  };

  await command("herdr", "web");
  assert.match(messages.at(-1) ?? "", /requires an active OmO session/);
  assert.equal(opened.length, 0);
  await host.emit({ type: "session_start", reason: "startup" });
  await host.emit({ type: "agent_start" });
  const root = session.getSessionId();
  await emit("omo.task.updated", {
    parent_session_id: root,
    tasks: [
      {
        task_id: "st_backend",
        name: "Build API",
        agent_type: "Backend",
        child_session_id: "qa-child",
        status: "running",
      },
      {
        task_id: "st_frontend",
        name: "Login view",
        agent_type: "Frontend",
        status: "pending",
      },
    ],
  });
  await emit("omo.task.updated", {
    parent_session_id: "qa-child",
    tasks: [
      {
        task_id: "st_tests",
        name: "API tests",
        agent_type: "Tester",
        status: "pending",
        final_response: "QA_PRIVATE_OUTPUT",
      },
    ],
  });
  await emit("omo.dag.updated", {
    parent_session_id: root,
    runs: [
      {
        run_id: "qa-run",
        name: "Login workflow",
        status: "running",
        nodes: [
          { id: "api", task_id: "st_backend", state: "running" },
          { id: "ui", task_id: "st_frontend", state: "pending" },
        ],
        edges: [{ from: "api", to: "ui" }],
      },
    ],
  });
  await emit("omo.task.updated", {
    parent_session_id: "foreign-session",
    tasks: [
      { task_id: "st_foreign", name: "QA_FOREIGN_DATA", status: "running" },
    ],
  });
  const url = await open();
  assert.equal(
    (await open()).href,
    url.href,
    "Repeated open must reuse the session server",
  );
  const page = await fetch(url.origin);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
  assert.match(
    await page.text(),
    /<script[^>]+src=/,
    "The built application must be served",
  );
  const state = await snapshot(url);
  assert.equal(state.session.id, root);
  assert.equal(state.session.state, "running");
  assert.deepEqual(
    state.tasks.map((task) => [task.id, task.parentTaskId]),
    [
      ["st_backend", undefined],
      ["st_frontend", undefined],
      ["st_tests", "st_backend"],
    ],
  );
  assert.deepEqual(state.runs[0]?.edges, [{ from: "api", to: "ui" }]);
  assert.ok(!JSON.stringify(state).includes("QA_PRIVATE_OUTPUT"));
  assert.ok(!JSON.stringify(state).includes("QA_FOREIGN_DATA"));
  assert.equal(state.research.status, "unavailable");
  await emit("omo.research.capability", {
    schema_version: 1, root_session_id: root, parent_session_id: root,
    producer: "omo", capture: "enabled", coverage: "supported-tools",
    supported_operations: ["search", "retrieval"], sequence: 0, revision: 1,
  });
  const research = {
    schema_version: 1, root_session_id: root, parent_session_id: root,
    child_session_id: "qa-child", task_id: "st_backend", occurred_at: new Date().toISOString(),
  };
  await emit("omo.research.event", { ...research, event_id: "search-complete", operation_id: "search",
    tool_call_id: "search-tool", sequence: 1, kind: "search", phase: "completed", query: "Herdr integration",
    evidence: "search-results", sources: [{ title: "Herdr docs", url: "https://herdr.dev/docs/integrations/" }],
    raw_result: "QA_PRIVATE_OUTPUT",
  });
  await emit("omo.research.event", { ...research, event_id: "retrieval-complete", operation_id: "retrieval",
    tool_call_id: "retrieval-tool", sequence: 2, kind: "retrieval", phase: "completed",
    requested_url: "https://herdr.dev/docs/integrations/", final_url: "https://herdr.dev/docs/integrations/",
    http_status: 200, evidence: "response-received", related_search_id: "search",
  });
  await emit("omo.research.event", { ...research, event_id: "foreign-research", operation_id: "foreign",
    tool_call_id: "foreign-tool", sequence: 3, kind: "search", phase: "completed", child_session_id: "foreign",
    query: "QA_FOREIGN_DATA",
  });
  const researchState = await snapshot(url);
  assert.equal(researchState.research.status, "available");
  assert.deepEqual(researchState.research.records.map(r => r.state), ["completed", "fetched"]);
  assert.equal(researchState.research.records[1]?.relatedSearchId, researchState.research.records[0]?.id);
  assert.ok(!JSON.stringify(researchState).includes("QA_PRIVATE_OUTPUT"));
  assert.ok(!JSON.stringify(researchState).includes("QA_FOREIGN_DATA"));
  await emit("omo.task.updated", {
    parent_session_id: "qa-child",
    tasks: [
      {
        task_id: "st_tests",
        name: "API tests",
        agent_type: "Tester",
        status: "completed",
      },
    ],
  });
  assert.equal(
    (await snapshot(url)).tasks.find((task) => task.id === "st_tests")?.state,
    "completed",
  );
  await host.emit({ type: "agent_settled" });
  assert.equal((await snapshot(url)).session.state, "idle");

  await host.emit({ type: "session_shutdown", reason: "new" });
  await assert.rejects(
    fetch(url.origin),
    "Session replacement must close the old server",
  );
  session.newSession();
  await host.emit({ type: "session_start", reason: "new" });
  const replacement = await open();
  assert.notEqual(
    replacement.hash,
    url.hash,
    "Replacement session must receive a fresh token",
  );
  const fresh = await snapshot(replacement);
  assert.equal(fresh.session.id, session.getSessionId());
  assert.notEqual(fresh.session.id, root);
  assert.deepEqual(fresh.tasks, []);
  assert.deepEqual(fresh.runs, []);
  assert.deepEqual(fresh.research.records, []);
  assert.equal(fresh.research.status, "unavailable");
  await emit("omo.task.updated", {
    parent_session_id: root,
    tasks: [{ task_id: "st_old", status: "running" }],
  });
  assert.deepEqual((await snapshot(replacement)).tasks, []);
  await host.emit({ type: "session_shutdown", reason: "quit" });
  runner = undefined;
  await assert.rejects(
    fetch(replacement.origin),
    "Shutdown must close the HTTP server",
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: Real Senpi loader, command context and public RPC bus deliver fixture task/DAG/research events to the built web overview.",
  );
  console.log(
    "PASS: Nested agent ownership, live updates, session isolation, replacement and HTTP shutdown.",
  );
  console.log(
    "Fixture events only: no real OmO/model execution, browser launch, user sessions or global configuration.",
  );
} finally {
  await runner?.emit({ type: "session_shutdown", reason: "quit" });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
  for (const key of [
    "HERDR_ENV",
    "HERDR_BIN_PATH",
    "HERDR_PANE_ID",
    "HERDR_SOCKET_PATH",
    "OMO_HERDR_OWNER_PID",
  ]) {
    if (savedEnvironment[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnvironment[key];
  }
}
