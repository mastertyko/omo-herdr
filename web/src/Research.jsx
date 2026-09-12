import { useEffect, useMemo, useRef, useState } from "react";
import { ReactFlow, ReactFlowProvider, Background, BackgroundVariant, Handle, Position, BaseEdge, MarkerType, getBezierPath, useReactFlow } from "@xyflow/react";
import { BookOpen, MagnifyingGlass, Globe, ArrowSquareOut, ArrowLeft, ArrowsOut, MagnifyingGlassMinus, MagnifyingGlassPlus, CheckCircle, CircleNotch, WarningCircle, PauseCircle, Clock, FileText, Info, CaretRight, X } from "@phosphor-icons/react";
import { researchItems, researchLayout, taskResearch, hasResearchCoverage, sourceUrl, sourceHost, researchStates, findResearchItem } from "./research-graph.js";
import { statusWords } from "./agent-summary.js";
import { SourceIcon } from "./SourceIcon.jsx";
import "./research.css";

export { findResearchItem };
const stamp = (at) => at && Number.isFinite(Date.parse(at))
  ? new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "Not reported";
const stateName = (item) => item?.kind === "search" && item.record?.state === "requested"
  ? "Searching" : researchStates[item?.record?.state ?? "result"] ?? "Unknown";

function ResearchBadge({ item }) {
  const state = item?.record?.state ?? "result";
  const Icon = state === "requested" ? CircleNotch : state === "fetched" || state === "completed" ? CheckCircle : state === "failed" ? WarningCircle : state === "metadata-only" ? FileText : Globe;
  return <span className={`research-badge ${state}`}><Icon size={13} />{stateName(item)}</span>;
}

function ResearchOwnerBadge({ state }) {
  const knownState = Object.hasOwn(statusWords, state) ? state : "unknown";
  const Icon = knownState === "completed" ? CheckCircle : knownState === "running" ? CircleNotch
    : ["failed", "blocked"].includes(knownState) ? WarningCircle : PauseCircle;
  return <span className={`badge ${knownState}`}><Icon size={13} weight={knownState === "running" ? "bold" : "fill"} />{statusWords[knownState]}</span>;
}

export function ResearchSummary({ research, task, onOpen, compact = false }) {
  const records = taskResearch(research, task?.id);
  const searches = records.filter((r) => r.kind === "search").length;
  const fetched = records.filter((r) => r.state === "fetched").length;
  const covered = hasResearchCoverage(research, task?.id);
  return <button className={`research-summary ${compact ? "compact" : ""}`} onClick={onOpen}
    aria-label={`Open research trail for ${task?.agent ?? "agent"}`}>
    <BookOpen size={compact ? 15 : 21} />
    <span><strong>Research</strong>{!compact && <small>{!covered ? "History unavailable" : !records.length ? "No searches reported yet" : `${searches} ${searches === 1 ? "search" : "searches"} · ${fetched} fetched`}</small>}</span>
    {compact && <span className="research-count">{covered ? records.length : "—"}</span>}
    <CaretRight size={14} />
  </button>;
}

function ResearchNode({ data, selected }) {
  const { item, task } = data;
  const owner = !item;
  const Icon = owner ? BookOpen : item.kind === "search" ? MagnifyingGlass : Globe;
  return <div className={`research-card ${owner ? "owner-card" : `${item.kind}-card`} ${selected ? "chosen" : ""}`}>
    {!owner && <Handle type="target" position={Position.Left} />}
    <div className="research-card-head">{item?.kind === "source" ? <SourceIcon url={item.url} /> : <Icon size={25} />}<div>
      <strong title={owner ? task.agent : item.title}>{owner ? task.agent : item.kind === "search" ? "Search" : item.title}</strong>
      {owner ? <p title={task.label}>{task.label}</p> : item.kind === "search"
        ? <p className="research-query" title={item.title}>{item.title}</p>
        : <p title={item.url}>{sourceHost(item.url)}</p>}
    </div></div>
    {owner ? <ResearchOwnerBadge state={task.state} />
      : <ResearchBadge item={item} />}
    {item?.kind === "search" && <small className="research-card-time"><Clock size={13} />{stamp(item.record.startedAt ?? item.record.updatedAt)}{item.record.provider && <span>{item.record.provider}</span>}</small>}
    {(owner || item.kind === "search") && <Handle type="source" position={Position.Right} />}
  </div>;
}
function ResearchEdge(props) {
  const lead = 6, shaft = 14;
  const [curve] = getBezierPath({ ...props, sourceX: props.sourceX + lead, targetX: props.targetX - shaft });
  const path = `M${props.sourceX},${props.sourceY} L${props.sourceX + lead},${props.sourceY} ${curve.slice(curve.indexOf("C"))} L${props.targetX},${props.targetY}`;
  return <>
    <BaseEdge id={props.id} path={path} markerEnd={props.markerEnd} style={props.style} />
    {props.data.connected && props.data.active && <circle className="edge-flow" r="2.5" fill="#bbafff"><animateMotion path={path} dur="2.5s" repeatCount="indefinite" /></circle>}
    {props.data.connected && props.data.pulse > 0 && <circle key={props.data.pulse} className="edge-flow edge-complete" r="3.5" fill="#9cead6">
      <animateMotion path={path} dur="1.4s" fill="freeze" /><animate attributeName="opacity" values="0;1;1;0" dur="1.4s" fill="freeze" />
    </circle>}
  </>;
}
const nodeTypes = { research: ResearchNode };
const edgeTypes = { research: ResearchEdge };

