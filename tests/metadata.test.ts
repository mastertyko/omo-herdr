import assert from "node:assert/strict";
import { test } from "node:test";
import { contextLabel, displayText, metadataArgs, METADATA_TOKENS } from "../src/metadata.ts";

test("metadata text is terminal-safe and byte-bounded; unknown context is not shown as zero", () => {
  assert.equal(displayText("\x1b[31mHello\x1b[0m\nworld\u202e"), "Hello world");
  assert.ok(Buffer.byteLength(displayText("🦉".repeat(200))!) <= 160);
  assert.equal(contextLabel({ tokens: null, percent: null, contextWindow: 1000 }), "unknown");
  assert.equal(contextLabel({ tokens: 420, percent: 42, contextWindow: 1000 }), "42% (420/1000)");
  assert.equal(contextLabel({ tokens: NaN, percent: 0, contextWindow: 1000 }), undefined);
  assert.equal(contextLabel({ tokens: 100, percent: 0, contextWindow: 0 }), undefined);
});

test("metadata replaces only owned fields and clears missing/expired information", () => {
  const args = metadataArgs({ title: "Task", model: "provider/model", activity: "Running bash" }, 10, "w1:p1");
  assert.ok(args.includes("custom:omo:metadata"));
  assert.ok(args.includes("working=Running bash"));
  assert.ok(!args.includes("--clear-state-labels"), "Herdr rejects setting and clearing the same field");
  assert.ok(!args.includes("--clear-title"));
  assert.ok(args.includes("omo_model=provider/model"));
  assert.equal(args[args.indexOf("--applies-to-source") + 1], "custom:omo");
  const clear = metadataArgs(undefined, 11, "w1:p1");
  for (const token of METADATA_TOKENS) assert.ok(clear.includes(token));
  assert.ok(clear.includes("--clear-title"));
  assert.ok(clear.includes("--clear-state-labels"));
  assert.ok(!clear.includes("--clear-display-agent"), "do not clear other integrations' display labels");
});
