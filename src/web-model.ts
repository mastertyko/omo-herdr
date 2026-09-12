import { displayText } from "./metadata.ts";
import { object } from "./tasks.ts";
import { ResearchProjection, type ResearchOwnership, type ResearchSnapshot } from "./research.ts";

export type State =
  | "running"
  | "pending"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled"
  | "paused"
  | "unknown"
  | "idle";
export interface AgentTask {
  id: string;
  parentSessionId: string;
  childSessionId?: string;
  parentTaskId?: string;
  label: string;
  agent: string;
  state: State;
  model?: string;
  activity?: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt?: string;
}
export interface GraphNode {
  id: string;
  label: string;
  state: State;
  taskId?: string;
  startedAt?: string;
  completedAt?: string;
}
export interface GraphRun {
  id: string;
  name: string;
  state: State;
  nodes: GraphNode[];
  edges: { from: string; to: string }[];
}
export interface Activity {
  id: number;
  taskId?: string;
  label: string;
  // Local receipt time; source record timestamps are separate and may be older.
  at: string;
  kind?: "observed" | "state" | "tool";
  action?: string;
  taskLabel?: string;
  agent?: string;
  state?: State;
  previousState?: State;
  // The tool involved in this event, including one that stopped being reported.
  tool?: string;
  sourceAt?: string;
}
export interface WebSnapshot {
  schemaVersion: 1;
  session: {
    id: string;
    title: string;
    project: string;
    state: State;
    model?: string;
    activity?: string;
  };
  tasks: AgentTask[];
  runs: GraphRun[];
  activity: Activity[];
  research: ResearchSnapshot;
  omitted: number;
  updatedAt?: string;
}
const known = new Set<State>([
  "running",
  "pending",
  "blocked",
  "completed",
  "failed",
  "cancelled",
  "paused",
  "idle",
]);
export function stateOf(value: unknown): State {
  if (typeof value !== "string") return "unknown";
  if (["error", "interrupted", "lost"].includes(value)) return "failed";
  if (value === "scheduled") return "pending";
  if (value === "skipped") return "cancelled";
  return known.has(value as State) ? (value as State) : "unknown";
}
const id = (v: unknown): string | undefined =>
  typeof v === "string" && /^[A-Za-z0-9_.:-]{1,256}$/.test(v) ? v : undefined;
const text = (v: unknown, max = 160) =>
  typeof v === "string" ? displayText(v, max) : undefined;
// OmO emits an explicit name and task_summary, but may use task_id as the name.
// Do not derive labels from descriptions, prompts, outputs, or transcripts.
const taskLabel = (v: unknown): string | undefined => {
  const label = text(v);
  if (!label || /^st_[A-Za-z0-9_.:-]+(?:…)?$/.test(label)) return undefined;
  return label;
};
const roleTaskLabel = (agent: string): string =>
  `${agent.charAt(0).toUpperCase()}${agent.slice(1)} task`;
// OmO's current_tool is a display string: tool name followed by an argument preview.
// Only retain the leading tool identifier; the preview may contain private input.
const toolName = (v: unknown): string | undefined =>
  typeof v === "string"
    ? v.match(/^([A-Za-z_][A-Za-z0-9_.:-]{0,79})(?=\s|$)/)?.[1]
    : undefined;
const date = (v: unknown) =>
  (typeof v === "string" || typeof v === "number") &&
  Number.isFinite(new Date(v).getTime())
    ? new Date(v).toISOString()
    : undefined;
const count = (v: unknown) =>
  Number.isSafeInteger(v) && Number(v) > 0 ? Math.min(Number(v), 1_000_000) : 0;
