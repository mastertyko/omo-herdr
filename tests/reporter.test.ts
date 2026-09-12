import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Reporter } from "../src/reporter.ts";

async function eventually(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await delay(5);
  }
  assert.fail("Timed out waiting for reporter");
}

function field(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

test("coalesces pending states, retains session identity and releases after the final in-flight report", async () => {
  const captured: string[][] = [];
  let complete!: (success: boolean) => void;
  const reporter = new Reporter("w1:p1", (args) => {
    captured.push([...args]);
    return captured.length === 1 ? new Promise((resolve) => { complete = resolve; }) : Promise.resolve(true);
  });
  reporter.report({ state: "working", sessionId: "session-1" });
  reporter.report({ state: "blocked" });
  reporter.report({ state: "idle", sessionId: "session-2", sessionPath: "/sessions/two.jsonl" });
  complete(true);
  await eventually(() => captured.length === 2);
  await reporter.close();
  assert.deepEqual(captured.map((args) => field(args, "--state")), ["working", "idle", undefined]);
  assert.equal(field(captured[1]!, "--agent-session-id"), "session-2");
  assert.equal(field(captured[1]!, "--agent-session-path"), "/sessions/two.jsonl");
  assert.equal(captured[2]![1], "release-agent");
  const sequences = captured.map((args) => Number(field(args, "--seq")));
  assert.ok(sequences.every((seq, index) => index === 0 || seq > sequences[index - 1]!));
  reporter.report({ state: "working" });
  await reporter.close();
  assert.equal(captured.length, 3);
});

test("shutdown drops pending states and waits for an in-flight report before release", async () => {
  const calls: string[][] = [];
  let complete!: (success: boolean) => void;
  const reporter = new Reporter("w1:p1", async (args) => {
    calls.push([...args]);
    if (calls.length === 1) return new Promise((resolve) => { complete = resolve; });
    return true;
  });
  reporter.report({ state: "working" });
  reporter.report({ state: "idle" });
  const closed = reporter.close();
  assert.equal(calls.length, 1);
  complete(false);
  await closed;
  assert.deepEqual(calls.map((args) => args[1]), ["report-agent", "release-agent"]);
});

test("retries an undelivered state without needing another agent event", async () => {
  const calls: string[][] = [];
  const reporter = new Reporter("w1:p1", async (args) => {
    calls.push([...args]);
    return calls.length > 1;
  }, 10);
  try {
    reporter.report({ state: "blocked", message: "Waiting" });
    await eventually(() => calls.length === 2);
    assert.equal(field(calls[1]!, "--state"), "blocked");
    reporter.report({ state: "blocked", message: "Waiting" });
    await delay(20);
    assert.equal(calls.length, 2, "delivered state should be deduplicated");
  } finally { await reporter.close(); }
});

test("a new state replaces a failed report and transport exceptions do not escape", async () => {
  const calls: string[][] = [];
  const reporter = new Reporter("w1:p1", async (args) => {
    calls.push([...args]);
    if (calls.length === 1) throw new Error("Herdr unavailable");
    return true;
  }, 50);
  reporter.report({ state: "working" });
  await delay(5);
  reporter.report({ state: "idle" });
  await eventually(() => calls.length === 2);
  assert.equal(field(calls[1]!, "--state"), "idle");
  await reporter.close();
});

test("failed release has a bounded retry and shutdown is idempotent", async () => {
  let calls = 0;
  const reporter = new Reporter("w1:p1", async () => { calls++; return false; }, 5);
  await Promise.all([reporter.close(), reporter.close()]);
  await delay(20);
  assert.equal(calls, 2);
});

test("metadata failures retry without repeating lifecycle; newer state still takes priority", async () => {
  const calls: string[][] = [];
  let failMetadata = true;
  const reporter = new Reporter("w1:p1", async args => {
    calls.push([...args]);
    return args[1] !== "report-metadata" || !failMetadata;
  }, 10);
  try {
    reporter.report({ state: "working", metadata: { model: "first" } });
    await eventually(() => calls.filter(args => args[1] === "report-metadata").length >= 2);
    assert.equal(calls.filter(args => args[1] === "report-agent").length, 1);
    assert.equal(reporter.diagnostics().state.succeeded, true);
    assert.equal(reporter.diagnostics().metadata.succeeded, false);
    failMetadata = false;
    reporter.report({ state: "blocked", metadata: { model: "second" } });
    await eventually(() => reporter.diagnostics().metadata.succeeded === true);
    const states = calls.filter(args => args[1] === "report-agent");
    assert.deepEqual(states.map(args => field(args, "--state")), ["working", "blocked"]);
    assert.equal(field(calls.at(-1)!, "--token"), "omo_model=second");
  } finally { await reporter.close(); }
  assert.equal(calls.at(-1)![1], "release-agent");
  assert.ok(calls.at(-2)!.includes("--clear-title"));
});

test("metadata refreshes before TTL without repeating state and stops after shutdown", async () => {
  const calls: string[][] = [];
  const reporter = new Reporter("w1:p1", async args => { calls.push([...args]); return true; }, 10, 25);
  reporter.report({ state: "idle", metadata: { title: "test" } });
  await eventually(() => calls.filter(args => args.includes("--title")).length >= 2);
  assert.equal(calls.filter(args => args[1] === "report-agent").length, 1);
  await reporter.close();
  const count = calls.length;
  await delay(80);
  assert.equal(calls.length, count);
  assert.equal(calls.at(-1)![1], "release-agent");
});

test("shutdown waits for metadata in flight then clears it before releasing the source", async () => {
  const calls: string[][] = [];
  let finish!: (ok: boolean) => void;
  const reporter = new Reporter("w1:p1", async args => {
    calls.push([...args]);
    if (args.includes("--title")) return new Promise<boolean>(resolve => { finish = resolve; });
    return true;
  });
  reporter.report({ state: "idle", metadata: { title: "in flight" } });
  await eventually(() => !!finish);
  const closing = reporter.close();
  assert.equal(calls.length, 2);
  finish(true);
  await closing;
  assert.deepEqual(calls.map(args => args[1]), ["report-agent", "report-metadata", "report-metadata", "release-agent"]);
});