function ResearchCanvas({ snapshot, task, selectedId, onSelect, onBack, connected, preview }) {
  const flow = useReactFlow();
  const panel = useRef(null);
  const slots = useRef(new Map());
  const initialized = useRef(false);
  const [layoutVersion, setLayoutVersion] = useState(0);
  const [filter, setFilter] = useState("all");
  const [pageSize, setPageSize] = useState(18);
  const [completion, setCompletion] = useState({ ids: [], seq: 0 });
  const previous = useRef(null);
  const items = useMemo(() => researchItems(snapshot.research, task.id), [snapshot.research, task.id]);
  const covered = hasResearchCoverage(snapshot.research, task.id);
  const searches = items.filter((i) => i.kind === "search");
  const roots = items.filter((i) => !i.parentId);
  const visibleRootIds = new Set(roots.slice(0, pageSize).map((item) => item.id));
  const shown = items.filter((item) => visibleRootIds.has(item.parentId ?? item.id))
    .filter((item) => filter !== "fetched" || item.kind === "search" || item.record?.state === "fetched");
  const structure = JSON.stringify(shown.map((item) => [item.id, item.parentId]));
  const positions = useMemo(() => {
    const retained = new Set(items.map((item) => item.id));
    const previousSlots = new Map([...slots.current].filter(([id]) => id === "owner" || retained.has(id)));
    slots.current = researchLayout(shown, previousSlots);
    return slots.current;
  }, [structure, layoutVersion]);
  const fit = (duration = 220) => flow.fitView({ padding: .09, duration: matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : duration, maxZoom: 1.05 });
  useEffect(() => {
    if (!shown.length || initialized.current) return;
    initialized.current = true;
    const timer = setTimeout(() => fit(0), 100);
    return () => clearTimeout(timer);
  }, [structure]);
  useEffect(() => {
    let timer;
    const observer = new ResizeObserver(() => { clearTimeout(timer); timer = setTimeout(() => fit(0), 100); });
    if (panel.current) observer.observe(panel.current);
    return () => { observer.disconnect(); clearTimeout(timer); };
  }, [flow]);
  useEffect(() => {
    const states = new Map(items.filter((i) => i.record).map((i) => [i.id, i.record.phase]));
    const prior = previous.current;
    previous.current = { states, connected };
    const ids = connected && prior?.connected ? [...states].filter(([id, phase]) => prior.states.get(id) === "started" && phase === "completed").map(([id]) => id) : [];
    if (ids.length) setCompletion((old) => ({ ids, seq: old.seq + 1 }));
    else if (!connected) setCompletion({ ids: [], seq: 0 });
  }, [items, connected]);
  useEffect(() => {
    if (!completion.ids.length) return;
    const timer = setTimeout(() => setCompletion((old) => ({ ...old, ids: [] })), 1500);
    return () => clearTimeout(timer);
  }, [completion]);

  const nodes = [{ id: "owner", type: "research", position: positions.get("owner"), data: { task }, selected: !selectedId,
    ariaLabel: `${task.agent}, research owner` }, ...shown.map((item) => ({
    id: item.id, type: "research", position: positions.get(item.id), data: { item }, selected: selectedId === item.id,
    ariaLabel: `${item.kind === "search" ? "Search" : "Source"}: ${item.title}, ${stateName(item)}`,
  }))];
  const edges = shown.map((item) => {
    const returned = item.relationship === "returned";
    const color = returned ? "#83b6ee" : item.kind === "source" ? "#72cbb9" : "#a397f5";
    return { id: `edge:${item.id}`, source: item.parentId ?? "owner", target: item.id, type: "research",
      ariaLabel: `${returned ? "Returned source" : item.kind === "search" ? "Search action" : "Retrieval action"}: ${item.title}`,
      markerEnd: { type: MarkerType.ArrowClosed, width: 15, height: 15, color },
      data: { connected, active: item.record?.phase === "started", pulse: completion.ids.includes(item.id) ? completion.seq : 0 },
      style: { stroke: color, strokeWidth: 1.6, strokeDasharray: returned ? "5 5" : undefined, strokeLinecap: "round", strokeLinejoin: "round" },
    };
  });
  const partial = snapshot.research?.status === "partial";
  return <section className="panel graph-panel research-panel">
    <div className="panel-heading"><div className="research-panel-title"><h2>Tasks & sources</h2><span>{task.agent}</span></div>
      <div className="graph-tools"><button className="research-back" onClick={onBack} title="Back to tasks"><ArrowLeft size={17} /><span>Back to tasks</span></button>
        <button className="icon-button" aria-label="Zoom out research" onClick={() => flow.zoomOut()}><MagnifyingGlassMinus size={20} /></button>
        <button className="icon-button" aria-label="Zoom in research" onClick={() => flow.zoomIn()}><MagnifyingGlassPlus size={20} /></button>
        <button className="icon-button" aria-label="Fit research graph" onClick={() => { slots.current = new Map(); setLayoutVersion((v) => v + 1); setTimeout(() => fit(), 60); }}><ArrowsOut size={19} /></button>
      </div>
    </div>
    {!!items.length && <div className="research-toolbar"><span>{searches.length} {searches.length === 1 ? "search" : "searches"} <i /> {items.filter((i) => i.record?.state === "fetched").length} fetched</span>
      <div className="research-filters" aria-label="Research filter"><button aria-pressed={filter === "all"} onClick={() => setFilter("all")}>All sources</button><button aria-pressed={filter === "fetched"} onClick={() => {
        setFilter("fetched");
        const selected = items.find((item) => item.id === selectedId);
        if (selected?.kind === "source" && selected.record?.state !== "fetched") onSelect(null);
      }}>Fetched only</button></div>
    </div>}
    <div className="canvas research-canvas" ref={panel}>
      {items.length ? <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
        onNodeClick={(_, node) => onSelect(node.id === "owner" ? null : node.id)} nodesDraggable={false} nodesConnectable={false}
        fitView fitViewOptions={{ padding: .09, maxZoom: 1.05 }} minZoom={.2} maxZoom={1.8}>
        <Background variant={BackgroundVariant.Lines} gap={36} color="#20303f" />
      </ReactFlow> : <div className="empty research-empty"><div className="research-empty-icon"><BookOpen size={36} /></div><h3>{covered ? "Research will appear here" : "Research history unavailable"}</h3>
        <p>{covered ? "Searches and fetched sources will connect to this agent as they are reported." : "This session does not report structured research for this agent yet. Its searches and source visits cannot be reconstructed from task status."}</p>
        <button onClick={onBack}><ArrowLeft size={16} />Back to tasks</button>
      </div>}
    </div>
    {roots.length > pageSize && <button className="research-load" onClick={() => { setPageSize((n) => n + 18); initialized.current = false; }}>Show more research · {roots.length - pageSize} remaining</button>}
    {covered && (partial || !preview) && <p className="research-coverage"><Info size={14} />{partial ? "Partial history" : "Captured during this session"}{snapshot.research?.omitted ? ` · ${snapshot.research.omitted} earlier operations omitted` : ""}{snapshot.research?.missingEvents ? " · Some updates are missing" : ""}</p>}
    <div className="graph-legend research-legend"><span><i className="action-line" />Research action</span><span><i className="result-line" />Search result</span><span className="research-legend-note">{preview ? "Demo data" : "Reported activity"}</span></div>
  </section>;
}
export function ResearchGraph(props) {
  return <ReactFlowProvider><ResearchCanvas {...props} /></ReactFlowProvider>;
}

