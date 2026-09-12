import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@code-yeongyu/senpi";
import omoHerdr from "../src/index.ts";

test("only native sidebar metadata subscribes to shared agent events", () => {
  const original = { ...process.env };
  Object.assign(process.env, {
    HERDR_ENV: "1", HERDR_BIN_PATH: "/unused/herdr",
    HERDR_SOCKET_PATH: "/unused/herdr.sock", HERDR_PANE_ID: "w1:p1",
  });
  try {
    for (const enabled of [false, true]) {
      process.env.OMO_HERDR_METADATA = enabled ? "1" : "0";
      const subscriptions: string[] = [];
      const tools: string[] = [];
      const commands: string[] = [];
      const hooks: string[] = [];
      const api = {
        events: { on: (name: string) => { subscriptions.push(name); return () => {}; } },
        registerTool: (tool: { name: string }) => { tools.push(tool.name); },
        registerCommand: (name: string) => { commands.push(name); },
        on: (name: string) => { hooks.push(name); },
      } as unknown as ExtensionAPI;

      omoHerdr(api);

      assert.deepEqual(subscriptions, enabled ? ["senpi:extension-rpc-event"] : []);
      assert.deepEqual(tools, enabled ? ["herdr_summary"] : []);
      assert.deepEqual(commands, ["herdr"]);
      assert.ok(hooks.includes("session_start"));
      assert.ok(hooks.includes("agent_settled"));
      assert.ok(hooks.includes("session_shutdown"));
    }
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
  }
});
