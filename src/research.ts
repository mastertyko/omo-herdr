import { displayText } from "./metadata.ts";
import { object } from "./tasks.ts";

/** Proposed opt-in producer contract. Installed OmO versions do not imply support.
 * Sequence is monotonic per parent session for its lifetime, independent of task
 * snapshots. Each event is a self-contained operation upsert. An operation ID is
 * stable across its phases; related_search_id is supplied only for known causality.
 * The capability sequence is the last emitted observation, exposing reload gaps.
 */
export interface ResearchCapabilityEvent {
  schema_version: 1;
  root_session_id: string;
  parent_session_id: string;
  producer: "omo";
  capture: "enabled" | "disabled";
  coverage: "supported-tools";
  supported_operations: ResearchKind[];
  sequence: number;
  /** Monotonic capability revision independent of observation sequence. */
  revision: number;
  unsupported_count?: number;
  /** Terminal observations no longer emittable after active correlation eviction. */
  omitted_events?: number;
}
export type ResearchKind = "search" | "retrieval";
export type ResearchPhase = "started" | "completed" | "failed";
export type ResearchState = "requested" | "completed" | "fetched" | "metadata-only" | "failed" | "unknown";
export interface ResearchEvent {
  schema_version: 1;
  root_session_id: string;
  parent_session_id: string;
  child_session_id: string;
  task_id: string;
  event_id: string;
  operation_id: string;
  tool_call_id: string;
  sequence: number;
  occurred_at: string;
  kind: ResearchKind;
  phase: ResearchPhase;
  provider?: string;
  query?: string;
  requested_url?: string;
  final_url?: string;
  title?: string;
  http_status?: number;
  content_type?: string;
  evidence?: "search-results" | "response-received" | "headers-received";
  related_search_id?: string;
  sources?: { url: string; title?: string }[];
  omitted_sources?: number;
}
export interface ResearchRecord {
  id: string;
  taskId: string;
  toolCallId: string;
  parentSessionId: string;
  childSessionId: string;
  kind: ResearchKind;
  phase: ResearchPhase;
  state: ResearchState;
  sequence: number;
  startedAt?: string;
  updatedAt: string;
  provider?: string;
  query?: string;
  requestedUrl?: string;
  finalUrl?: string;
  title?: string;
  httpStatus?: number;
  contentType?: string;
  relatedSearchId?: string;
  sourcesReported: boolean;
  sources: { id: string; url: string; title?: string }[];
  omittedSources: number;
}
export interface ResearchSnapshot {
  status: "unavailable" | "available" | "partial";
  history: "live-only";
  records: ResearchRecord[];
  /** Task IDs covered by an explicitly enabled capability for their parent. */
  taskIds: string[];
  supportedOperations: ResearchKind[];
  omitted: number;
  missingEvents: number;
  unsupported: number;
}
export interface ResearchOwnership {
  rootSessionId: string;
  parentSessionIds: ReadonlySet<string>;
  tasks: readonly { id: string; parentSessionId: string; childSessionId?: string }[];
}

export const RESEARCH_LIMITS = { operations: 256, sources: 16, deliveryWindow: 2048 } as const;
const identifier = (v: unknown): string | undefined =>
  typeof v === "string" && /^[A-Za-z0-9_.:-]{1,256}$/.test(v) ? v : undefined;
// Some providers combine call and item IDs with a pipe. Preserve that opaque
// correlation key while keeping session/task identifiers and control bytes strict.
const toolCallIdentifier = (v: unknown): string | undefined =>
  typeof v === "string" && /^[A-Za-z0-9_.:|\-]{1,256}$/.test(v) ? v : undefined;
const nonnegative = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
const label = (v: unknown, max: number) =>
  typeof v === "string" ? displayText(v.slice(0, max * 4), max) : undefined;
const timestamp = (v: unknown) =>
  typeof v === "string" && v.length <= 64 && Number.isFinite(Date.parse(v))
    ? new Date(v).toISOString() : undefined;
const kindOf = (v: unknown): ResearchKind | undefined =>
  v === "search" || v === "retrieval" ? v : undefined;
const phaseOf = (v: unknown): ResearchPhase | undefined =>
  v === "started" || v === "completed" || v === "failed" ? v : undefined;
const secret = /(?:\bBearer\s+\S+|\b(?:gh[pousr]_|github_pat_|sk-(?:proj-)?)[A-Za-z0-9_-]{12,}|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|(?:password|passwd|secret|token|api[_-]?key)\s*[=:]\s*\S+)/i;
const safeText = (v: unknown, max: number) => {
  const value = label(v, max);
  return value && !secret.test(value) ? value : undefined;
};
// Retain only navigation/search parameters with a known display purpose. Unknown
// query keys, credentials and fragments can carry tokens and are never retained.
const navigationParams = new Set(["q", "query", "search", "term", "page", "per_page", "sort", "order", "language", "type", "ref", "branch", "tab", "id", "sha"]);
export function safeResearchUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 4096 || /[\p{Cc}\p{Cf}]/u.test(value)) return;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname) return;
    url.username = "";
    url.password = "";
    url.hash = "";
    if (secret.test(decodeURIComponent(url.pathname))) return;
    const params = new URLSearchParams();
    for (const [key, val] of url.searchParams) {
      if (navigationParams.has(key.toLowerCase()) && val.length <= 512 && !secret.test(val))
        params.append(key, val);
    }
    url.search = params.toString();
    const clean = url.toString();
    return clean.length <= 2048 ? clean : undefined;
  } catch { return; }
}

