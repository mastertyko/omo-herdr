import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebModel, parseRuns, parseTasks } from "../src/web-model.ts";
import { startWebServer, type WebServer } from "../src/web-server.ts";
import { request } from "node:http";
import { WebOverview } from "../src/web-overview.ts";
import type { ExtensionAPI, ExtensionContext } from "@code-yeongyu/senpi";
const root = {
  id: "root",
  title: "Root",
  project: "test",
  state: "running" as const,
};
const tasks = (session: string, values: object[]) => ({
  parent_session_id: session,
  tasks: values,
});
const task = (id: string, extra: object = {}) => ({
  task_id: id,
  name: id,
  agent_type: "Backend",
  status: "running",
  ...extra,
});

test("web model admits only explicit descendants, replaces snapshots and drops old session data", () => {
  const m = new WebModel();
  m.receive(
    "omo.task.updated",
    tasks("root", [task("st_parent", { child_session_id: "child" })]),
  );
  m.start(root);
  m.receive("omo.task.updated", tasks("stranger", [task("st_secret")]));
  m.receive("omo.task.updated", tasks("child", [task("st_child")]));
  assert.deepEqual(
    m.snapshot().tasks.map((t) => [t.id, t.parentTaskId]),
    [
      ["st_parent", undefined],
      ["st_child", "st_parent"],
    ],
  );
  m.receive("omo.task.updated", tasks("root", []));
  assert.deepEqual(m.snapshot().tasks, []);
  assert.deepEqual(m.snapshot().activity, []);
  m.receive("omo.task.updated", tasks("child", [task("st_late")]));
  assert.deepEqual(m.snapshot().tasks, []);
  m.start({ ...root, id: "other" });
  assert.equal(m.snapshot().tasks.length, 0);
  m.clear();
  assert.equal(m.snapshot().session.id, "");
});
test("web projection excludes prompt/output/tool arguments and bounds unknown or oversized snapshots", () => {
  const parsed = parseTasks(
    tasks("root", [
      task("st_one", {
        description: "SECRET",
        final_response: "SECRET",
        spawn_spec: { prompt: "SECRET" },
        live_progress: {
          current_tool: "read",
          last_assistant_line: "SECRET",
          activity: "SECRET",
        },
        status: "future",
      }),
      task("st_one"),
      task("st_wrong", { parent_session_id: "elsewhere" }),
    ]),
  );
  assert.equal(parsed?.tasks.length, 1);
  assert.equal(parsed?.tasks[0]?.state, "unknown");
  assert.ok(!JSON.stringify(parsed).includes("SECRET"));
  assert.equal(
    parseTasks(
      tasks(
        "root",
        Array.from({ length: 300 }, (_, i) => task(`st_${i}`)),
      ),
    )?.omitted,
    44,
  );
  assert.equal(parseTasks(null), undefined);
});
test("current OmO tool display strings expose only the tool identifier, never argument previews", () => {
  const parsed = parseTasks(tasks("root", [
    task("st_read", { live_progress: { current_tool: "read /private/SECRET.txt" } }),
    task("st_bash", { live_progress: { current_tool: "bash echo SECRET" } }),
    task("st_mcp", { live_progress: { current_tool: "mcp__service__lookup SECRET" } }),
    task("st_plain", { live_progress: { current_tool: "write" } }),
    task("st_invalid", { live_progress: { current_tool: "/private/SECRET.txt" } }),
    task("st_done", { status: "completed", live_progress: { current_tool: "read SECRET" } }),
  ]));
  assert.deepEqual(parsed?.tasks.map((t) => t.activity), [
    "read", "bash", "mcp__service__lookup", "write", undefined, undefined,
  ]);
  assert.ok(!JSON.stringify(parsed).includes("SECRET"));
});

