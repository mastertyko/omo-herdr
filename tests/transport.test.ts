import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cliTransport } from "../src/reporter.ts";

test("transport preserves literal arguments, pins the socket, and returns failure on nonzero exit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omo-herdr-transport-"));
  try {
    const output = join(directory, "received.json");
    const bin = join(directory, "herdr with spaces");
    await writeFile(bin, `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(output)}, JSON.stringify({ args: process.argv.slice(2), socket: process.env.HERDR_SOCKET_PATH }));\nprocess.exit(process.argv.includes('--fail') ? 1 : 0);\n`);
    await chmod(bin, 0o755);
    const send = cliTransport({ bin, pane: "w1:p1", socket: "/socket with spaces" });
    const args = ["pane", "report-agent", "w1:p1", "--message", "$(touch NEVER); `nope` 'quoted'\nline 2"];
    assert.equal(await send(args), true);
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), { args, socket: "/socket with spaces" });
    assert.equal(await send(["--fail"]), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("missing and hung CLI processes are bounded failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omo-herdr-timeout-"));
  try {
    assert.equal(await cliTransport({ bin: join(directory, "missing"), pane: "w1:p1", socket: "/socket" })([]), false);
    const bin = join(directory, "hang");
    await writeFile(bin, "#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n");
    await chmod(bin, 0o755);
    const started = Date.now();
    assert.equal(await cliTransport({ bin, pane: "w1:p1", socket: "/socket" }, 100)([]), false);
    assert.ok(Date.now() - started < 2000);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
