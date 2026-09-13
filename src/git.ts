import { execFile } from "node:child_process";
import { basename, dirname } from "node:path";
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
export async function gitContext(cwd: string): Promise<{ branch?: string; worktree?: string; repository?: string; project?: string }> {
  const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root) return {};
  let branch = await git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (!branch) {
    const commit = await git(cwd, ["rev-parse", "--short", "HEAD"]);
    if (commit) branch = `detached ${commit}`;
  }
  const [common, remote] = await Promise.all([
    git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    git(cwd, ["remote", "get-url", "origin"]),
  ]);
  const main = common ? dirname(common) : root;
  const github = remote?.match(/^(?:https?:\/\/github\.com\/|(?:ssh:\/\/)?git@github\.com[:/])([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i)?.[1];
  const repository = github ?? basename(main);
  const name = repository.split("/").at(-1) ?? basename(main);
  return { branch: displayText(branch), worktree: displayText(basename(root)), repository,
    project: root === main ? name : `${name}/${basename(root)}` };
}
