import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventBus, SessionManager, type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@code-yeongyu/senpi";
import { compactText, projectLabel, workReference } from "../src/presentation.ts";
import { object } from "../src/tasks.ts";
import { Overview } from "../src/overview.ts";
import { metadataArgs } from "../src/metadata.ts";

async function fixture(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), "omo-compact-"));
  const session = SessionManager.inMemory(cwd);
  const events = createEventBus();
  let tool: Pick<ToolDefinition, "execute" | "parameters"> | undefined;
  const registerTool: ExtensionAPI["registerTool"] = value => { tool = { execute: value.execute, parameters: value.parameters }; };
  const api = { events, registerTool,
    appendEntry: (kind: string, data: unknown) => { session.appendCustomEntry(kind, data); } };
  // Host-owned context follows the existing test fixtures; unused host services are not fabricated.
  const ctx = { cwd, mode: "tui", hasUI: true, sessionManager: session } as unknown as ExtensionContext;
  const overview = new Overview(api, () => {});
  t.after(async () => { overview.stop(); await rm(cwd, { recursive: true, force: true }); });
  overview.start(ctx);
  assert.ok(tool);
  const registered = tool;
  return { overview, session, ctx, tool: registered, set: (params: object) => registered.execute("summary", params, undefined, undefined, ctx),
    counts: (...statuses: string[]) => events.emit("senpi:extension-rpc-event", { name: "omo.task.updated", data: {
      parent_session_id: session.getSessionId(), tasks: statuses.map((status, i) => ({ task_id: `st_${i}`, status })),
    } }) };
}

for (const [input, expected] of [
  ["PR #379", "PR #379"], ["Issue #42", "Issue #42"],
  ["PR owner/repo#379", "PR #379"], ["owner/repo#379", "#379"],
  ["https://github.com/owner/repo/pull/379", "PR #379"],
  ["https://github.com/owner/repo/PULL/379", "PR #379"],
  ["PR owner/repo#42, Issue owner/repo#17", "PR #42 · Issue #17"],
  ["PR owner/service-long-repository-name#42, Issue owner/service-long-repository-name#17", "PR #42 · Issue #17"],
  ["https://github.com/owner/repo/issues/42?x=1#comment", "Issue #42"],
  [`PR owner/${"long-repository-".repeat(7)}#379`, "PR #379"],
] as const) {
  test(`standalone identifier survives explicit reference ${input}`, async t => {
    const f = await fixture(t);
    await f.set({ workItem: input });
    assert.equal(f.overview.metadata(false).workItem, expected);
    const entry = f.session.getBranch().at(-1);
    assert.ok(entry?.type === "custom");
    assert.deepEqual(entry.data, { workItem: input });
  });
}

test("paired references retain both repository identities within one bounded project label", () => {
  const reference = workReference("PR owner/alpha#42, Issue owner/beta#17");
  assert.equal(reference?.identifier, "PR #42 · Issue #17");
  assert.equal(projectLabel(reference, {}), "alpha + beta");
});

test("paired reference tokens preserve complete multi-digit identifiers", async t => {
  const f = await fixture(t);
  for (const [input, numbers] of [
    ["PR #379 · Issue #1234", ["379", "1234"]],
    ["PR owner/repo#12345, Issue owner/repo#67890", ["12345", "67890"]],
    ["PR #1234567, Issue #7654321", ["1234567", "7654321"]],
  ] as const) {
    await f.set({ workItem: input });
    const token = metadataArgs(f.overview.metadata(false), 1, "w1:p1").find(arg => arg.startsWith("omo_work_item="));
    assert.ok(token);
    assert.deepEqual(token.match(/\d+/g), [...numbers]);
    assert.ok(token.slice("omo_work_item=".length).length <= 20);
  }
});

test("reference pairing is bounded to two explicit references, not prose or partial lists", () => {
  for (const input of ["PR #42, check issue later", "PR #42, Issue #17, Issue #18"]) {
    assert.equal(workReference(input)?.identifier, input);
  }
});

test("pairs too large for both numbers explicitly report an omitted reference", async t => {
  const f = await fixture(t);
  for (const [input, expected] of [
    ["PR #12345678901, Issue #98765432109", "PR#12345678901 +1"],
    ["Issue #1234567890123, PR #12345678", "I#1234567890123 +1"],
  ] as const) {
    await f.set({ workItem: input });
    assert.ok(metadataArgs(f.overview.metadata(false), 1, "w1:p1").includes(`omo_work_item=${expected}`));
  }
});

