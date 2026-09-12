const EMPTY = [];
export const researchStates = {
  requested: "Requested", completed: "Completed", fetched: "Fetched",
  "metadata-only": "Metadata only", failed: "Failed", unknown: "Unknown",
  result: "Search result",
};
export function sourceUrl(value) {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return undefined;
    return url.href;
  } catch { return undefined; }
}
export function sourceHost(value) {
  const safe = sourceUrl(value);
  return safe ? new URL(safe).hostname : "URL not reported";
}
export function taskResearch(research, taskId) {
  return (research?.records ?? EMPTY).filter((record) => record.taskId === taskId);
}
export function hasResearchCoverage(research, taskId) {
  return research?.status !== "unavailable" && !!research?.taskIds?.includes(taskId);
}

// Sources belong to an occurrence in a search, not a global URL catalogue.
// A retrieval joins a result only when an explicit search relationship exists.
export function researchItems(research, taskId) {
  const records = taskResearch(research, taskId);
  const searches = records.filter((record) => record.kind === "search");
  const retrievals = records.filter((record) => record.kind === "retrieval");
  const consumed = new Set();
  const items = [];
  for (const search of searches) {
    const searchId = JSON.stringify(["operation", search.id]);
    items.push({ id: searchId, kind: "search", record: search, title: search.query ?? "Search query not reported" });
    for (const source of search.sources ?? EMPTY) {
      const linked = retrievals.find((record) => !consumed.has(record.id) &&
        record.relatedSearchId === search.id &&
        !!sourceUrl(source.url) &&
        (sourceUrl(record.requestedUrl) === sourceUrl(source.url) || sourceUrl(record.finalUrl) === sourceUrl(source.url)));
      if (linked) consumed.add(linked.id);
      items.push({
        id: JSON.stringify(["source", search.id, source.id]),
        kind: "source", record: linked, source, search, parentId: searchId,
        relationship: "returned", url: linked?.finalUrl ?? source.url,
        title: linked?.title ?? source.title ?? sourceHost(source.url),
      });
    }
    for (const record of retrievals.filter((r) => r.relatedSearchId === search.id && !consumed.has(r.id))) {
      consumed.add(record.id);
      items.push({ id: JSON.stringify(["operation", record.id]), kind: "source", record, search,
        parentId: searchId, relationship: "retrieval", url: record.finalUrl ?? record.requestedUrl,
        title: record.title ?? sourceHost(record.finalUrl ?? record.requestedUrl) });
    }
  }
  for (const record of retrievals.filter((r) => !consumed.has(r.id))) {
    items.push({ id: JSON.stringify(["operation", record.id]), kind: "source", record,
      relationship: "retrieval", url: record.finalUrl ?? record.requestedUrl,
      title: record.title ?? sourceHost(record.finalUrl ?? record.requestedUrl) });
  }
  return items;
}
export function findResearchItem(research, taskId, selectedId) {
  return researchItems(research, taskId).find((item) => item.id === selectedId);
}

// Append-only slots keep the reader's mental map intact while research streams in.
// Reflow is deliberate (Fit graph), rather than on every polling snapshot.
export function researchLayout(items, previous = new Map()) {
  const positions = new Map(previous);
  const roots = items.filter((item) => !item.parentId);
  let bottom = Math.max(0, ...[...positions.values()].map((p) => p.y + 172));
  if (!previous.size) {
    let actionTop = 20;
    let sourceTop = 20;
    for (const item of roots) {
      const children = items.filter((child) => child.parentId === item.id);
      const height = Math.max(152, children.length * 144 - 16);
      const y = children.length ? Math.max(actionTop, sourceTop + (height - 144) / 2) : actionTop;
      positions.set(item.id, { x: 246, y });
      children.forEach((child, i) => positions.set(child.id, { x: 538, y: sourceTop + i * 144 }));
      actionTop = y + 190;
      if (children.length) sourceTop += height + 36;
    }
  } else {
    for (const item of items) {
      if (positions.has(item.id)) continue;
      positions.set(item.id, { x: item.parentId ? 538 : 246, y: bottom });
      bottom += 172;
    }
  }
  const first = roots[0];
  positions.set("owner", { x: 10, y: first ? positions.get(first.id).y + 8 : 130 });
  return positions;
}
