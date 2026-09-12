import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeAgents } from "../web/src/agent-summary.js";

test("working main agent is counted after its only child completes", () => {
  const summary = summarizeAgents({ state: "running" }, [{ state: "completed" }]);
  assert.equal(summary.total, 2);
  assert.equal(summary.counts.running, 1);
  assert.equal(summary.counts.completed, 1);
  assert.deepEqual(summary.items.map(({ label, count }) => [label, count]), [["Working", 1], ["Done", 1]]);
});

test("all agent states are accounted for without merging blocked, waiting or paused", () => {
  const states = ["running", "pending", "blocked", "paused", "failed", "cancelled", "completed", "idle", "unknown", "future"];
  const summary = summarizeAgents({ state: "blocked" }, states.map((state) => ({ state })));
  assert.equal(summary.total, 11);
  assert.equal(summary.counts.blocked, 2);
  assert.equal(summary.counts.pending, 1);
  assert.equal(summary.counts.paused, 1);
  assert.equal(summary.counts.unknown, 2);
  assert.equal(Object.values(summary.counts).reduce((total, count) => total + count, 0), summary.total);
});

test("main agent remains visible in counts when no tasks are reported", () => {
  const summary = summarizeAgents({ state: "idle" }, []);
  assert.equal(summary.total, 1);
  assert.deepEqual(summary.items, [{ state: "idle", count: 1, label: "Ready" }]);
  assert.equal(summarizeAgents(undefined, []).total, 0);
});