test("multibyte summaries compact cells without truncating persisted source or old input capacity", async t => {
  const f = await fixture(t);
  const task = "界".repeat(80);
  await f.set({ task });
  assert.equal(f.overview.metadata(false).summary, `${"界".repeat(9)}…`);
  const entry = f.session.getBranch().at(-1);
  assert.ok(entry?.type === "custom");
  assert.equal(object(entry.data)?.task, task);
  const properties = object(object(f.tool.parameters)?.properties);
  for (const key of ["task", "result", "workItem"]) assert.equal(object(properties?.[key])?.maxLength, 160);
});

test("emoji and combining graphemes remain intact in compact summaries", async t => {
  const f = await fixture(t);
  await f.set({ task: "👩‍💻".repeat(20) });
  assert.equal(f.overview.metadata(false).summary, `${"👩‍💻".repeat(9)}…`);
  await f.set({ task: "e\u0301".repeat(30) });
  assert.equal(f.overview.metadata(false).summary, `${"e\u0301".repeat(19)}…`);
});

test("active task wins over explicit result until settled; saved result wins on reload", async t => {
  const f = await fixture(t);
  f.overview.begin(1000);
  await f.set({ task: "Review changes", result: "Checks passed", workItem: "PR #379" });
  assert.equal(f.overview.metadata(false).summary, "Review changes");
  f.overview.settle(false, 2000);
  assert.equal(f.overview.metadata(false).summary, "Checks passed");
  f.overview.stop(true);
  f.overview.start(f.ctx);
  assert.equal(f.overview.metadata(false).summary, "Checks passed");
  f.overview.begin(3000);
  assert.equal(f.overview.metadata(false).summary, undefined);
  assert.equal(f.overview.metadata(false).workItem, undefined);
  const entry = f.session.getBranch().at(-1);
  assert.ok(entry?.type === "custom");
  assert.equal(object(entry.data)?.workItem, undefined);
});

test("clearing and session replacement remove explicit work item and summary", async t => {
  const f = await fixture(t);
  await f.set({ workItem: "Issue #42", task: "Fix issue", result: "Fix verified" });
  await f.set({ workItem: "", task: "", result: "" });
  f.overview.stop(true);
  f.overview.start(f.ctx);
  assert.equal(f.overview.metadata(false).workItem, undefined);
  assert.equal(f.overview.metadata(false).summary, undefined);
  await f.set({ workItem: "PR #379", result: "Checks passed" });
  f.session.newSession();
  f.overview.start(f.ctx);
  assert.equal(f.overview.metadata(false).workItem, undefined);
  assert.equal(f.overview.metadata(false).summary, undefined);
});

test("human attention precedes failure and settled result without duplicating failure counts", async t => {
  const f = await fixture(t);
  await f.set({ task: "Review changes", result: "Checks passed" });
  f.counts("error", "running");
  assert.equal(f.overview.metadata(true).summary, "Needs your input");
  assert.equal(f.overview.metadata(false).summary, "1 failed task");
  f.counts("completed", "cancelled");
  assert.equal(f.overview.metadata(false).summary, "Checks passed");
});

test("only active and queued counts appear in summary fallback and completion infers no result", async t => {
  const f = await fixture(t);
  f.overview.begin(1000);
  f.counts("running", "pending", "completed", "cancelled");
  assert.equal(f.overview.metadata(false).summary, "1 active · 1 queued");
  f.counts("completed", "cancelled");
  f.overview.settle(false, 2000);
  assert.equal(f.overview.metadata(false).summary, undefined);
  assert.equal(f.overview.metadata(false).result, undefined);
  assert.equal(f.overview.metadata(false).tasks, "1 completed · 1 cancelled");
});

test("compact elapsed excludes Waiting while legacy elapsed remains available", async t => {
  const f = await fixture(t);
  f.overview.begin(1000);
  f.overview.metadata(true, 2000);
  assert.equal(f.overview.metadata(true, 6000).elapsedCompact, "00:04");
  assert.equal(f.overview.metadata(true, 6000).elapsed, "Waiting 00:04");
});

test("project identity shows an explicit foreign repo once without unnecessary organization", async t => {
  const f = await fixture(t);
  await f.set({ workItem: "PR owner/repo#379" });
  assert.match(f.overview.metadata(false).project ?? "", /^repo/);
  assert.ok(!f.overview.metadata(false).project?.includes("owner"));
});

