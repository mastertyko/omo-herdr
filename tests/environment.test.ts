import assert from "node:assert/strict";
import { test } from "node:test";
import { claimPane, nextSequence, OWNER_ENV, readEnvironment } from "../src/environment.ts";

test("no-op outside Herdr or with incomplete environment; never falls back to PATH", () => {
  const env = { HERDR_ENV: "1", HERDR_BIN_PATH: "/bin/herdr", HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: "/tmp/herdr.sock" };
  assert.deepEqual(readEnvironment(env), { bin: "/bin/herdr", pane: "w1:p1", socket: "/tmp/herdr.sock" });
  for (const key of Object.keys(env)) assert.equal(readEnvironment({ ...env, [key]: "" }), undefined);
  assert.equal(readEnvironment({ ...env, HERDR_BIN_PATH: "herdr" }), undefined);
  assert.equal(readEnvironment({ ...env, HERDR_ENV: "0" }), undefined);
});

test("only one root owns the pane; reload can reclaim it while children remain excluded", () => {
  const env: NodeJS.ProcessEnv = {};
  const release = claimPane(env);
  assert.ok(release);
  assert.equal(env[OWNER_ENV], String(process.pid));
  assert.equal(claimPane(env), undefined);
  release();
  assert.equal(claimPane({ [OWNER_ENV]: "other-process" }), undefined);
  const releaseReload = claimPane(env);
  assert.ok(releaseReload);
  release();
  assert.equal(claimPane(env), undefined, "old cleanup must not release a new owner");
  releaseReload();
});

test("sequence survives clock rollback and stays within JSON's safe integer range", (t) => {
  t.mock.method(Date, "now", () => 2_000_000_000_000);
  const first = nextSequence();
  t.mock.method(Date, "now", () => 1_000_000_000_000);
  const second = nextSequence();
  assert.ok(second > first);
  assert.ok(Number.isSafeInteger(second));
});
