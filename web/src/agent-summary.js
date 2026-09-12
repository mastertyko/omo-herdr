export const statusWords = {
  running: "Working",
  pending: "Waiting",
  blocked: "Blocked",
  paused: "Paused",
  failed: "Failed",
  cancelled: "Cancelled",
  completed: "Done",
  idle: "Ready",
  unknown: "Unknown",
};

export function statusDescription(state, subject = "task") {
  const descriptions = {
    completed: `OmO reports this ${subject} as completed.`,
    failed: `OmO reports that this ${subject} failed.`,
    cancelled: `This ${subject} was cancelled.`,
    paused: `This ${subject} is paused.`,
    blocked: "OmO reports this work as blocked.",
    running: "Work is in progress.",
    pending: `This ${subject} is waiting to start.`,
    idle: "The agent is ready for more work.",
  };
  return descriptions[state] ?? "A status has not been reported.";
}

/** The tree and its summary both count the main agent and every reported task. */
export function summarizeAgents(session, tasks) {
  const counts = Object.fromEntries(Object.keys(statusWords).map((state) => [state, 0]));
  for (const agent of [...(session ? [session] : []), ...tasks]) {
    const state = Object.hasOwn(statusWords, agent.state) ? agent.state : "unknown";
    counts[state]++;
  }
  return {
    total: tasks.length + (session ? 1 : 0),
    counts,
    items: Object.entries(counts)
      .filter(([, count]) => count > 0)
      .map(([state, count]) => ({ state, count, label: statusWords[state] })),
  };
}
