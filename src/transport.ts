import { execFile } from "node:child_process";
import type { HerdrEnvironment } from "./environment.ts";

export interface CliResult {
  ok: boolean;
  stdout: string;
  failure?: "timeout" | "not-found" | "exit";
}

export function runCli(environment: HerdrEnvironment, args: readonly string[], timeoutMs = 750): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(environment.bin, [...args], {
      env: { ...process.env, HERDR_SOCKET_PATH: environment.socket },
      timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 64 * 1024,
      windowsHide: true, shell: false,
    }, (error, stdout) => resolve({
      ok: !error, stdout: error ? "" : stdout,
      failure: !error ? undefined : error.killed ? "timeout" : error.code === "ENOENT" ? "not-found" : "exit",
    }));
  });
}

export type Transport = (args: readonly string[]) => Promise<boolean>;
export function cliTransport(environment: HerdrEnvironment, timeoutMs = 750): Transport {
  return async (args) => (await runCli(environment, args, timeoutMs)).ok;
}