export interface TaskBatch {
  sessionId: string;
  tasks: AgentTask[];
  omitted: number;
}
export function parseTasks(value: unknown): TaskBatch | undefined {
  const p = object(value);
  const sessionId = id(p?.parent_session_id);
  if (!p || !sessionId || !Array.isArray(p.tasks)) return;
  const tasks: AgentTask[] = [];
  const seen = new Set<string>();
  for (const raw of p.tasks.slice(0, 256)) {
    const t = object(raw);
    const taskId = id(t?.task_id);
    if (
      !t ||
      !taskId?.startsWith("st_") ||
      seen.has(taskId) ||
      (t.parent_session_id !== undefined && t.parent_session_id !== sessionId)
    )
      continue;
    seen.add(taskId);
    const live = object(t.live_progress);
    const state = stateOf(t.status);
    const agent = text(t.agent_type, 64) ?? text(t.category, 64) ?? "Agent";
    // Explicit allowlist: never forward prompts, assistant text, final responses or tool arguments.
    tasks.push({
      id: taskId,
      parentSessionId: sessionId,
      childSessionId: id(t.child_session_id),
      label: taskLabel(t.name) ?? taskLabel(t.task_summary) ?? roleTaskLabel(agent),
      agent,
      state,
      model: text(t.model),
      activity: state === "running" ? toolName(live?.current_tool) : undefined,
      startedAt: date(live?.started_at) ?? date(t.created_at),
      completedAt: ["completed", "failed", "cancelled"].includes(state)
        ? (date(t.terminal_at) ?? date(t.updated_at))
        : undefined,
      updatedAt: date(t.updated_at),
    });
  }
  return {
    sessionId,
    tasks,
    omitted: count(p.truncated_tasks) + Math.max(0, p.tasks.length - 256),
  };
}
export function parseRuns(
  value: unknown,
): { sessionId: string; runs: GraphRun[]; omitted: number } | undefined {
  const p = object(value);
  const sessionId = id(p?.parent_session_id);
  if (!p || !sessionId || !Array.isArray(p.runs)) return;
  const runs: GraphRun[] = [];
  const runIds = new Set<string>();
  for (const raw of p.runs.slice(0, 32)) {
    const r = object(raw);
    const runId = id(r?.run_id);
    if (
      !r ||
      !runId ||
      runIds.has(runId) ||
      (r.parent_session_id !== undefined &&
        r.parent_session_id !== sessionId) ||
      !Array.isArray(r.nodes) ||
      !Array.isArray(r.edges) ||
      r.nodes.length > 256 ||
      r.edges.length > 2048
    )
      continue;
    const nodes: GraphNode[] = [];
    const seen = new Set<string>();
    for (const rawNode of r.nodes) {
      const n = object(rawNode);
      const nodeId = id(n?.id);
      if (!n || !nodeId || seen.has(nodeId)) continue;
      seen.add(nodeId);
      nodes.push({
        id: nodeId,
        label: text(n.label) ?? nodeId,
        state: stateOf(n.state),
        taskId: id(n.task_id),
        startedAt: date(n.started_at),
        completedAt: date(n.completed_at),
      });
    }
    const edges: GraphRun["edges"] = [];
    const edgeIds = new Set<string>();
    for (const rawEdge of r.edges) {
      const e = object(rawEdge);
      const from = id(e?.from),
        to = id(e?.to);
      if (!from || !to || from === to || !seen.has(from) || !seen.has(to))
        continue;
      const key = JSON.stringify([from, to]);
      if (edgeIds.has(key)) continue;
      edgeIds.add(key);
      edges.push({ from, to });
    }
    // Invalid cycles are omitted rather than passed to the layout engine.
    const indegree = new Map(nodes.map((node) => [node.id, 0]));
    const outgoing = new Map(nodes.map((node) => [node.id, [] as string[]]));
    for (const edge of edges) {
      indegree.set(edge.to, indegree.get(edge.to)! + 1);
      outgoing.get(edge.from)!.push(edge.to);
    }
    const roots = nodes
      .filter((node) => indegree.get(node.id) === 0)
      .map((node) => node.id);
    let visited = 0;
    for (let cursor = 0; cursor < roots.length; cursor++) {
      visited++;
      for (const to of outgoing.get(roots[cursor]!)!) {
        const degree = indegree.get(to)! - 1;
        indegree.set(to, degree);
        if (degree === 0) roots.push(to);
      }
    }
    if (visited !== nodes.length) continue;
    runIds.add(runId);
    runs.push({
      id: runId,
      name: text(r.name) ?? text(r.run_key) ?? "Workflow",
      state: stateOf(r.status),
      nodes,
      edges,
    });
  }
  return {
    sessionId,
    runs,
    omitted: count(p.truncated_runs) + Math.max(0, p.runs.length - runs.length),
  };
}

const stateActions: Record<State, string> = {
  running: "Started working",
  pending: "Queued",
  blocked: "Blocked",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  paused: "Paused",
  unknown: "Status became unknown",
  idle: "Became idle",
};

function activityChange(task: AgentTask, old: AgentTask | undefined): Omit<Activity, "id" | "at"> | undefined {
  if (old && old.state === task.state && old.activity === task.activity) return;
  const kind = !old ? "observed" : old.state !== task.state ? "state" : "tool";
  // Progress snapshots are coalesced upstream. An observed tool change is not proof
  // of tool completion or success, and the first snapshot is not a start event.
  const action = kind === "observed"
    ? `Observed ${task.state}${task.activity ? ` · Reporting ${task.activity}` : ""}`
    : kind === "state"
      ? stateActions[task.state]
      : task.activity ? `Started reporting ${task.activity}` : `Stopped reporting ${old!.activity}`;
  return {
    taskId: task.id,
    label: `${task.agent} · ${task.label}`,
    kind,
    action,
    taskLabel: task.label,
    agent: task.agent,
    state: task.state,
    previousState: old?.state,
    tool: task.activity ?? (kind === "tool" ? old?.activity : undefined),
    // live_progress does not contain a timestamp for its current tool. Do not
    // borrow the task's unchanged updated_at and claim it dates a tool event.
    sourceAt: kind === "tool" ? undefined : task.completedAt ?? task.updatedAt,
  };
}

