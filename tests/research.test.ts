import assert from "node:assert/strict";
import { test } from "node:test";
import { WebModel } from "../src/web-model.ts";
import { RESEARCH_LIMITS, safeResearchUrl, type ResearchCapabilityEvent, type ResearchEvent } from "../src/research.ts";

const root = { id: "root", title: "Research", project: "test", state: "running" as const };
const capability = (extra: Partial<ResearchCapabilityEvent> = {}): ResearchCapabilityEvent => ({
  schema_version: 1, root_session_id: "root", parent_session_id: "root", producer: "omo",
  capture: "enabled", coverage: "supported-tools", supported_operations: ["search", "retrieval"], sequence: 0, revision: 1, ...extra,
});
const event = (sequence: number, extra: Partial<ResearchEvent> = {}): ResearchEvent => ({
  schema_version: 1, root_session_id: "root", parent_session_id: "root", child_session_id: "child",
  task_id: "st_librarian", event_id: `event-${sequence}`, operation_id: "search-one", tool_call_id: "call-one",
  sequence, occurred_at: `2026-09-12T12:00:${String(sequence % 60).padStart(2, "0")}.000Z`, kind: "search", phase: "started",
  query: "Herdr integrations", provider: "github", ...extra,
});
const announceTasks = (m: WebModel) => m.receive("omo.task.updated", {
  parent_session_id: "root", tasks: [
    { task_id: "st_librarian", child_session_id: "child", agent_type: "librarian", status: "running" },
    { task_id: "st_second", child_session_id: "second", agent_type: "librarian", status: "running" },
  ],
});
function model(announce = true): WebModel {
  const m = new WebModel();
  m.start(root);
  announceTasks(m);
  if (announce) m.receive("omo.research.capability", capability());
  return m;
}
const observe = (m: WebModel, sequence: number, extra: Partial<ResearchEvent> = {}) =>
  m.receive("omo.research.event", event(sequence, extra));

test("research starts unavailable and requires both capability and observed ownership", () => {
  const m = model(false);
  observe(m, 1);
  assert.equal(m.snapshot().research.status, "unavailable");
  assert.deepEqual(m.snapshot().research.records, []);
  for (const bad of [
    { root_session_id: "other" }, { parent_session_id: "foreign" },
    { capture: "implicit" }, { coverage: "everything" }, { schema_version: 2 },
  ]) m.receive("omo.research.capability", { ...capability(), ...bad });
  assert.equal(m.snapshot().research.status, "unavailable");
  m.receive("omo.research.capability", capability());
  for (const bad of [
    { root_session_id: "other" }, { parent_session_id: "foreign" },
    { child_session_id: "second" }, { task_id: "st_unobserved" }, { child_session_id: "" },
    { sequence: -1 }, { schema_version: 2 }, { occurred_at: "yesterday" },
  ]) m.receive("omo.research.event", { ...event(1), ...bad });
  assert.deepEqual(m.snapshot().research.records, []);
  observe(m, 1);
  assert.equal(m.snapshot().research.status, "available");
  assert.deepEqual(m.snapshot().research.taskIds, ["st_librarian", "st_second"]);
  assert.equal(m.snapshot().research.history, "live-only");
});

test("self-contained completion survives terminal-before-start and duplicate deliveries", () => {
  const m = model();
  observe(m, 2, { phase: "completed", evidence: "search-results", sources: [{ url: "https://herdr.dev/docs", title: "Herdr docs" }] });
  assert.equal(m.snapshot().research.missingEvents, 1);
  assert.equal(m.snapshot().research.status, "partial");
  observe(m, 1);
  observe(m, 2, { phase: "failed" });
  observe(m, 3, { event_id: "event-2", phase: "failed" });
  const snapshot = m.snapshot().research;
  assert.equal(snapshot.records.length, 1);
  assert.equal(snapshot.records[0]?.phase, "completed");
  assert.equal(snapshot.records[0]?.state, "completed");
  assert.equal(snapshot.records[0]?.query, "Herdr integrations");
  assert.equal(snapshot.records[0]?.sources[0]?.title, "Herdr docs");
  assert.equal(snapshot.records[0]?.sourcesReported, true);
  assert.equal(snapshot.records[0]?.startedAt, event(1).occurred_at);
  assert.equal(snapshot.missingEvents, 0);
  assert.equal(snapshot.status, "available");
});