test("DAG dependency edges never become agent ownership; unknown endpoints, duplicates and cycles handled", () => {
  const m = new WebModel();
  m.start(root);
  m.receive(
    "omo.task.updated",
    tasks("root", [task("st_one"), task("st_two")]),
  );
  const run = {
    run_id: "r",
    status: "running",
    nodes: [
      { id: "a", task_id: "st_one", state: "running", prompt: "SECRET" },
      { id: "b", task_id: "st_two", state: "pending" },
    ],
    edges: [
      { from: "a", to: "b" },
      { from: "a", to: "b" },
      { from: "unknown", to: "b" },
    ],
  };
  m.receive("omo.dag.updated", { parent_session_id: "root", runs: [run] });
  assert.equal(m.snapshot().runs[0]?.edges.length, 1);
  assert.ok(m.snapshot().tasks.every((t) => t.parentTaskId === undefined));
  assert.ok(!JSON.stringify(m.snapshot()).includes("SECRET"));
  assert.equal(
    parseRuns({
      parent_session_id: "root",
      runs: [
        {
          ...run,
          edges: [
            { from: "a", to: "b" },
            { from: "b", to: "a" },
          ],
        },
      ],
    })?.runs.length,
    0,
  );
});
test("loopback viewer serves bundle, requires session token, rejects foreign origins/hosts and writes, shuts down", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omo-web-test-"));
  await writeFile(join(dir, "index.html"), "<html>viewer</html>");
  const m = new WebModel();
  m.start(root);
  const server = await startWebServer(() => m.snapshot(), { assets: dir });
  const url = new URL(server.url);
  const auth = { Authorization: `Bearer ${url.hash.slice(1)}` };
  try {
    const page = await fetch(url.origin);
    assert.equal(page.status, 200);
    assert.match(
      page.headers.get("content-security-policy") ?? "",
      /frame-ancestors 'none'/,
    );
    assert.equal((await fetch(`${url.origin}/api/snapshot`)).status, 401);
    assert.equal(
      (
        await fetch(`${url.origin}/api/snapshot`, {
          headers: { ...auth, Origin: "https://evil.example" },
        })
      ).status,
      403,
    );
    assert.equal(
      await new Promise<number | undefined>((resolve, reject) => {
        const req = request(
          `${url.origin}/api/snapshot`,
          { headers: { ...auth, Host: "evil.example" } },
          (res) => {
            res.resume();
            resolve(res.statusCode);
          },
        );
        req.on("error", reject);
        req.end();
      }),
      403,
    );
    assert.equal(
      (
        await fetch(`${url.origin}/api/snapshot`, {
          headers: auth,
          method: "POST",
        })
      ).status,
      405,
    );
    const response = await fetch(`${url.origin}/api/snapshot`, {
      headers: auth,
    });
    assert.equal((await response.json()).session.id, "root");
    m.update({ state: "completed" });
    assert.equal(
      (
        await (
          await fetch(`${url.origin}/api/snapshot`, { headers: auth })
        ).json()
      ).session.state,
      "completed",
    );
    assert.equal((await fetch(`${url.origin}/src/index.ts`)).status, 404);
    assert.equal(
      (await fetch(`${url.origin}/api/snapshot?token=${url.hash.slice(1)}`))
        .status,
      401,
    );
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
  await assert.rejects(fetch(url.origin));
});

test("nested ownership survives depth and prunes only the detached subtree", () => {
  const m = new WebModel();
  m.start(root);
  m.receive(
    "omo.task.updated",
    tasks("root", [
      task("st_a", { child_session_id: "child-a" }),
      task("st_b", { child_session_id: "child-b" }),
    ]),
  );
  m.receive(
    "omo.task.updated",
    tasks("child-a", [task("st_nested", { child_session_id: "grandchild" })]),
  );
  m.receive("omo.task.updated", tasks("grandchild", [task("st_deep")]));
  m.receive("omo.task.updated", tasks("child-b", [task("st_sibling")]));
  assert.equal(
    m.snapshot().tasks.find((t) => t.id === "st_deep")?.parentTaskId,
    "st_nested",
  );
  m.receive(
    "omo.task.updated",
    tasks("root", [task("st_b", { child_session_id: "child-b" })]),
  );
  assert.deepEqual(
    m.snapshot().tasks.map((t) => t.id),
    ["st_b", "st_sibling"],
  );
  assert.ok(!JSON.stringify(m.snapshot()).includes("st_deep"));
});