/** Bounded, memory-only projection of the public event bus. Ownership is never inferred from DAG edges. */
export class WebModel {
  private research = new ResearchProjection();
  private taskBatches = new Map<string, TaskBatch>();
  private runBatches = new Map<string, ReturnType<typeof parseRuns>>();
  private log: Activity[] = [];
  private seq = 0;
  private session?: WebSnapshot["session"];
  private updatedAt?: string;

  start(session: WebSnapshot["session"]): void {
    if (this.session?.id !== session.id) {
      this.log = [];
      this.updatedAt = undefined;
      this.research.clear();
    }
    this.session = session;
    this.prune();
  }
  update(session: Partial<WebSnapshot["session"]>): void {
    if (this.session) this.session = { ...this.session, ...session };
  }
  receive(name: string, payload: unknown): void {
    if (name === "omo.research.capability" || name === "omo.research.event") {
      if (this.session && this.research.receive(name, payload, this.researchOwnership()))
        this.updatedAt = new Date().toISOString();
      return;
    }
    const batch =
      name === "omo.task.updated"
        ? parseTasks(payload)
        : name === "omo.dag.updated"
          ? parseRuns(payload)
          : undefined;
    if (!batch) return;
    if (this.session && !this.allowedSessions().has(batch.sessionId)) return;
    if ("tasks" in batch) {
      const prior = this.taskBatches.get(batch.sessionId);
      for (const task of batch.tasks) {
        const old = prior?.tasks.find((t) => t.id === task.id);
        const change = activityChange(task, old);
        if (change) this.log.unshift({ id: ++this.seq, ...change, at: new Date().toISOString() });
      }
      this.log = this.log.slice(0, 80);
      this.taskBatches.set(batch.sessionId, batch);
    } else this.runBatches.set(batch.sessionId, batch);
    for (const map of [this.taskBatches, this.runBatches])
      while (map.size > (this.session ? 64 : 4))
        map.delete(map.keys().next().value!);
    this.updatedAt = new Date().toISOString();
    if (this.session) this.prune();
  }
  private allowedSessions(): Set<string> {
    const sessions = new Set<string>(this.session ? [this.session.id] : []);
    for (const sid of sessions) {
      for (const task of this.taskBatches.get(sid)?.tasks ?? [])
        if (task.childSessionId && sessions.size < 64)
          sessions.add(task.childSessionId);
    }
    return sessions;
  }
  private prune(): void {
    const sessions = this.allowedSessions();
    for (const map of [this.taskBatches, this.runBatches])
      for (const sid of map.keys()) if (!sessions.has(sid)) map.delete(sid);
    this.research.prune(this.researchOwnership());
  }
  private researchOwnership(): ResearchOwnership {
    const parentSessionIds = this.allowedSessions();
    const tasks: AgentTask[] = [];
    const seen = new Set<string>();
    for (const sid of parentSessionIds) for (const task of this.taskBatches.get(sid)?.tasks ?? []) {
      if (seen.has(task.id) || tasks.length >= 512) continue;
      seen.add(task.id);
      tasks.push(task);
    }
    return { rootSessionId: this.session?.id ?? "", parentSessionIds, tasks };
  }
  snapshot(): WebSnapshot {
    const session = this.session ?? {
      id: "",
      title: "No session",
      project: "omo-herdr",
      state: "idle" as const,
    };
    const tasks: AgentTask[] = [];
    const seen = new Set<string>();
    let omitted = 0;
    const sessions = this.allowedSessions();
    for (const sid of sessions) {
      const batch = this.taskBatches.get(sid);
      if (!batch) continue;
      omitted += batch.omitted;
      const parent = tasks.find((t) => t.childSessionId === sid);
      for (const task of batch.tasks) {
        if (seen.has(task.id)) continue;
        if (tasks.length >= 512) {
          omitted++;
          continue;
        }
        seen.add(task.id);
        tasks.push({ ...task, parentTaskId: parent?.id });
      }
    }
    const rootRuns = this.runBatches.get(session.id);
    return {
      schemaVersion: 1,
      session,
      tasks,
      runs: rootRuns?.runs ?? [],
      omitted: omitted + (rootRuns?.omitted ?? 0),
      activity: this.log.filter((e) => !e.taskId || seen.has(e.taskId)),
      research: this.research.snapshot(this.researchOwnership()),
      updatedAt: this.updatedAt,
    };
  }
  clear(): void {
    this.research.clear();
    this.taskBatches.clear();
    this.runBatches.clear();
    this.log = [];
    this.session = undefined;
    this.updatedAt = undefined;
  }
}
