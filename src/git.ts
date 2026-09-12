import { execFile } from "node:child_process";
import { basename } from "node:path";
import { displayText } from "./metadata.ts";

function git(cwd: string, args: string[]): Promise<string | undefined> {
  return new Promise(resolve => {
    execFile("git", ["-C", cwd, ...args], {
      timeout: 750, killSignal: "SIGKILL", maxBuffer: 16 * 1024, windowsHide: true, shell: false,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    }, (error, stdout) => resolve(error ? undefined : stdout.trim()));
  });
}
/** Read branch/worktree without traversing files, contacting remotes or changing Git state. */
export async function gitContext(cwd: string): Promise<{ branch?: string; worktree?: string }> {
  const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root) return {};
  let branch = await git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (!branch) {
    const commit = await git(cwd, ["rev-parse", "--short", "HEAD"]);
    if (commit) branch = `detached ${commit}`;
  }
  return { branch: displayText(branch), worktree: displayText(basename(root)) };
}