test("empty search results remain distinct from unavailable result metadata", () => {
  const m = model();
  observe(m, 1, { phase: "completed", evidence: "search-results", sources: [] });
  observe(m, 2, { operation_id: "no-details", tool_call_id: "other-call", phase: "completed" });
  assert.deepEqual(m.snapshot().research.records.map(record => [record.sources.length, record.sourcesReported]), [[0, true], [0, false]]);
});

test("provider-composite tool call IDs retain research phases and identity", () => {
  const m = model();
  // Responses providers append their function-call item ID with a pipe.
  const toolCallId = "call_research123|fc_0123456789abcdef";
  observe(m, 1, { tool_call_id: toolCallId });
  observe(m, 2, { tool_call_id: toolCallId, phase: "completed", evidence: "search-results", sources: [{ url: "https://github.com/code-yeongyu/oh-my-openagent" }] });
  observe(m, 2, { tool_call_id: toolCallId, phase: "failed" });
  observe(m, 3, { tool_call_id: "call_other|fc_other", phase: "failed" });
  for (const invalid of ["call\nother", "call\u001b[0m", "call with spaces", "a".repeat(257)])
    observe(m, 3, { operation_id: "invalid", tool_call_id: invalid });
  const research = m.snapshot().research;
  assert.equal(research.records.length, 1);
  assert.equal(research.records[0]?.toolCallId, toolCallId);
  assert.equal(research.records[0]?.state, "completed");
  assert.equal(research.records[0]?.sources.length, 1);
  assert.equal(research.records[0]?.startedAt, event(1).occurred_at);
  assert.equal(research.missingEvents, 0);
});

test("repeated searches and concurrent agents retain distinct occurrence identities", () => {
  const m = model();
  const entries: Partial<ResearchEvent>[] = [
    {}, { operation_id: "search-two", tool_call_id: "call-two" },
    { operation_id: "search-three", tool_call_id: "call-three", task_id: "st_second", child_session_id: "second" },
  ];
  entries.forEach((extra, i) => observe(m, i + 1, { ...extra, phase: "completed", evidence: "search-results", sources: [{ url: "https://example.com/same" }] }));
  const records = m.snapshot().research.records;
  assert.equal(records.length, 3);
  assert.equal(new Set(records.map(r => r.id)).size, 3);
  assert.equal(new Set(records.map(r => r.sources[0]?.id)).size, 3);
  observe(m, 4, { task_id: "st_second", child_session_id: "second", phase: "failed" });
  assert.equal(m.snapshot().research.records[0]?.taskId, "st_librarian");
  assert.equal(m.snapshot().research.records[0]?.phase, "completed");
});

test("retrieval status reports evidence, not process success or returned search metadata", () => {
  const m = model();
  const cases: [Partial<ResearchEvent>, string][] = [
    [{ phase: "started" }, "requested"],
    [{ phase: "completed" }, "unknown"],
    [{ phase: "completed", evidence: "response-received" }, "unknown"],
    [{ phase: "completed", evidence: "response-received", http_status: 200 }, "fetched"],
    [{ phase: "completed", evidence: "response-received", http_status: 404 }, "failed"],
    [{ phase: "completed", evidence: "headers-received", http_status: 200 }, "metadata-only"],
    [{ phase: "completed", evidence: "response-received", http_status: 301 }, "unknown"],
    [{ phase: "failed", evidence: "response-received", http_status: 200 }, "failed"],
  ];
  cases.forEach(([extra], i) => observe(m, i + 1, {
    operation_id: `request-${i}`, tool_call_id: `call-${i}`, kind: "retrieval", query: undefined,
    requested_url: "https://example.com/page", ...extra,
  }));
  assert.deepEqual(m.snapshot().research.records.map(r => r.state), cases.map(([, expected]) => expected));
  observe(m, 9, { phase: "completed", sources: [{ url: "https://example.com/unconfirmed" }] });
  assert.deepEqual(m.snapshot().research.records.at(-1)?.sources, []);
});