test("DAG projection rejects duplicate runs and foreign owner claims, keeps omission counts bounded", () => {
  const run = {
    run_id: "run",
    nodes: [{ id: "a" }, { id: "b" }],
    edges: [{ from: "a", to: "b" }],
  };
  const parsed = parseRuns({
    parent_session_id: "root",
    runs: [run, run, { ...run, run_id: "foreign", parent_session_id: "other" }],
    truncated_runs: Number.MAX_SAFE_INTEGER,
  });
  assert.equal(parsed?.runs.length, 1);
  assert.equal(parsed?.runs[0]?.name, "Workflow");
  assert.equal(parsed?.omitted, 1_000_002);
  assert.equal(
    parseTasks(tasks("root", [{ task_id: "st_unnamed" }]))?.tasks[0]?.label,
    "Agent task",
  );
  assert.equal(new WebModel().snapshot().session.title, "No session");
});

function overviewHarness(
  factory: typeof startWebServer,
  exec: () => Promise<unknown> = async () => ({}),
) {
  const notices: string[] = [];
  let sid = "root";
  let subscribed = 0;
  const pi = {
    events: {
      on: () => {
        subscribed++;
        return () => {
          subscribed--;
        };
      },
    },
    exec,
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: "/tmp/project",
    sessionManager: {
      getSessionId: () => sid,
      getSessionName: () => undefined,
    },
    ui: { notify: (message: string) => notices.push(message) },
  } as unknown as ExtensionContext;
  const overview = new WebOverview(pi, factory);
  return {
    overview,
    ctx,
    notices,
    setSession: (value: string) => {
      sid = value;
    },
    subscriptions: () => subscribed,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("shutdown while the viewer starts closes it and suppresses stale browser notifications", async () => {
  const pending = deferred<WebServer>();
  let closed = false;
  const h = overviewHarness(() => pending.promise);
  h.overview.start(h.ctx);
  const opening = h.overview.open(h.ctx);
  const stopping = h.overview.stop();
  pending.resolve({
    url: "http://127.0.0.1:1/#old",
    close: async () => {
      closed = true;
    },
  });
  await Promise.all([opening, stopping]);
  assert.equal(closed, true);
  assert.deepEqual(h.notices, []);
  assert.equal(h.subscriptions(), 0);
});

test("viewer requests research capability only after its session is ready to receive it", async () => {
  let receive: ((event: unknown) => void) | undefined;
  let overview: WebOverview;
  const requested: string[] = [];
  const pi = { events: {
    on: (_: string, listener: (event: unknown) => void) => { receive = listener; return () => { receive = undefined; }; },
    emit: (name: string, data: { parent_session_id: string }) => {
      assert.equal(name, "omo.research.request");
      requested.push(data.parent_session_id);
      receive?.({ name: "omo.research.capability", data: {
        schema_version: 1, root_session_id: data.parent_session_id, parent_session_id: data.parent_session_id,
        producer: "omo", capture: "enabled", coverage: "supported-tools", supported_operations: ["search"], sequence: 0, revision: 1,
      } });
      assert.equal(overview.model.snapshot().research.status, "available");
    },
  } } as unknown as ExtensionAPI;
  overview = new WebOverview(pi);
  const ctx = { sessionManager: { getSessionId: () => "ready-session" }, cwd: "/tmp/project" } as unknown as ExtensionContext;
  overview.start(ctx);
  assert.deepEqual(requested, ["ready-session"]);
  await overview.stop();
  assert.equal(overview.model.snapshot().research.status, "unavailable");
});

test("session replacement rotates the viewer even when session manager mutates in place", async () => {
  const oldLaunch = deferred<unknown>();
  const oldStarted = deferred<void>();
  let closed = false;
  let creations = 0;
  const h = overviewHarness(
    async () => ({
      url: `http://127.0.0.1:1/#${++creations}`,
      close: async () => {
        closed = true;
      },
    }),
    async () => {
      oldStarted.resolve();
      await oldLaunch.promise;
      return {};
    },
  );
  h.overview.start(h.ctx);
  const opening = h.overview.open(h.ctx);
  await oldStarted.promise;
  h.setSession("replacement");
  h.overview.start(h.ctx);
  assert.equal(closed, true);
  assert.equal(h.overview.model.snapshot().session.id, "replacement");
  assert.equal(h.overview.model.snapshot().session.title, "OmO session");
  oldLaunch.resolve({});
  await opening;
  assert.deepEqual(h.notices, []);
  await h.overview.open(h.ctx);
  assert.equal(creations, 2);
  assert.match(h.notices[0] ?? "", /#2$/);
  await h.overview.stop();
  assert.equal(h.subscriptions(), 0);
});

test("viewer survives malformed request targets and snapshot failures; close is idempotent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omo-web-invalid-"));
  await writeFile(join(dir, "index.html"), "viewer");
  let unavailable = true;
  const model = new WebModel();
  model.start(root);
  const server = await startWebServer(
    () => {
      if (unavailable) throw new Error("temporary");
      return model.snapshot();
    },
    { assets: dir },
  );
  const url = new URL(server.url);
  const headers = { Authorization: `Bearer ${url.hash.slice(1)}` };
  try {
    const malformed = await new Promise<number | undefined>(
      (resolve, reject) => {
        const req = request(url.origin, { path: "//[", headers }, (res) => {
          res.resume();
          resolve(res.statusCode);
        });
        req.on("error", reject);
        req.end();
      },
    );
    assert.equal(malformed, 400);
    assert.equal(
      (await fetch(`${url.origin}/api/snapshot`, { headers })).status,
      503,
    );
    unavailable = false;
    assert.equal(
      (await fetch(`${url.origin}/api/snapshot`, { headers })).status,
      200,
    );
    assert.equal(
      (
        await fetch(`${url.origin}/api/snapshot`, {
          headers: { ...headers, "Sec-Fetch-Site": "cross-site" },
        })
      ).status,
      403,
    );
  } finally {
    await Promise.all([server.close(), server.close()]);
    await rm(dir, { recursive: true, force: true });
  }
});