interface ParsedEvent { eventId: string; record: ResearchRecord }
function parseEvent(value: unknown, ownership: ResearchOwnership): ParsedEvent | undefined {
  const p = object(value);
  const parentSessionId = identifier(p?.parent_session_id);
  const childSessionId = identifier(p?.child_session_id);
  const taskId = identifier(p?.task_id);
  const eventId = identifier(p?.event_id);
  const operationId = identifier(p?.operation_id);
  const toolCallId = toolCallIdentifier(p?.tool_call_id);
  const sequence = nonnegative(p?.sequence);
  const updatedAt = timestamp(p?.occurred_at);
  const kind = kindOf(p?.kind);
  const phase = phaseOf(p?.phase);
  if (!p || p.schema_version !== 1 || p.root_session_id !== ownership.rootSessionId ||
    !parentSessionId || !ownership.parentSessionIds.has(parentSessionId) || !childSessionId ||
    !taskId || !eventId || !operationId || !toolCallId || !sequence || !updatedAt || !kind || !phase ||
    !ownership.tasks.some(t => t.id === taskId && t.parentSessionId === parentSessionId && t.childSessionId === childSessionId)) return;
  const id = `${parentSessionId}/${operationId}`;
  const httpStatus = typeof p.http_status === "number" && Number.isInteger(p.http_status) &&
    p.http_status >= 100 && p.http_status <= 599 ? p.http_status : undefined;
  const evidence = p.evidence;
  let state: ResearchState = phase === "failed" ? "failed" : phase === "started" ? "requested" : "unknown";
  if (phase === "completed") {
    if (kind === "search") state = "completed";
    else if (httpStatus !== undefined && httpStatus >= 400) state = "failed";
    else if (evidence === "headers-received") state = "metadata-only";
    else if (evidence === "response-received" && httpStatus !== undefined && httpStatus >= 200 && httpStatus < 300)
      state = "fetched";
  }
  const sources: ResearchRecord["sources"] = [];
  const sourcesReported = kind === "search" && phase === "completed" && evidence === "search-results" && Array.isArray(p.sources);
  const rawSources = sourcesReported ? p.sources as unknown[] : [];
  for (const [index, value] of rawSources.slice(0, RESEARCH_LIMITS.sources).entries()) {
    const source = object(value);
    const url = safeResearchUrl(source?.url);
    if (url) sources.push({ id: `${id}/source/${index}`, url, title: safeText(source?.title, 240) });
  }
  const relatedSearch = identifier(p.related_search_id);
  return {
    eventId,
    record: {
      id, taskId, parentSessionId, childSessionId, toolCallId, kind, phase, state, sequence,
      startedAt: phase === "started" ? updatedAt : undefined, updatedAt,
      provider: safeText(p.provider, 64), query: safeText(p.query, 512),
      requestedUrl: safeResearchUrl(p.requested_url), finalUrl: safeResearchUrl(p.final_url),
      title: safeText(p.title, 240), httpStatus, contentType: safeText(p.content_type, 80),
      relatedSearchId: kind === "retrieval" && relatedSearch ? `${parentSessionId}/${relatedSearch}` : undefined,
      sourcesReported, sources,
      omittedSources: Math.min(1_000_000, (nonnegative(p.omitted_sources) ?? 0) + rawSources.length - sources.length),
    },
  };
}

/** Sliding bounded delivery ledger: late events fill gaps without rewinding state. */
class Delivery {
  private observed = new Map<number, string>();
  private ids = new Set<string>();
  private high = 0;
  private floor = 0;
  private lost = 0;
  announced(sequence: number): void { this.advance(sequence); }
  accept(sequence: number, eventId: string): boolean {
    if (sequence <= this.floor || this.observed.has(sequence) || this.ids.has(eventId)) return false;
    this.observed.set(sequence, eventId);
    this.ids.add(eventId);
    this.advance(sequence);
    return true;
  }
  private advance(sequence: number): void {
    this.high = Math.max(this.high, sequence);
    const floor = Math.max(0, this.high - RESEARCH_LIMITS.deliveryWindow);
    if (floor <= this.floor) return;
    let delivered = 0;
    for (const [seq, eventId] of this.observed) if (seq <= floor) {
      delivered++;
      this.observed.delete(seq);
      this.ids.delete(eventId);
    }
    this.lost += floor - this.floor - delivered;
    this.floor = floor;
  }
  missing(): number { return this.lost + this.high - this.floor - this.observed.size; }
}
interface Capability {
  revision: number;
  sequence: number;
  disabledThrough: number;
  enabled: boolean;
  supportedOperations: ResearchKind[];
  unsupported: number;
  omittedEvents: number;
  delivery: Delivery;
}

