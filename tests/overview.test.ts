import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createEventBus, SessionManager, type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@code-yeongyu/senpi";
import { Overview, elapsed } from "../src/overview.ts";
import { taskLabels, taskSnapshot } from "../src/tasks.ts";
import { metadataArgs, metadataFor } from "../src/metadata.ts";
import { gitContext } from "../src/git.ts";

function payload(session: string, statuses: string[]) {
  return { parent_session_id: session, tasks: statuses.map((status, i) => ({ task_id: `st_${i}`, status })) };
}
test("task adapter counts full snapshots without double counting DAG nodes, other parents or secrets", () => {
  const snapshot = payload("mine", ["running", "pending", "completed", "error", "cancelled", "interrupted", "lost", "future-state"]);
  snapshot.tasks.push({ task_id: "st_0", status: "completed" });
  const data = { ...snapshot, tasks: [...snapshot.tasks, { task_id: "st_foreign", parent_session_id: "other", status: "running" }, { task_id: "invalid", status: "running" }],
    truncated_tasks: 4, prompt: "SECRET", final_response: "SECRET" };
  const result = taskSnapshot(data)!;
  assert.deepEqual(result.counts, { running: 1, pending: 1, completed: 1, failed: 3, cancelled: 1, unknown: 1, omitted: 4 });
  assert.equal(taskLabels(result.counts).attention, "3 failed tasks");
  assert.match(taskLabels(result.counts).tasks!, /\+4 not shown/);
  assert.ok(!JSON.stringify(result).includes("SECRET"));
  assert.equal(taskSnapshot({ tasks: [] }), undefined);
  assert.equal(taskLabels(taskSnapshot(payload("mine", []))!.counts).tasks, undefined);
});

test("overview captures startup, isolates sessions, persists explicit results and clears on new work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omo-overview-"));
  const bus = createEventBus();
  const session = SessionManager.inMemory(directory);
  let tool!: ToolDefinition;
  let changes = 0;
  const api = { events: bus, registerTool: (value: ToolDefinition) => { tool = value; },
    appendEntry: (kind: string, data: unknown) => session.appendCustomEntry(kind, data) } as unknown as ExtensionAPI;
  const ctx = { mode: "tui", hasUI: true, cwd: directory, sessionManager: session } as unknown as ExtensionContext;
  const overview = new Overview(api, () => { changes++; });
  const emit = (id: string, statuses: string[]) => bus.emit("senpi:extension-rpc-event", { name: "omo.task.updated", data: payload(id, statuses) });
  try {
    emit(session.getSessionId(), ["running", "completed"]);
    overview.start(ctx);
    assert.equal(overview.metadata(false).tasks, "1 running · 1 completed");
    emit("foreign-session", ["error"]);
    assert.equal(overview.metadata(false).attention, undefined);
    overview.begin(1000);
    assert.equal(overview.metadata(false, 62000).elapsed, "01:01");
    assert.equal(overview.metadata(true, 62000).attention, "Needs your input");
    assert.equal(overview.metadata(true, 65000).elapsed, "Waiting 00:03");
    const foreign = { ...ctx, sessionManager: SessionManager.inMemory(directory) } as ExtensionContext;
    assert.equal((await tool.execute("id", { result: "wrong" }, undefined, undefined, foreign)).isError, true);
    await tool.execute("id", { task: "Implement overview", result: "12 tests passed · PR #42" }, undefined, undefined, ctx);
    overview.settle(false, 70000);
    assert.equal(overview.metadata(false, 80000).elapsed, "01:09");
    assert.equal(overview.metadata(false).result, "12 tests passed · PR #42");
    overview.stop();
    overview.start(ctx);
    assert.equal(overview.metadata(false).result, "12 tests passed · PR #42");
    overview.begin();
    assert.equal(overview.metadata(false).result, undefined);
    overview.settle(true);
    assert.equal(overview.metadata(false).result, "Stopped");
    overview.stop(true);
    session.newSession();
    emit(session.getSessionId(), ["pending"]);
    overview.start(ctx);
    assert.equal(overview.metadata(false).result, undefined);
    assert.equal(overview.metadata(false).tasks, "1 pending");
    emit(session.getSessionId(), []);
    assert.equal(overview.metadata(false).tasks, undefined, "empty full snapshot clears previous tasks");
    overview.stop();
    const count = changes;
    emit(session.getSessionId(), ["error"]);
    assert.equal(changes, count, "shutdown unsubscribes");
  } finally { overview.stop(); await rm(directory, { recursive: true, force: true }); }
});

