/** Download a pinned official Herdr release into an explicitly supplied test path. */
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const checksums: Record<string, string> = {
  "linux-x64": "4fa1a01158dd8043da92d31b270780b0dcc10603038d9b61cac4d81ab63fb71f",
  "linux-arm64": "9c8db20fb7e7427b138d5367113f1621ffd319f2f65d6f009e2594029115f0d2",
  "darwin-arm64": "32b53df09872628059c789a69f02a6b8e29e14ddf26711421f3463f70c1aef17",
  "darwin-x64": "d0c920b2a126a74809fa1491411c9a097a44786cac9c2ca51b818a995581cf16",
};
const checksum = checksums[`${process.platform}-${process.arch}`];
const destination = process.argv[2];
if (!checksum || !destination) throw new Error("Usage: node scripts/download-herdr.ts <new-test-binary-path> (Linux/macOS)");
const asset = `herdr-${process.platform === "darwin" ? "macos" : "linux"}-${process.arch === "arm64" ? "aarch64" : "x86_64"}`;
const response = await fetch(`https://github.com/herdrdev/herdr/releases/download/v0.9.0/${asset}`, { signal: AbortSignal.timeout(60_000) });
if (!response.ok) throw new Error(`Herdr download failed: HTTP ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
if (createHash("sha256").update(bytes).digest("hex") !== checksum) throw new Error("Herdr checksum mismatch");
await writeFile(resolve(destination), bytes, { mode: 0o755, flag: "wx" });
console.log(`Verified official Herdr 0.9.0: ${resolve(destination)}`);
