/** OmO beta.56's version-sensitive snapshot adapter. No prompts/results are retained. */
export interface TaskCounts {
  running: number;
  pending: number;
  completed: number;
  failed: number;
  cancelled: number;
  unknown: number;
  omitted: number;
}
const statuses: Record<string, keyof TaskCounts> = {
  running: "running", pending: "pending", completed: "completed", error: "failed",
  interrupted: "failed", lost: "failed", cancelled: "cancelled",
};
export function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
export function taskSnapshot(value: unknown): { sessionId: string; counts: TaskCounts } | undefined {
  const payload = object(value);
  if (!payload || typeof payload.parent_session_id !== "string" || !payload.parent_session_id ||
    payload.parent_session_id.length > 256 || !Array.isArray(payload.tasks)) return;
  const counts: TaskCounts = { running: 0, pending: 0, completed: 0, failed: 0, cancelled: 0, unknown: 0, omitted: 0 };
  const seen = new Set<string>();
  for (const raw of payload.tasks.slice(0, 256)) {
    const task = object(raw);
    if (!task || typeof task.task_id !== "string" || !/^st_[A-Za-z0-9_-]{1,253}$/.test(task.task_id) || seen.has(task.task_id)) continue;
    if (task.parent_session_id !== undefined && task.parent_session_id !== payload.parent_session_id) continue;
    seen.add(task.task_id);
    const key = typeof task.status === "string" && Object.hasOwn(statuses, task.status) ? statuses[task.status]! : "unknown";
    counts[key]++;
  }
  counts.omitted = Math.max(0, payload.tasks.length - 256) +
    (Number.isSafeInteger(payload.truncated_tasks) && Number(payload.truncated_tasks) > 0 ? Number(payload.truncated_tasks) : 0);
  return { sessionId: payload.parent_session_id, counts };
}
export function taskLabels(counts: TaskCounts | undefined): { tasks?: string; attention?: string } {
  if (!counts) return {};
  const parts = (["running", "pending", "completed", "failed", "cancelled", "unknown"] as const)
    .filter(key => counts[key] > 0).map(key => `${counts[key]} ${key}`);
  if (counts.omitted) parts.push(`+${counts.omitted} not shown`);
  return { tasks: parts.join(" · ") || undefined,
    attention: counts.failed ? `${counts.failed} failed ${counts.failed === 1 ? "task" : "tasks"}` : undefined };
}