test("Git identity supports unborn branches, detached HEAD, worktrees, and ordinary folders", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omo-git-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", directory, ...args], { stdio: "pipe" });
  try {
    assert.deepEqual(await gitContext(directory), {});
    git("init", "-b", "main");
    assert.equal((await gitContext(directory)).branch, "main");
    git("-c", "user.name=QA", "-c", "user.email=qa@example.invalid", "commit", "--allow-empty", "-m", "fixture");
    git("worktree", "add", "-b", "feature", join(directory, "linked"));
    assert.deepEqual(await gitContext(join(directory, "linked")), { branch: "feature", worktree: "linked", repository: basename(directory), project: `${basename(directory)}/linked` });
    git("checkout", "--detach");
    assert.match((await gitContext(directory)).branch!, /^detached [a-f0-9]+$/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("explicit PR and issue references reach Herdr, survive resume, and clear with new work", async () => {
  const session = SessionManager.inMemory(tmpdir());
  let tool!: ToolDefinition;
  const api = { events: createEventBus(), registerTool: (value: ToolDefinition) => { tool = value; },
    appendEntry: (kind: string, data: unknown) => session.appendCustomEntry(kind, data) } as unknown as ExtensionAPI;
  const ctx = { mode: "tui", hasUI: true, cwd: tmpdir(), sessionManager: session } as unknown as ExtensionContext;
  const overview = new Overview(api, () => {});
  const tokens = () => metadataArgs(overview.metadata(false), 1, "w1:p1");
  try {
    overview.start(ctx);
    overview.begin(1000);
    const updated = await tool.execute("ref", { workItem: "\x1b[32mPR #42\x1b[0m · Issue #17\n" }, undefined, undefined, ctx);
    assert.notEqual(updated.isError, true);
    assert.ok(tokens().includes("omo_work_item=PR #42 · Issue #17"));
    await tool.execute("label", { task: "Review fix" }, undefined, undefined, ctx);
    assert.ok(tokens().includes("omo_work_item=PR #42 · Issue #17"), "partial updates preserve the reference");
    overview.settle(true, 2000);
    overview.stop();
    overview.start(ctx);
    assert.ok(tokens().includes("omo_work_item=PR #42 · Issue #17"), "resume restores the reference even after abort");
    overview.begin(3000);
    assert.ok(tokens().includes("omo_work_item"), "new work clears the old token");
    await tool.execute("issue", { workItem: "Issue #18" }, undefined, undefined, ctx);
    overview.begin(3500);
    assert.ok(tokens().includes("omo_work_item=Issue #18"), "continuations retain the reference");
    await tool.execute("clear", { workItem: "" }, undefined, undefined, ctx);
    assert.ok(tokens().includes("omo_work_item"), "explicit empty value clears the token");
    await tool.execute("pr", { workItem: "PR #43" }, undefined, undefined, ctx);
    overview.stop(true);
    session.newSession();
    overview.start(ctx);
    assert.ok(tokens().includes("omo_work_item"), "a new session never inherits the reference");
  } finally { overview.stop(); }
});

test("context meter uses explicit thresholds and unknown usage never appears as zero", () => {
  for (const [percent, label] of [[79, "Context 79%"], [80, "High context 80%"], [90, "Critical context 90%"], [null, "Context unknown"]] as const) {
    const ctx = { sessionManager: { getSessionName: () => undefined }, getContextUsage: () => ({ tokens: percent, percent, contextWindow: 100 }) } as unknown as ExtensionContext;
    assert.equal(metadataFor(ctx).contextMeter, label);
    assert.equal(metadataFor(ctx).contextPercent, percent === null ? undefined : String(percent));
  }
  assert.equal(elapsed(2000, 1000), "00:00");
});
