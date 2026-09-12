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
    "Task",
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
