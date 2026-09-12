import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI, ExtensionContext } from "@code-yeongyu/senpi";
import omoHerdr from "../src/index.ts";

type Handler = (event: any, context: ExtensionContext) => unknown;

test("extension reports lifecycle, ignores agent_end, isolates non-TUI sessions and survives reload", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omo-herdr-test-"));
  const log = join(directory, "calls.jsonl");
  const bin = new URL("./fixtures/herdr-cli.mjs", import.meta.url).pathname;
  await chmod(bin, 0o755);
  const original = { ...process.env };
  Object.assign(process.env, {
    HERDR_ENV: "1", HERDR_BIN_PATH: bin, HERDR_SOCKET_PATH: join(directory, "socket"),
    HERDR_PANE_ID: "w1:p1", OMO_HERDR_TEST_LOG: log,
  });
  delete process.env.OMO_HERDR_OWNER_PID;
  let handlers = new Map<string, Handler>();
  function load() {
    handlers = new Map();
    omoHerdr({ on: (name: string, handler: Handler) => handlers.set(name, handler) } as unknown as ExtensionAPI);
  }
  let sessionId = "first";
  const ctx = {
    mode: "tui", hasUI: true, isIdle: () => true, hasPendingMessages: () => false,
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => `/tmp/${sessionId}.jsonl` },
  } as unknown as ExtensionContext;
  const emit = async (name: string, event: object = {}, context = ctx) => { await handlers.get(name)?.(event, context); };
  async function calls(): Promise<string[][]> {
    try { return (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
  async function count(expected: number) {
    for (let i = 0; i < 200; i++) {
      if ((await calls()).length >= expected) { await delay(20); return; }
      await delay(10);
    }
    assert.fail(`Expected ${expected} calls; got ${JSON.stringify(await calls())}`);
  }
  try {
    load();
    await emit("session_start", {}, { ...ctx, mode: "rpc" });
    await emit("agent_start");
    await delay(20);
    assert.equal((await calls()).length, 0);
    await emit("session_start");
    await count(1);
    await emit("agent_start");
    await count(2);
    assert.equal(handlers.has("agent_end"), false);
    await emit("agent_end");
    await delay(20);
    assert.equal((await calls()).length, 2);
    await emit("ui_prompt_start", { kind: "confirm", title: "secret must not leak" });
    await count(3);
    await emit("ui_prompt_start", { kind: "input", title: "nested" });
    await emit("ui_prompt_end", { kind: "confirm", title: "secret must not leak" });
    await delay(20);
    assert.equal((await calls()).length, 3, "nested prompt must remain blocked");
    await emit("ui_prompt_end", { kind: "input", title: "nested" });
    await count(4);
    await emit("agent_settled");
    await count(5);
    await emit("session_shutdown");
    await count(6);
    load();
    sessionId = "second";
    await emit("session_start", { reason: "resume" }, { ...ctx, isIdle: () => false });
    await count(7);
    await emit("session_abort");
    await count(8);
    await emit("session_shutdown");
    const captured = await calls();
    const states = captured.map((args) => args.includes("--state") ? args[args.indexOf("--state") + 1] : "release");
    assert.deepEqual(states, ["idle", "working", "blocked", "working", "idle", "release", "working", "idle", "release"]);
    assert.ok(!JSON.stringify(captured).includes("secret must not leak"));
    assert.ok(captured[6]!.includes("second"));
    const seqs = captured.map((args) => Number(args[args.indexOf("--seq") + 1]));
    assert.ok(seqs.every((seq, index) => !index || seq > seqs[index - 1]!));
  } finally {
    await emit("session_shutdown");
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    await rm(directory, { recursive: true, force: true });
  }
});