test("source links require explicit same-task search ownership and never infer URL matches", () => {
  const m = model();
  observe(m, 1, { phase: "completed", evidence: "search-results", sources: [{ url: "https://example.com" }] });
  observe(m, 2, { operation_id: "fetch-unrelated", tool_call_id: "fetch-one", kind: "retrieval", requested_url: "https://example.com" });
  observe(m, 3, { operation_id: "fetch-related", tool_call_id: "fetch-two", kind: "retrieval", related_search_id: "search-one" });
  observe(m, 4, { operation_id: "fetch-foreign", tool_call_id: "fetch-three", kind: "retrieval", related_search_id: "search-one", task_id: "st_second", child_session_id: "second" });
  observe(m, 5, { operation_id: "fetch-unknown", tool_call_id: "fetch-four", kind: "retrieval", related_search_id: "unknown" });
  const records = m.snapshot().research.records;
  assert.equal(records[1]?.relatedSearchId, undefined);
  assert.equal(records[2]?.relatedSearchId, records[0]?.id);
  assert.equal(records[3]?.relatedSearchId, undefined);
  assert.equal(records[4]?.relatedSearchId, undefined);
});

test("research explicitly allowlists metadata, redacts URLs, and rejects executable links", () => {
  const m = model();
  m.receive("omo.research.event", {
    ...event(1, {
      phase: "completed", evidence: "search-results", requested_url: "javascript:alert(1)", final_url: "file:///etc/passwd",
      sources: [
        { url: "https://user:SECRET@example.com/page?q=herdr&access_token=SECRET&api_key=SECRET#SECRET", title: "Useful page" },
        { url: "data:text/html,SECRET" }, { url: "https://example.com/?q=token%3DSECRET&random=SECRET" },
      ],
    }),
    headers: { Authorization: "SECRET" }, output: "SECRET", transcript: "SECRET", args: { password: "SECRET" },
  });
  const record = m.snapshot().research.records[0]!;
  assert.equal(record.requestedUrl, undefined);
  assert.equal(record.finalUrl, undefined);
  assert.equal(record.sources[0]?.url, "https://example.com/page?q=herdr");
  assert.equal(record.sources[1]?.url, "https://example.com/");
  assert.equal(record.omittedSources, 1);
  assert.ok(!JSON.stringify(m.snapshot().research).includes("SECRET"));
  observe(m, 2, { operation_id: "secret-query", tool_call_id: "secret-call", query: "password=SECRET", title: "Bearer SECRET" });
  assert.equal(m.snapshot().research.records.at(-1)?.query, undefined);
  assert.equal(m.snapshot().research.records.at(-1)?.title, undefined);
  assert.equal(safeResearchUrl("https://example.com/path\n"), undefined);
  assert.equal(safeResearchUrl("https://example.com/" + "a".repeat(5000)), undefined);
});

test("bursts stay bounded and expose source and operation truncation", () => {
  const m = model();
  for (let i = 1; i <= 300; i++) observe(m, i, {
    operation_id: `operation-${i}`, tool_call_id: `call-${i}`,
    ...(i % 2 ? {} : { task_id: "st_second", child_session_id: "second" }),
    phase: "completed", evidence: "search-results",
    sources: Array.from({ length: 20 }, (_, index) => ({ url: `https://example.com/${index}` })),
  });
  const snapshot = m.snapshot().research;
  assert.equal(snapshot.records.length, RESEARCH_LIMITS.operations);
  assert.equal(snapshot.omitted, 44);
  assert.equal(snapshot.records[0]?.sources.length, RESEARCH_LIMITS.sources);
  assert.equal(snapshot.records[0]?.omittedSources, 4);
  assert.equal(snapshot.missingEvents, 0);
  assert.equal(snapshot.status, "partial");
  observe(m, 1, { operation_id: "operation-1", tool_call_id: "call-1" });
  assert.equal(m.snapshot().research.omitted, 44);
  assert.ok(!m.snapshot().research.records.some(r => r.id === "root/operation-1"));
});

test("reload gaps, unavailable operations and expired replay windows remain explicit", () => {
  const m = model(false);
  m.receive("omo.research.capability", capability({ sequence: 5000, unsupported_count: 3, omitted_events: 2 }));
  observe(m, 5001, { phase: "completed" });
  observe(m, 1, { operation_id: "expired", tool_call_id: "expired" });
  const snapshot = m.snapshot().research;
  assert.equal(snapshot.records.length, 1);
  assert.equal(snapshot.missingEvents, 5002);
  assert.equal(snapshot.unsupported, 3);
  assert.equal(snapshot.status, "partial");
  m.receive("omo.research.capability", capability({ sequence: 0 }));
  assert.equal(m.snapshot().research.unsupported, 3);
});