/** Data is memory-only and admitted only after task snapshots establish ownership. */
export class ResearchProjection {
  private capabilities = new Map<string, Capability>();
  private records = new Map<string, ResearchRecord>();
  private omitted = 0;
  receive(name: string, payload: unknown, ownership: ResearchOwnership): boolean {
    if (name === "omo.research.capability") return this.capability(payload, ownership);
    if (name !== "omo.research.event") return false;
    const parsed = parseEvent(payload, ownership);
    if (!parsed) return false;
    const record = parsed.record;
    const capability = this.capabilities.get(record.parentSessionId);
    if (!capability?.enabled || !capability.supportedOperations.includes(record.kind)) return false;
    const previous = this.records.get(record.id);
    if (previous && (previous.taskId !== record.taskId || previous.childSessionId !== record.childSessionId ||
      previous.toolCallId !== record.toolCallId || previous.kind !== record.kind)) return false;
    if (!capability.delivery.accept(record.sequence, parsed.eventId)) return false;
    // Late delivery can fill a sequence gap, but cannot restore a cleared capture.
    if (record.sequence <= capability.disabledThrough) return true;
    if (previous && (previous.sequence >= record.sequence || (previous.phase !== "started" && record.phase === "started"))) {
      if (!previous.startedAt && record.startedAt) previous.startedAt = record.startedAt;
      return true;
    }
    record.startedAt ??= previous?.startedAt;
    // Reinsert updated operations so the retention bound keeps recent observations.
    this.records.delete(record.id);
    this.records.set(record.id, record);
    while (this.records.size > RESEARCH_LIMITS.operations) {
      this.records.delete(this.records.keys().next().value!);
      this.omitted++;
    }
    return true;
  }
  private capability(value: unknown, ownership: ResearchOwnership): boolean {
    const p = object(value);
    const parent = identifier(p?.parent_session_id);
    const sequence = nonnegative(p?.sequence);
    const revision = nonnegative(p?.revision);
    if (!p || p.schema_version !== 1 || p.root_session_id !== ownership.rootSessionId ||
      p.producer !== "omo" || p.coverage !== "supported-tools" || !parent || !ownership.parentSessionIds.has(parent) ||
      (p.capture !== "enabled" && p.capture !== "disabled") || sequence === undefined || !revision || !Array.isArray(p.supported_operations)) return false;
    const supportedOperations = [...new Set(p.supported_operations.slice(0, 16).map(kindOf).filter((v): v is ResearchKind => !!v))];
    if (p.capture === "enabled" && !supportedOperations.length) return false;
    const old = this.capabilities.get(parent);
    if (old && (old.sequence > sequence || old.revision >= revision)) return false;
    const delivery = old?.delivery ?? new Delivery();
    delivery.announced(sequence);
    this.capabilities.set(parent, {
      sequence, revision, enabled: p.capture === "enabled", supportedOperations, delivery,
      disabledThrough: p.capture === "disabled" ? sequence : old?.disabledThrough ?? 0,
      unsupported: Math.max(old?.unsupported ?? 0, nonnegative(p.unsupported_count) ?? 0),
      omittedEvents: Math.max(old?.omittedEvents ?? 0, nonnegative(p.omitted_events) ?? 0),
    });
    if (p.capture === "disabled")
      for (const [id, record] of this.records) if (record.parentSessionId === parent) this.records.delete(id);
    return true;
  }
  prune(ownership: ResearchOwnership): void {
    for (const id of this.capabilities.keys()) if (!ownership.parentSessionIds.has(id)) this.capabilities.delete(id);
    for (const [id, r] of this.records)
      if (!ownership.tasks.some(t => t.id === r.taskId && t.parentSessionId === r.parentSessionId && t.childSessionId === r.childSessionId)) this.records.delete(id);
  }
  snapshot(ownership: ResearchOwnership): ResearchSnapshot {
    const enabled = [...this.capabilities.values()].filter(c => c.enabled);
    const records = [...this.records.values()].map(r => {
      const related = r.relatedSearchId ? this.records.get(r.relatedSearchId) : undefined;
      return { ...r, sources: r.sources.map(s => ({ ...s })), relatedSearchId: related?.kind === "search" && related.taskId === r.taskId ? r.relatedSearchId : undefined };
    });
    const unsupported = enabled.reduce((n, c) => n + c.unsupported, 0);
    const missingEvents = enabled.reduce((n, c) => n + c.delivery.missing() + c.omittedEvents, 0);
    const partial = this.omitted > 0 || missingEvents > 0 || unsupported > 0 || records.some(r => r.omittedSources > 0);
    return {
      status: !enabled.length ? "unavailable" : partial ? "partial" : "available",
      history: "live-only", records,
      taskIds: ownership.tasks.filter(t => this.capabilities.get(t.parentSessionId)?.enabled).map(t => t.id),
      supportedOperations: [...new Set(enabled.flatMap(c => c.supportedOperations))],
      omitted: this.omitted, missingEvents, unsupported,
    };
  }
  clear(): void {
    this.capabilities.clear();
    this.records.clear();
    this.omitted = 0;
  }
}
