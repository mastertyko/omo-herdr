// Explicit illustrative data, selected only by ?demo=1&scene=research.
// URLs are real documentation; the searches and retrieval are fictional.
const taskId = "st_librarian";
const childSessionId = "demo-librarian";
const parentSessionId = "demo-research";
const startedAt = "2026-09-12T12:27:00Z";
const completedAt = "2026-09-12T12:28:00Z";
const realtimeDocs = "https://platform.openai.com/docs/guides/realtime";

export const researchDemo = {
  schemaVersion: 1,
  session: {
    id: parentSessionId,
    title: "Explore the Realtime API",
    project: "Research",
    state: "running",
    model: "Astra",
    activity: "Coordinating",
  },
  tasks: [
    {
      id: taskId,
      label: "API research",
      agent: "Librarian",
      state: "running",
      activity: "Searching for WebSocket reconnect guidance",
      startedAt,
      model: "Astra",
      childSessionId,
    },
    {
      id: "st_backend",
      label: "Auth API",
      agent: "Backend",
      state: "pending",
      model: "Astra",
    },
  ],
  runs: [
    {
      id: "demo-research-run",
      name: "Explore the Realtime API",
      state: "running",
      nodes: [
        { id: "research", label: "API research", state: "running", taskId },
        { id: "auth", label: "Auth API", state: "pending", taskId: "st_backend" },
      ],
      edges: [{ from: "research", to: "auth" }],
    },
  ],
  research: {
    status: "available",
    taskIds: [taskId],
    history: "live-only",
    supportedOperations: ["search", "retrieval"],
    omitted: 0,
    unsupported: 0,
    missingEvents: 0,
    records: [
      {
        id: "demo-search-realtime",
        taskId,
        toolCallId: "demo-search-call-1",
        parentSessionId,
        childSessionId,
        kind: "search",
        phase: "completed",
        state: "completed",
        sequence: 2,
        startedAt,
        updatedAt: completedAt,
        provider: "Web search",
        query: "realtime API documentation",
        sources: [
          { id: "realtime-docs", title: "Realtime API reference", url: realtimeDocs },
          {
            id: "streaming-examples",
            title: "Streaming examples",
            url: "https://github.com/openai/openai-realtime-console",
          },
          {
            id: "realtime-websocket",
            title: "WebSocket connections",
            url: "https://platform.openai.com/docs/guides/realtime-websocket",
          },
        ],
        omittedSources: 0,
      },
      {
        id: "demo-fetch-realtime",
        taskId,
        toolCallId: "demo-retrieval-call-1",
        parentSessionId,
        childSessionId,
        kind: "retrieval",
        phase: "completed",
        state: "fetched",
        sequence: 4,
        startedAt: "2026-09-12T12:28:01Z",
        updatedAt: "2026-09-12T12:28:03Z",
        provider: "Page retrieval",
        requestedUrl: realtimeDocs,
        finalUrl: realtimeDocs,
        title: "Realtime API reference",
        httpStatus: 200,
        contentType: "text/html",
        relatedSearchId: "demo-search-realtime",
        sources: [],
        omittedSources: 0,
      },
      {
        id: "demo-search-reconnect",
        taskId,
        toolCallId: "demo-search-call-2",
        parentSessionId,
        childSessionId,
        kind: "search",
        phase: "started",
        state: "requested",
        sequence: 5,
        startedAt: "2026-09-12T12:29:00Z",
        updatedAt: "2026-09-12T12:29:00Z",
        provider: "Web search",
        query: "websocket reconnect",
        sources: [],
        omittedSources: 0,
      },
    ],
  },
  activity: [
    {
      id: 2,
      taskId,
      label: 'Search completed for "realtime API documentation"',
      action: "Stopped reporting bash",
      agent: "Librarian", taskLabel: "API research", state: "running", kind: "tool", tool: "bash",
      at: completedAt,
    },
    { id: 1, taskId, label: "Librarian started API research", action: "Started working", agent: "Librarian", taskLabel: "API research", state: "running", kind: "state", at: startedAt },
  ],
  omitted: 0,
};
