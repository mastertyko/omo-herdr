import { isAbsolute } from "node:path";

export interface HerdrEnvironment {
  bin: string;
  pane: string;
  socket: string;
}

export const OWNER_ENV = "OMO_HERDR_OWNER_PID";

export function readEnvironment(env: NodeJS.ProcessEnv): HerdrEnvironment | undefined {
  const bin = env.HERDR_BIN_PATH;
  const pane = env.HERDR_PANE_ID;
  const socket = env.HERDR_SOCKET_PATH;
  if (env.HERDR_ENV !== "1" || !bin || !isAbsolute(bin) || !pane?.trim() || !socket?.trim()) {
    return undefined;
  }
  return { bin, pane, socket };
}

// Process-global across extension reloads; child processes inherit only OWNER_ENV.
const processKey = Symbol.for("omo-herdr.process-state.v1");
interface ProcessState { seq: number; owner?: object }
const globals = globalThis as typeof globalThis & { [processKey]?: ProcessState };
const state = globals[processKey] ??= { seq: 0 };

export function nextSequence(): number {
  state.seq = Math.max(state.seq + 1, Date.now() * 1000);
  return state.seq;
}

export function claimPane(env: NodeJS.ProcessEnv = process.env): (() => void) | undefined {
  const pid = String(process.pid);
  if ((env[OWNER_ENV] && env[OWNER_ENV] !== pid) || state.owner) return undefined;
  const owner = {};
  state.owner = owner;
  env[OWNER_ENV] = pid;
  return () => {
    if (state.owner === owner) state.owner = undefined;
    // Keep the inherited marker: nested processes must stay excluded after reload/quit.
  };
}