export function ResearchInspector({ snapshot, task, selectedId, onSelect, onClose, open }) {
  const item = findResearchItem(snapshot.research, task.id, selectedId);
  if (!item) return null;
  const record = item.record;
  const search = item.kind === "search";
  const relatedItems = search ? researchItems(snapshot.research, task.id).filter((entry) => entry.parentId === item.id) : [];
  const returnedSources = relatedItems.filter((entry) => entry.relationship === "returned");
  const retrievals = relatedItems.filter((entry) => entry.record?.kind === "retrieval");
  const url = sourceUrl(item.url ?? record?.finalUrl ?? record?.requestedUrl);
  const Icon = search ? MagnifyingGlass : FileText;
  const evidence = search ? record.phase === "started" ? "A search was started. Results have not been reported yet." : record.phase === "failed" ? "The search failed. Any unreported results remain unknown." : "The search was reported by the research tool. Only explicitly reported sources are listed."
    : !record ? "Returned by a search. No fetch for this result has been reported."
    : record.state === "fetched" ? "Content was retrieved. Whether the agent read or used it is not reported."
    : record.state === "metadata-only" ? "Only response metadata was requested. Page content was not retrieved."
    : record.state === "requested" ? "A retrieval was requested. Its outcome has not been reported yet."
    : record.state === "failed" ? "The retrieval failed. This is not a successfully fetched source."
    : "The tool finished without enough evidence to confirm that page content was retrieved.";
  return <aside className={`inspector panel research-inspector ${open ? "open" : ""}`}>
    <button className="close-inspector" aria-label="Close research details" onClick={onClose}><X size={20} /></button>
    <div className="inspector-title">{search ? <Icon size={40} /> : <SourceIcon url={url} size="detail" />}<div><h2>{search ? "Search" : "Source"}</h2><p>{item.title}</p></div></div>
    <div className="research-inspector-heading">{search ? "Search details" : "Source details"}</div>
    <div className="inspector-body">
      <dl className="details"><div><dt>Status</dt><dd><ResearchBadge item={item} /></dd></div>
        <div><dt>Agent</dt><dd>{task.agent}</dd></div>
        {search ? <><div className="research-query-detail"><dt>Search query</dt><dd>{record.query ?? "Not reported"}</dd></div><div><dt>Provider</dt><dd>{record.provider ?? "Not reported"}</dd></div></>
          : <div><dt>Website</dt><dd>{sourceHost(item.url)}</dd></div>}
        <div><dt>{search ? "Started" : record?.state === "fetched" ? "Retrieved" : record ? "Updated" : "Returned"}</dt><dd><Clock size={15} />{stamp(search ? record.startedAt ?? record.updatedAt : record?.updatedAt ?? item.search?.updatedAt)}</dd></div>
        {record?.httpStatus && <div><dt>Response</dt><dd>HTTP {record.httpStatus}</dd></div>}
        {record?.contentType && <div><dt>Content type</dt><dd>{record.contentType}</dd></div>}
      </dl>
      {item.search && <section className="inspector-section"><h3><MagnifyingGlass size={20} />From search</h3><button className="research-origin" onClick={() => onSelect(JSON.stringify(["operation", item.search.id]))}>{item.search.query ?? "Search query not reported"}<CaretRight size={16} /></button></section>}
      {search && <section className="inspector-section"><h3><Globe size={20} />Returned sources <span className="subtle-count">{returnedSources.length}</span></h3>
        <div className="research-source-list">{returnedSources.map((entry) => <button key={entry.id} onClick={() => onSelect(entry.id)}><SourceIcon url={entry.url} size="list" /><span><strong>{entry.title}</strong><small>{sourceHost(entry.url)}</small></span><CaretRight size={14} /></button>)}</div>
        {!returnedSources.length && <p className="empty-copy">{record.phase === "started" ? "Waiting for reported results." : record.sourcesReported ? "No returned sources available to display." : "No structured result list was reported."}</p>}
        {record.omittedSources > 0 && <p className="empty-copy">{record.omittedSources} additional sources omitted.</p>}
      </section>}
      {retrievals.length > 0 && <section className="inspector-section"><h3><FileText size={20} />Related retrievals <span className="subtle-count">{retrievals.length}</span></h3>
        <div className="research-source-list">{retrievals.map((entry) => <button key={entry.id} onClick={() => onSelect(entry.id)}><SourceIcon url={entry.url} size="list" /><span><strong>{entry.title}</strong><small>{sourceHost(entry.url)}</small><small>{stateName(entry)} · {stamp(entry.record.updatedAt)}</small></span><CaretRight size={14} /></button>)}</div>
      </section>}
      <section className="inspector-section research-evidence"><h3><Info size={20} />Evidence</h3><p>{evidence}</p></section>
    </div>
    <footer className="inspector-footer">{url ? <a className="primary" href={url} target="_blank" rel="noopener noreferrer"><ArrowSquareOut size={20} />Open source</a>
      : <button className="primary" onClick={() => onSelect(null)}><ArrowLeft size={19} />Back to agent</button>}</footer>
  </aside>;
}