test("linked worktrees retain repository identity", async t => {
  const f = await fixture(t);
  const git = (...args: string[]) => execFileSync("git", ["-C", f.ctx.cwd, ...args], { stdio: "pipe" });
  git("init", "-b", "main");
  git("-c", "user.name=QA", "-c", "user.email=qa@example.invalid", "commit", "--allow-empty", "-m", "fixture");
  git("remote", "add", "origin", "https://github.com/local/repo.git");
  git("worktree", "add", "-b", "feature", join(f.ctx.cwd, "linked"));
  const { gitContext } = await import("../src/git.ts");
  const info = await gitContext(join(f.ctx.cwd, "linked"));
  assert.equal(info.project, "repo/linked");
  assert.equal(info.repository, "local/repo");
});

test("project truncation retains name prefix and distinguishing worktree suffix", () => {
  const identity = { repository: "owner/service", project: "service-long-common-prefix/feature-one" };
  const first = projectLabel(undefined, identity);
  const second = projectLabel(undefined, { ...identity, project: "service-long-common-prefix/feature-two" });
  assert.match(first ?? "", /^service.*….*-one$/);
  assert.match(second ?? "", /^service.*….*-two$/);
  assert.ok((first?.length ?? 0) <= 20);
  assert.ok((second?.length ?? 0) <= 20);
  assert.notEqual(first, second);
  assert.ok(metadataArgs({ project: first }, 1, "w1:p1").includes(`omo_project=${first}`));
});

test("project disambiguates foreign owner only on same repository-name collision", () => {
  const identity = { repository: "local/repo", project: "repo" };
  assert.equal(projectLabel(workReference("PR local/repo#1"), identity), "repo");
  assert.equal(projectLabel(workReference("PR other/repo#1"), identity), "oth…repo @ loca…repo");
  assert.equal(projectLabel(workReference("PR other/new#1"), identity), "new @ repo");
});

test("compact display fits twenty cells without shortening a fitting label", () => {
  assert.equal(compactText("a".repeat(20)), "a".repeat(20));
  assert.equal(compactText("a".repeat(21)), `${"a".repeat(19)}…`);
});

test("terminal controls are stripped and compact serialization retains graphemes", () => {
  assert.equal(compactText("\x1b[31mHello\x1b[0m\nworld\u202e"), "Hello world");
  const value = compactText("👩‍💻".repeat(20));
  assert.ok(metadataArgs({ summary: value }, 1, "w1:p1").includes(`omo_summary=${value}`));
  assert.equal(workReference("https://example.com/owner/repo/pull/42")?.identifier, "https://example.com/owner/repo/pull/42");
});

test("tool activity is fallback only and never overwrites explicit labels or attention", async t => {
  const f = await fixture(t);
  f.overview.begin(1000);
  assert.equal(f.overview.metadata(false, 2000, "Running bash").summary, "Running bash");
  await f.set({ task: "Review changes", result: "Checks passed" });
  assert.equal(f.overview.metadata(false, 2000, "Running bash").summary, "Review changes");
  assert.equal(f.overview.metadata(true, 2000, "Running bash").summary, "Needs your input");
});

test("saved result is not shown over fresh tool activity before a new agent start", async t => {
  const f = await fixture(t);
  await f.set({ result: "Checks passed" });
  f.overview.stop(true);
  f.overview.start(f.ctx);
  assert.equal(f.overview.metadata(false, 1000, "Compacting context").summary, "Compacting context");
});

test("metadata publishes and clears compact tokens without changing native state text", () => {
  const args = metadataArgs({ workItem: "PR #379", project: "repo", summary: "Review changes", elapsedCompact: "00:01", activity: "Running bash" }, 1, "w1:p1");
  for (const value of ["omo_work_item=PR #379", "omo_project=repo", "omo_summary=Review changes", "omo_elapsed_compact=00:01", "omo_activity=Running bash"]) assert.ok(args.includes(value));
  assert.ok(args.includes("--clear-state-labels"));
  assert.ok(!args.includes("--state-label"));
  const clear = metadataArgs(undefined, 2, "w1:p1");
  for (const token of ["omo_work_item", "omo_project", "omo_summary", "omo_elapsed_compact"]) assert.ok(clear.includes(token));
});