test("nested capability uses observed parent ownership and is pruned with its subtree", () => {
  const m = model(false);
  m.receive("omo.research.capability", capability({ parent_session_id: "grandchild" }));
  assert.equal(m.snapshot().research.status, "unavailable");
  m.receive("omo.task.updated", { parent_session_id: "child", tasks: [{ task_id: "st_nested", child_session_id: "grandchild", status: "running" }] });
  m.receive("omo.research.capability", capability({ parent_session_id: "child" }));
  observe(m, 1, { parent_session_id: "child", child_session_id: "grandchild", task_id: "st_nested" });
  assert.deepEqual(m.snapshot().research.taskIds, ["st_nested"]);
  assert.equal(m.snapshot().research.records.length, 1);
  m.receive("omo.task.updated", { parent_session_id: "root", tasks: [] });
  assert.equal(m.snapshot().research.status, "unavailable");
  assert.deepEqual(m.snapshot().research.records, []);
});

test("disabling capture, replacing a session and shutdown clear stored research", () => {
  const m = model();
  observe(m, 1);
  m.receive("omo.research.capability", capability({ capture: "disabled", sequence: 1, revision: 2 }));
  observe(m, 2);
  assert.equal(m.snapshot().research.status, "unavailable");
  assert.deepEqual(m.snapshot().research.records, []);
  m.receive("omo.research.capability", capability({ sequence: 1, revision: 3 }));
  observe(m, 2);
  m.start({ ...root, id: "replacement" });
  observe(m, 3);
  assert.equal(m.snapshot().research.status, "unavailable");
  assert.deepEqual(m.snapshot().research.records, []);
  m.start(root);
  announceTasks(m);
  m.receive("omo.research.capability", capability());
  observe(m, 1);
  m.clear();
  assert.equal(m.snapshot().research.status, "unavailable");
  assert.deepEqual(m.snapshot().research.records, []);
});

test("capability revisions prevent stale or duplicate messages from reversing capture state", () => {
  const m = model();
  observe(m, 1);
  m.receive("omo.research.capability", capability({ sequence: 1, revision: 2, capture: "disabled" }));
  m.receive("omo.research.capability", capability({ sequence: 1, revision: 1 }));
  m.receive("omo.research.capability", capability({ sequence: 1, revision: 2 }));
  assert.equal(m.snapshot().research.status, "unavailable");
  m.receive("omo.research.capability", capability({ sequence: 1, revision: 3 }));
  assert.equal(m.snapshot().research.status, "available");
});

test("re-enabling capture cannot restore delayed observations from a cleared capture", () => {
  const m = model();
  observe(m, 1);
  m.receive("omo.research.capability", capability({ sequence: 3, revision: 2, capture: "disabled" }));
  m.receive("omo.research.capability", capability({ sequence: 3, revision: 3 }));
  assert.equal(m.snapshot().research.missingEvents, 2);
  observe(m, 2, { operation_id: "old-start", tool_call_id: "old-call" });
  observe(m, 3, { phase: "completed", evidence: "search-results", sources: [{ url: "https://example.com/old" }] });
  assert.deepEqual(m.snapshot().research.records, []);
  observe(m, 4, { operation_id: "new-search", tool_call_id: "new-call" });
  assert.deepEqual(m.snapshot().research.records.map(r => r.id), ["root/new-search"]);
  assert.equal(m.snapshot().research.missingEvents, 0);
  m.receive("omo.research.capability", capability({ sequence: 4, revision: 4 }));
  observe(m, 2, { operation_id: "old-start", tool_call_id: "old-call" });
  assert.deepEqual(m.snapshot().research.records.map(r => r.id), ["root/new-search"]);
});

test("returned snapshots cannot mutate future research state", () => {
  const m = model();
  observe(m, 1, { phase: "completed", evidence: "search-results", sources: [{ url: "https://example.com" }] });
  const snapshot = m.snapshot().research;
  snapshot.records[0]!.state = "failed";
  snapshot.records[0]!.sources[0]!.title = "changed";
  assert.equal(m.snapshot().research.records[0]?.state, "completed");
  assert.equal(m.snapshot().research.records[0]?.sources[0]?.title, undefined);
});