test("each viewer accepts only its own token and old tokens cannot read a replacement session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omo-web-token-"));
  await writeFile(join(dir, "index.html"), "viewer");
  const first = new WebModel();
  first.start(root);
  const second = new WebModel();
  second.start({ ...root, id: "replacement" });
  const a = await startWebServer(() => first.snapshot(), { assets: dir });
  const b = await startWebServer(() => second.snapshot(), { assets: dir });
  const aUrl = new URL(a.url),
    bUrl = new URL(b.url);
  try {
    assert.notEqual(aUrl.hash, bUrl.hash);
    assert.equal(
      (
        await fetch(`${bUrl.origin}/api/snapshot`, {
          headers: { Authorization: `Bearer ${aUrl.hash.slice(1)}` },
        })
      ).status,
      401,
    );
    const response = await fetch(`${bUrl.origin}/api/snapshot`, {
      headers: { Authorization: `Bearer ${bUrl.hash.slice(1)}` },
    });
    assert.equal((await response.json()).session.id, "replacement");
    await a.close();
    await assert.rejects(fetch(`${aUrl.origin}/api/snapshot`));
    assert.equal((await fetch(bUrl.origin)).status, 200);
  } finally {
    await Promise.all([a.close(), b.close()]);
    await rm(dir, { recursive: true, force: true });
  }
});

test("task labels prefer meaningful public names and summaries over internal IDs without reading private inputs", () => {
  const parsed = parseTasks(tasks("root", [
    task("st_named", { name: "  Audit API boundary  ", task_summary: "Alternative summary" }),
    task("st_summary", { name: "st_summary", task_summary: "Research authentication options" }),
    task("st_blank", { name: " \n\t ", task_summary: "Check error handling" }),
    task("st_fallback", { name: "st_another_id", task_summary: "st_fallback", description: "PRIVATE", spawn_spec: { prompt: "PRIVATE" } }),
    task("st_category", { name: undefined, agent_type: undefined, category: "Research" }),
    { task_id: "st_generic", name: undefined, status: "pending", description: "PRIVATE", task_summary: "" },
    task("st_clean", { name: "\u001b[31mReview\u001b[0m\ncontracts" }),
  ]));
  assert.deepEqual(parsed?.tasks.map(t => t.label), [
    "Audit API boundary", "Research authentication options", "Check error handling",
    "Backend task", "Research task", "Agent task", "Review contracts",
  ]);
  assert.equal(parsed?.tasks[1]?.id, "st_summary");
  assert.ok(!JSON.stringify(parsed).includes("PRIVATE"));
});

test("activity preserves event-time state and describes state and sanitized tool transitions without inventing success", () => {
  const model = new WebModel(); model.start(root);
  const emit = (extra: object) => model.receive("omo.task.updated", tasks("root", [task("st_history", { name: "Implement authentication", ...extra })]));
  emit({ status: "pending", updated_at: "2026-09-12T08:00:00Z" });
  emit({ updated_at: "2026-09-12T08:01:00Z" });
  emit({ live_progress: { current_tool: "read /private/SECRET.txt" }, updated_at: "2026-09-12T08:01:00Z" });
  emit({ live_progress: { current_tool: "read /private/OTHER_SECRET.txt" }, updated_at: "2026-09-12T08:01:00Z" });
  emit({ live_progress: {}, updated_at: "2026-09-12T08:01:00Z" });
  emit({ status: "paused", updated_at: "2026-09-12T08:02:00Z" });
  emit({ status: "running", agent_type: "Changed agent", name: "Renamed task", updated_at: "2026-09-12T08:03:00Z" });
  emit({ status: "completed", terminal_at: "2026-09-12T08:04:00Z", updated_at: "2026-09-12T08:05:00Z" });
  const history = [...model.snapshot().activity].reverse();
  assert.deepEqual(history.map(e => e.action), [
    "Observed pending", "Started working", "Started reporting read", "Stopped reporting read", "Paused", "Started working", "Completed",
  ]);
  assert.deepEqual(history.map(e => e.kind), ["observed", "state", "tool", "tool", "state", "state", "state"]);
  assert.deepEqual(history.map(e => e.state), ["pending", "running", "running", "running", "paused", "running", "completed"]);
  assert.equal(history[2]?.tool, "read");
  assert.equal(history[2]?.sourceAt, undefined);
  assert.equal(history[3]?.tool, "read");
  assert.equal(history[1]?.sourceAt, "2026-09-12T08:01:00.000Z");
  assert.equal(history[6]?.sourceAt, "2026-09-12T08:04:00.000Z");
  assert.equal(history[4]?.previousState, "running");
  assert.equal(history[0]?.agent, "Backend");
  assert.equal(history[0]?.taskLabel, "Implement authentication");
  assert.equal(history[0]?.label, "Backend · Implement authentication");
  assert.equal(history[5]?.agent, "Changed agent");
  assert.equal(history[5]?.taskLabel, "Renamed task");
  assert.ok(!JSON.stringify(history).includes("SECRET"));
  assert.ok(!JSON.stringify(history).includes("succeeded"));
  assert.equal(new Set(history.map(e => e.id)).size, history.length);
  assert.ok(history.every(e => Number.isFinite(Date.parse(e.at))));
});

test("activity distinguishes failures and cancellation, ignores unchanged snapshots, and never fabricates missed transitions", () => {
  const model = new WebModel(); model.start(root);
  const send = (status: string, extra: object = {}) => model.receive("omo.task.updated", tasks("root", [task("st_outcome", { status, ...extra })]));
  send("running");send("error");send("error", { updated_at: "2026-09-12T09:00:00Z" });send("paused");send("cancelled");
  assert.deepEqual([...model.snapshot().activity].reverse().map(e => e.action), ["Observed running", "Failed", "Paused", "Cancelled"]);
  const failed = model.snapshot().activity.find(e => e.action === "Failed");
  assert.equal(failed?.state, "failed");assert.equal(failed?.sourceAt, undefined);
  model.receive("omo.task.updated", tasks("root", [task("st_finished", { status: "completed" })]));
  assert.deepEqual(model.snapshot().activity.map(e => e.action), ["Observed completed"]);
  model.receive("omo.task.updated", tasks("root", []));
  assert.deepEqual(model.snapshot().activity, []);
});
