import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Handle,
  Position,
  MarkerType,
  useReactFlow,
  BaseEdge,
  getBezierPath,
} from "@xyflow/react";
import dagre from "@dagrejs/dagre";
import {
  TreeStructure,
  Folder,
  CaretDown,
  CaretRight,
  Compass,
  HardDrives,
  Monitor,
  Flask,
  PuzzlePiece,
  Clock,
  Lightning,
  Info,
  Crosshair,
  MagnifyingGlassMinus,
  MagnifyingGlassPlus,
  CheckCircle,
  PauseCircle,
  WarningCircle,
  CircleNotch,
  ArrowSquareOut,
  ArrowsOut,
  X,
  WifiHigh,
  WifiSlash,
  BookOpen,
} from "@phosphor-icons/react";
import "@xyflow/react/dist/style.css";
import "@fontsource-variable/inter";
import { demo } from "./demo.js";
import { researchDemo } from "./research-demo.js";
import { statusWords as words, statusDescription, summarizeAgents } from "./agent-summary.js";
import {
  ResearchGraph,
  ResearchInspector,
  ResearchSummary,
  findResearchItem,
} from "./Research.jsx";

function RoleIcon({ name = "", ...props }) {
  const n = name.toLowerCase();
  const Icon = /librarian|research/.test(n)
    ? BookOpen
    : /test|qa/.test(n)
      ? Flask
      : /front|design|ui/.test(n)
        ? Monitor
        : /back|api/.test(n)
          ? HardDrives
          : /explor|kart/.test(n)
            ? Compass
            : /integra/.test(n)
              ? PuzzlePiece
              : TreeStructure;
  return <Icon weight="regular" {...props} />;
}
function Badge({ state }) {
  const Icon =
    state === "completed"
      ? CheckCircle
      : state === "running"
        ? CircleNotch
        : ["failed", "blocked"].includes(state)
          ? WarningCircle
          : PauseCircle;
  return (
    <span className={`badge ${state}`}>
      <Icon size={14} weight={state === "running" ? "bold" : "fill"} />
      {words[state] ?? words.unknown}
    </span>
  );
}
function elapsed(task, preview = false) {
  if (preview)
    return task?.id === "st_backend"
      ? "2m 14s"
      : task?.id === "st_frontend"
        ? "1m 3s"
        : task?.state === "completed"
          ? "4m 12s"
          : "0m 0s";
  if (!task?.startedAt) return "—";
  const seconds = Math.max(
    0,
    Math.floor(
      ((task.completedAt ? Date.parse(task.completedAt) : Date.now()) -
        Date.parse(task.startedAt)) /
        1000,
    ),
  );
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
function time(at) {
  return new Date(at).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
function hasResearch(research, task) {
  return !!task && (
    /librarian/i.test(task.agent) ||
    research?.taskIds?.includes(task.id) ||
    research?.records?.some((record) => record.taskId === task.id)
  );
}
function TaskNode({ data, selected }) {
  return (
    <div className={`task-card ${data.compact ? "compact-card" : ""} ${selected ? "chosen" : ""}`}>
      <Handle type="target" position={Position.Left} />
      <Handle type="target" id="top" position={Position.Top} />
      <div className="card-heading">
        <RoleIcon name={data.task?.agent ?? data.node.label} size={29} />
        <div>
          <strong title={data.node.label}>{data.node.label}</strong>
          <span title={data.task?.agent ?? "Unassigned"}>{data.task?.agent ?? "Unassigned"}</span>
        </div>
      </div>
      <Badge state={data.node.state} />
      {data.research ? (
        <button
          className="task-research-button nodrag nopan"
          aria-label={`Open research trail for ${data.task.agent}`}
          onClick={(event) => {
            event.stopPropagation();
            data.onResearch(data.task.id);
          }}
        >
          <BookOpen size={15} />
          Research trail
          <CaretRight size={12} />
        </button>
      ) : (
        <small>{elapsed(data.task ?? data.node, data.preview)}</small>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
const nodeTypes = { task: TaskNode };
function FlowEdge(props) {
  // Leave a straight shaft behind the arrowhead, aligned with its centre.
  // A shared straight lead-out also keeps branching edges clean at the source.
  const lead = 6;
  const shaft = 14;
  const targetTop = props.targetPosition === Position.Top;
  const curveStartX = props.sourceX + lead;
  const curveEndX = props.targetX - (targetTop ? 0 : shaft);
  const curveEndY = props.targetY - (targetTop ? shaft : 0);
  const [curve] = getBezierPath({
    ...props,
    sourceX: curveStartX,
    targetX: curveEndX,
    targetY: curveEndY,
  });
  const path = `M${props.sourceX},${props.sourceY} L${curveStartX},${props.sourceY} ${curve.slice(curve.indexOf("C"))} L${props.targetX},${props.targetY}`;
  const { active, pulse, connected } = props.data;
  return (
    <>
      <BaseEdge id={props.id} path={path} markerEnd={props.markerEnd} style={props.style} />
      {connected && active && (
        <g className="edge-flow" aria-hidden="true">
          <circle r="3" fill="#91dfff">
            <animateMotion path={path} dur="2.8s" repeatCount="indefinite" />
          </circle>
          <circle r="2" fill="#91dfff" opacity="0.5">
            <animateMotion path={path} dur="2.8s" begin="-1.4s" repeatCount="indefinite" />
          </circle>
        </g>
      )}
      {connected && pulse > 0 && (
        <circle key={pulse} className="edge-flow edge-complete" r="4" fill="#9cf3c6" aria-hidden="true">
          <animateMotion path={path} dur="1.6s" fill="freeze" />
          <animate attributeName="opacity" values="0;1;1;0" dur="1.6s" fill="freeze" />
        </circle>
      )}
    </>
  );
}
const edgeTypes = { flow: FlowEdge };
function Graph({ snapshot, run, selected, onSelect, onResearch, preview, connected }) {
  const flow = useReactFlow();
  const canvasRef = useRef(null);
  const [canvasWidth, setCanvasWidth] = useState(800);
  const source = useMemo(
    () =>
      run ?? {
        nodes: snapshot.tasks.map((t) => ({
          id: t.id,
          label: t.label,
          state: t.state,
          taskId: t.id,
        })),
        edges: [],
      },
    [run, snapshot.tasks],
  );
  const previousStates = useRef(null);
  const [completion, setCompletion] = useState({ ids: [], sequence: 0 });
  const context = JSON.stringify([snapshot.session.id, run?.id]);
  useEffect(() => {
    const previous = previousStates.current;
    const states = new Map(source.nodes.map((n) => [n.id, n.state]));
    previousStates.current = { context, states, connected };
    if (!connected || previous?.context !== context) {
      setCompletion({ ids: [], sequence: 0 });
      return;
    }
    const ids = source.nodes.filter((n) =>
      previous.connected && previous.states.has(n.id) &&
      previous.states.get(n.id) !== "completed" && n.state === "completed"
    ).map((n) => n.id);
    if (ids.length) setCompletion((value) => ({ ids, sequence: value.sequence + 1 }));
  }, [source, context, connected]);
  useEffect(() => {
    if (!completion.ids.length) return;
    const timer = setTimeout(() => setCompletion((value) => ({ ...value, ids: [] })), 1800);
    return () => clearTimeout(timer);
  }, [completion]);
  const structure = JSON.stringify([
    source.nodes.map((n) => n.id),
    source.edges,
  ]);
  const compact = source.nodes.length > 0 && source.nodes.length <= 3;
  const cardWidth = compact ? 248 : 164;
  const cardHeight = compact ? 188 : 132;
  const columns = compact ? Math.max(1, Math.min(source.nodes.length, Math.floor((canvasWidth / 0.8 - 48 + 36) / (cardWidth + 36)))) : 3;
  const rows = Math.ceil(source.nodes.length / columns);
  const positions = useMemo(() => {
    if (!source.edges.length)
      return Object.fromEntries(
        source.nodes.map((n, i) => [
          n.id,
          { x: (i % columns) * (cardWidth + (compact ? 36 : 48)), y: Math.floor(i / columns) * (cardHeight + (compact ? 32 : 46)) },
        ]),
      );
    if (!compact && preview && source.nodes.every((n) => ["explore", "api", "ui", "test", "integration"].includes(n.id)))
      return {
        explore: { x: 0, y: 115 },
        api: { x: 202, y: 12 },
        ui: { x: 218, y: 230 },
        test: { x: 450, y: 18 },
        integration: { x: 576, y: 174 },
      };
    const g = new dagre.graphlib.Graph()
      .setGraph({
        rankdir: "LR",
        ranksep: 65,
        nodesep: 48,
        marginx: 20,
        marginy: 20,
      })
      .setDefaultEdgeLabel(() => ({}));
    source.nodes.forEach((n) => g.setNode(n.id, { width: cardWidth, height: cardHeight }));
    source.edges.forEach((e) => g.setEdge(e.from, e.to));
    dagre.layout(g);
    return Object.fromEntries(
      source.nodes.map((n) => [
        n.id,
        { x: g.node(n.id).x - cardWidth / 2, y: g.node(n.id).y - cardHeight / 2 },
      ]),
    );
  }, [structure, preview, compact, cardWidth, cardHeight, columns]);
  const nodes = source.nodes.map((n) => ({
    id: n.id,
    type: "task",
    position: positions[n.id],
    data: {
      node: n,
      task: snapshot.tasks.find((t) => t.id === n.taskId),
      preview,
      compact,
      research: snapshot.research?.records?.some((record) => record.taskId === n.taskId),
      onResearch,
    },
    selected: selected === (n.taskId ?? `node:${n.id}`),
    ariaLabel: `${n.label}, ${words[n.state]}`,
  }));
  const edges = source.edges.map((e) => ({
    id: JSON.stringify([snapshot.session.id, run?.id, e.from, e.to]),
    source: e.from,
    target: e.to,
    targetHandle:
      positions[e.from].x + cardWidth > positions[e.to].x &&
      positions[e.from].y < positions[e.to].y
        ? "top"
        : undefined,
    type: "flow",
    data: {
      connected,
      pulse: completion.ids.includes(e.from) ? completion.sequence : 0,
      active:
        source.nodes.find((n) => n.id === e.from)?.state === "completed" &&
        source.nodes.find((n) => n.id === e.to)?.state === "running",
    },
    markerEnd: {
      type: MarkerType.ArrowClosed,
      color: "#a8bce0",
      width: 17,
      height: 17,
    },
    style: {
      stroke: "#a8bce0",
      strokeWidth: 1.5,
      strokeLinecap: "round",
      strokeLinejoin: "round",
    },
  }));
  useEffect(() => {
    let timer;
    const fit = () => {
      if (canvasRef.current) setCanvasWidth(canvasRef.current.clientWidth);
      clearTimeout(timer);
      timer = setTimeout(
        () => flow.fitView({ padding: compact ? 0.12 : 0.05, maxZoom: compact ? 1 : 1.8, duration: 0 }),
        120,
      );
    };
    const observer = new ResizeObserver(fit);
    if (canvasRef.current) observer.observe(canvasRef.current);
    fit();
    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, [structure, flow, compact, columns]);
  const focus = () => {
    const active = nodes.filter((n) => n.data.node.state === "running");
    flow.fitView({
      nodes: active.length ? active : nodes,
      padding: 0.2,
      maxZoom: compact ? 1 : 1.8,
      duration: 300,
    });
  };
  return (
    <section className={`graph-panel panel ${compact ? "compact-graph" : ""}`} style={compact ? { "--compact-height": `${Math.min(580, 110 + (source.edges.length ? cardHeight + 96 : rows * (cardHeight + 32) + 40))}px` } : undefined}>
      <div className="panel-heading">
        <h2>{run ? "Tasks & dependencies" : "Tasks"}</h2>
        <div className="graph-tools">
          <button onClick={focus} title="Focus running tasks">
            <Crosshair size={19} />
            <span>Focus active</span>
          </button>
          <button
            className="icon-button"
            aria-label="Zoom out"
            onClick={() => flow.zoomOut()}
          >
            <MagnifyingGlassMinus size={20} />
          </button>
          <button
            className="icon-button"
            aria-label="Zoom in"
            onClick={() => flow.zoomIn()}
          >
            <MagnifyingGlassPlus size={20} />
          </button>
          <button
            className="icon-button fit"
            aria-label="Fit graph"
            onClick={() => flow.fitView({ padding: 0.1, maxZoom: compact ? 1 : 1.8, duration: 300 })}
          >
            <ArrowsOut size={19} />
          </button>
        </div>
      </div>
      <div className="canvas" ref={canvasRef}>
        {nodes.length ? (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodeClick={(_, n) =>
              onSelect(n.data.node.taskId ?? `node:${n.id}`)
            }
            nodesDraggable={false}
            nodesConnectable={false}
            fitView
            fitViewOptions={{ padding: compact ? 0.12 : 0.05, maxZoom: compact ? 1 : 1.8 }}
            minZoom={0.15}
            maxZoom={1.8}
            proOptions={{ hideAttribution: false }}
          >
            <Background
              variant={BackgroundVariant.Lines}
              gap={36}
              color="#1c2a37"
            />
          </ReactFlow>
        ) : (
          <div className="empty">
            <TreeStructure size={40} />
            <h3>Your work takes shape here</h3>
            <p>Agent tasks appear when OmO sends its next update.</p>
          </div>
        )}
      </div>
      <div className="graph-legend">
        <Info size={18} />
        {run
          ? "Arrows show dependencies · Light dots indicate active steps"
          : "No DAG dependencies reported. Tasks are shown independently."}
      </div>
    </section>
  );
}
function ActivityList({ items, tasks, onSelect, limit }) {
  return items.length ? (
    <div className="activity-list">
      {items.slice(0, limit ?? 80).map((a) => (
        <button
          key={a.id}
          onClick={() => a.taskId && onSelect(a.taskId)}
          disabled={!a.taskId}
        >
          <time dateTime={a.at} title={`Observed ${new Date(a.at).toLocaleString("en-GB")}${a.sourceAt ? ` · Source time ${new Date(a.sourceAt).toLocaleString("en-GB")}` : ""}`}>{time(a.at)}</time>
          <span className={`activity-symbol ${a.state ?? "unknown"}`} title={a.state ? `${words[a.state] ?? words.unknown} when observed` : undefined}>
            <RoleIcon name={a.agent ?? tasks.find((t) => t.id === a.taskId)?.agent} size={21} />
          </span>
          <span className="activity-copy">
            <strong>{a.action ?? a.label}</strong>
            {a.action && <small>{a.agent && a.taskLabel ? `${a.agent} · ${a.taskLabel}` : a.label}</small>}
          </span>
        </button>
      ))}
    </div>
  ) : (
    <p className="muted empty-copy">No activity reported yet.</p>
  );
}
function Overview({ snapshot, preview, connection, initialTrail = false }) {
  const initialTask = preview
    ? (snapshot.tasks.find((task) => /librarian/i.test(task.agent))?.id ?? "st_backend")
    : "root";
  const [selected, setSelected] = useState(initialTask);
  const [researchTaskId, setResearchTaskId] = useState(initialTrail ? initialTask : null);
  const [selectedResearchId, setSelectedResearchId] = useState(null);
  const [collapsed, setCollapsed] = useState(new Set());
  const [tab, setTab] = useState("Details");
  const [view, setView] = useState("Overview");
  const [runId, setRunId] = useState("");
  const [query, setQuery] = useState("");
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const runs = snapshot.runs;
  const run =
    runId === "standalone"
      ? undefined
      : (runs.find((r) => r.id === runId) ?? runs[0]);
  const task = snapshot.tasks.find((t) => t.id === selected);
  const researchTask = snapshot.tasks.find((t) => t.id === researchTaskId);
  const selectedResearchItem = researchTask && selectedResearchId
    ? findResearchItem(snapshot.research, researchTaskId, selectedResearchId)
    : null;
  const node = selected.startsWith("node:")
    ? run?.nodes.find((n) => `node:${n.id}` === selected)
    : !task
      ? run?.nodes.find((n) => n.taskId === selected)
      : undefined;
  const selectedRoot = selected === "root";
  const title = selectedRoot
    ? preview
      ? "Sisyphus"
      : "Main agent"
    : (task?.agent ?? node?.label ?? "Select an agent");
  const state = selectedRoot
    ? snapshot.session.state
    : (task?.state ?? node?.state ?? "unknown");
  const children = snapshot.tasks.filter(
    (t) => t.parentTaskId === task?.id && !!task,
  );
  const parent = snapshot.tasks.find((t) => t.id === task?.parentTaskId);
  const graphNode = run?.nodes.find((n) => n.taskId === task?.id && task);
  const dependencies =
    run?.edges
      .filter((e) => e.to === (graphNode?.id ?? node?.id))
      .map((e) => run.nodes.find((n) => n.id === e.from))
      .filter(Boolean) ?? [];
  const waiting = dependencies.filter((n) => n.state !== "completed");
  const ownActivity = selectedRoot
    ? snapshot.activity
    : snapshot.activity.filter((a) => a.taskId === task?.id && task);
  const choose = useCallback((id) => {
    setResearchTaskId(null);
    setSelectedResearchId(null);
    setSelected(id);
    setTab("Details");
    setInspectorOpen(true);
  }, []);
  const openResearch = useCallback((id) => {
    setSelected(id);
    setResearchTaskId(id);
    setSelectedResearchId(null);
    setTab("Details");
    setView("Overview");
    setInspectorOpen(false);
  }, []);
  const selectResearch = useCallback((id) => {
    setSelectedResearchId(id);
    setTab("Details");
    setInspectorOpen(true);
  }, []);
  const backToTasks = useCallback(() => {
    setResearchTaskId(null);
    setSelectedResearchId(null);
  }, []);
  const changeView = (nextView) => {
    setView(nextView);
    if (nextView !== "Overview") backToTasks();
  };
  const toggle = (id) =>
    setCollapsed((old) => {
      const next = new Set(old);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  useEffect(() => {
    if (selected !== "root" && !task && !node) setSelected("root");
  }, [selected, task, node]);
  useEffect(() => {
    if (researchTaskId && !researchTask) {
      setResearchTaskId(null);
      setSelectedResearchId(null);
    } else if (selectedResearchId && !selectedResearchItem) {
      setSelectedResearchId(null);
    }
  }, [researchTask, researchTaskId, selectedResearchId, selectedResearchItem]);
  const activeRunId = run?.id ?? "standalone";
  const previousRunId = useRef(activeRunId);
  useEffect(() => {
    if (previousRunId.current !== activeRunId) backToTasks();
    previousRunId.current = activeRunId;
  }, [activeRunId, backToTasks]);
  const summary = summarizeAgents(snapshot.session, snapshot.tasks);
  const graphSize = run?.nodes.length ?? snapshot.tasks.length;
  const smallGraph = graphSize > 0 && graphSize <= 3;
  const search = query.trim().toLowerCase();
  const visibleTasks = useMemo(() => {
    if (!search) return null;
    const tasksById = new Map(snapshot.tasks.map((t) => [t.id, t]));
    const visible = new Set();
    for (const task of snapshot.tasks) {
      if (!`${task.agent} ${task.label}`.toLowerCase().includes(search)) continue;
      let current = task;
      while (current && !visible.has(current.id)) {
        visible.add(current.id);
        current = tasksById.get(current.parentTaskId);
      }
    }
    return visible;
  }, [snapshot.tasks, search]);
  function rows(parentId, depth = 0, visited = new Set()) {
    if (depth > 32) return null;
    return snapshot.tasks
      .filter((t) => t.parentTaskId === parentId && !visited.has(t.id))
      .map((t) => {
        const hasChildren = snapshot.tasks.some((c) => c.parentTaskId === t.id);
        const hidden = visibleTasks && !visibleTasks.has(t.id);
        const expanded = !!search || !collapsed.has(t.id);
        const next = new Set(visited).add(t.id);
        return (
          <div className="tree-group" key={t.id}>
            {!hidden && (
              <div
                className={`agent-row ${selected === t.id ? "selected" : ""}`}
                style={{ "--depth": depth + 1 }}
              >
                {hasChildren ? (
                  <button
                    className="disclosure"
                    aria-label={`${expanded ? "Hide" : "Show"} sub-agents of ${t.agent}`}
                    aria-expanded={expanded}
                    disabled={!!search}
                    onClick={() => toggle(t.id)}
                  >
                    {expanded ? <CaretDown /> : <CaretRight />}
                  </button>
                ) : (
                  <CaretRight size={12} className="branch-tip" />
                )}
                <button className="agent-select" onClick={() => choose(t.id)}>
                  <RoleIcon name={t.agent} size={30} />
                  <span className="agent-name">
                    <strong>{t.agent}</strong>
                    <small title={t.label}>{t.label}</small>
                  </span>
                  <Badge state={t.state} />
                </button>
              </div>
            )}
            {!hidden && hasResearch(snapshot.research, t) && (
              <div className="agent-research-summary" style={{ "--depth": depth + 1 }}>
                <ResearchSummary
                  research={snapshot.research}
                  task={t}
                  onOpen={() => openResearch(t.id)}
                  compact
                />
              </div>
            )}
            {!hidden && expanded && rows(t.id, depth + 1, next)}
          </div>
        );
      });
  }
  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <TreeStructure size={30} />
          <strong>omo-herdr</strong>
        </div>
        <div className="project">
          <Folder size={20} weight="fill" />
          <span>{snapshot.session.project}</span>
        </div>
        <nav aria-label="Main view">
          {["Overview", "Activity"].map((v) => (
            <button
              className={view === v ? "active" : ""}
              key={v}
              onClick={() => changeView(v)}
            >
              {v}
            </button>
          ))}
        </nav>
        <span
          className={`connection ${connection}`}
          title={
            connection === "live"
              ? "Connected to the local session"
              : "Showing the last received information"
          }
        >
          {preview ? (
            <>
              <span className="pill">DEMO DATA</span>
            </>
          ) : connection === "live" ? (
            <>
              <WifiHigh size={16} />
              Connected
            </>
          ) : (
            <>
              <WifiSlash size={16} />
              {connection === "loading" ? "Connecting…" : "Disconnected"}
            </>
          )}
        </span>
      </header>
      {!preview && connection === "offline" && (
        <div className="connection-banner" role="status">
          Connection lost. Showing the last received data. Reconnecting
          automatically.
        </div>
      )}
      <div className={`workspace ${researchTask ? "research-workspace" : smallGraph ? "small-workspace" : ""}`}>
        <aside className="agents panel">
          <div className="panel-heading">
            <h2>Agents</h2>
            <span className="subtle-count" title="Main agent and all reported task agents">{summary.total}</span>
          </div>
          {(snapshot.tasks.length > 8 || query) && (
            <input
              className="search"
              placeholder="Search agents or tasks"
              aria-label="Search agents or tasks"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          )}
          <div className="agent-tree">
            <div
              className={`agent-row root-row ${selectedRoot ? "selected" : ""}`}
            >
              <button
                className="disclosure"
                aria-label="Expand or collapse the agent tree"
                aria-expanded={!!search || !collapsed.has("root")}
                disabled={!!search}
                onClick={() => toggle("root")}
              >
                {!search && collapsed.has("root") ? <CaretRight /> : <CaretDown />}
              </button>
              <button className="agent-select" onClick={() => choose("root")}>
                <TreeStructure size={34} />
                <span className="agent-name">
                  <strong>{preview ? "Sisyphus" : "Main agent"}</strong>
                  <small>
                    {preview ? "Coordinating" : words[snapshot.session.state]}
                  </small>
                </span>
              </button>
            </div>
            {(search || !collapsed.has("root")) && rows(undefined)}
            {visibleTasks?.size === 0 && <p className="empty-copy" role="status">No matching agents or tasks.</p>}
          </div>
          <div className="tree-summary" aria-label="Status of all agents in this session">
            <div className="summary-heading"><strong>All agents</strong><span>{summary.total} total</span></div>
            <div className="summary-counts">
              {summary.items.map(({ state, count, label }) => (
                <span className={`summary-count ${state}`} key={state}><i aria-hidden="true" /><b>{count}</b> {label}</span>
              ))}
            </div>
          </div>
        </aside>
        <main className="main-content">
          <div className="run-heading">
            <h1>{researchTask ? "Research trail" : snapshot.session.title}</h1>
            {preview && <span className="pill">DEMO DATA</span>}
            {!preview && runs.length > 0 && (
              <select
                aria-label="Select workflow"
                value={run?.id ?? "standalone"}
                onChange={(e) => {
                  setRunId(e.target.value);
                  backToTasks();
                  setSelected("root");
                  setTab("Details");
                  setInspectorOpen(false);
                }}
              >
                <option value="standalone">All tasks</option>
                {runs.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            )}
          </div>
          {snapshot.omitted > 0 && (
            <div className="notice">
              <Info size={16} />
              {snapshot.omitted} items are omitted from this bounded overview.
            </div>
          )}
          {view === "Overview" ? (
            <>
              {researchTask ? (
                <ResearchGraph
                  key={researchTaskId}
                  snapshot={snapshot}
                  task={researchTask}
                  selectedId={selectedResearchId}
                  onSelect={selectResearch}
                  onBack={backToTasks}
                  preview={preview}
                  connected={preview || connection === "live"}
                />
              ) : (
                <ReactFlowProvider>
                <Graph
                  snapshot={snapshot}
                  run={run}
                  selected={selected}
                  onSelect={choose}
                  onResearch={openResearch}
                  preview={preview}
                  connected={preview || connection === "live"}
                />
                </ReactFlowProvider>
              )}
              <section className="activity-panel panel">
                <div className="panel-heading">
                  <h3>
                    <Lightning size={22} />
                    Recent activity
                  </h3>
                  <button
                    className="text-button"
                    onClick={() => changeView("Activity")}
                  >
                    Show all
                  </button>
                </div>
                <ActivityList
                  items={researchTask ? snapshot.activity.filter((item) => item.taskId === researchTaskId) : snapshot.activity}
                  tasks={snapshot.tasks}
                  onSelect={choose}
                  limit={!researchTask && (run?.nodes.length ?? snapshot.tasks.length) <= 3 ? 4 : 2}
                />
              </section>
            </>
          ) : (
            <section className="activity-full panel">
              <div className="panel-heading">
                <h2>Session activity</h2>
                <span className="pill">{snapshot.activity.length} events</span>
              </div>
              <ActivityList
                items={snapshot.activity}
                tasks={snapshot.tasks}
                onSelect={(id) => {
                  choose(id);
                  setView("Overview");
                }}
              />
            </section>
          )}
        </main>
        {selectedResearchItem ? (
          <ResearchInspector
            snapshot={snapshot}
            task={researchTask}
            selectedId={selectedResearchId}
            onSelect={selectResearch}
            onClose={() => setInspectorOpen(false)}
            open={inspectorOpen}
          />
        ) : (
        <aside className={`inspector panel ${inspectorOpen ? "open" : ""}`}>
          <button
            className="close-inspector"
            aria-label="Close details"
            onClick={() => setInspectorOpen(false)}
          >
            <X size={20} />
          </button>
          <div className="inspector-title">
            <RoleIcon name={title} size={43} />
            <div>
              <h2>{title}</h2>
              <p>
                {selectedRoot
                  ? "Active OmO session"
                  : task
                    ? `Sub-agent of ${parent?.agent ?? (preview ? "Sisyphus" : "main agent")}`
                    : "Workflow task"}
              </p>
            </div>
          </div>
          <div
            className="inspector-tabs"
            role="tablist"
            aria-label="Agent information"
          >
            {["Details", "Activity", "Summary"].map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={tab === t}
                className={tab === t ? "active" : ""}
                onClick={() => setTab(t)}
              >
                {t}
              </button>
            ))}
          </div>
          <div className="inspector-body">
            {tab === "Details" ? (
              <>
                <dl className="details">
                  <div>
                    <dt>Status</dt>
                    <dd>
                      <Badge state={state} />
                    </dd>
                  </div>
                  <div>
                    <dt>{selectedRoot ? "Session" : "Task"}</dt>
                    <dd>
                      {selectedRoot
                        ? snapshot.session.title
                        : (task?.label ?? node?.label ?? "—")}
                    </dd>
                  </div>
                  <div>
                    <dt>Current activity</dt>
                    <dd>
                      {task?.activity ??
                        (selectedRoot
                          ? snapshot.session.activity
                          : undefined) ??
                        (waiting.length
                          ? `Waiting for ${waiting.map((n) => n.label).join(", ")}`
                          : state === "running"
                            ? "Working · no tool reported"
                            : state === "unknown"
                              ? "Activity unavailable"
                              : `${words[state]} · no active tool reported`)}
                    </dd>
                  </div>
                  {!selectedRoot && <div>
                    <dt>Elapsed time</dt>
                    <dd>
                      <Clock size={18} />
                      {elapsed(task ?? node, preview)}
                    </dd>
                  </div>}
                  {task && <div><dt>Task ID</dt><dd className="task-identifier">{task.id}</dd></div>}
                </dl>
                {hasResearch(snapshot.research, task) && (
                  <section className="inspector-section">
                    <h3><BookOpen size={24} /> Research trail</h3>
                    <ResearchSummary
                      research={snapshot.research}
                      task={task}
                      onOpen={() => openResearch(task.id)}
                    />
                  </section>
                )}
                {children.length > 0 && (
                  <section className="inspector-section">
                    <h3>
                      <TreeStructure size={24} />
                      Sub-agents
                    </h3>
                    {children.map((t) => (
                      <button
                        key={t.id}
                        className="child-card"
                        onClick={() => choose(t.id)}
                      >
                        <RoleIcon name={t.agent} size={32} />
                        <span>
                          <strong>{t.agent}</strong>
                          <small>{t.label}</small>
                        </span>
                        <Badge state={t.state} />
                      </button>
                    ))}
                  </section>
                )}
                {waiting.length > 0 && (
                  <section className="inspector-section">
                    <h3>
                      <PuzzlePiece size={22} />
                      Dependencies
                    </h3>
                    {dependencies.map((n) => (
                      <button
                        className="dependency-row"
                        key={n.id}
                        onClick={() => choose(n.taskId ?? `node:${n.id}`)}
                      >
                        <span>{n.label}</span>
                        <Badge state={n.state} />
                      </button>
                    ))}
                  </section>
                )}
                <section className="inspector-section">
                  <h3>
                    <Clock size={24} />
                    Recent activity
                  </h3>
                  <ActivityList
                    items={ownActivity}
                    tasks={snapshot.tasks}
                    onSelect={choose}
                    limit={3}
                  />
                </section>
              </>
            ) : tab === "Activity" ? (
              <>
                <h3>Reported activity</h3>
                <ActivityList
                  items={ownActivity}
                  tasks={snapshot.tasks}
                  onSelect={choose}
                />
              </>
            ) : (
              <div className="summary-content">
                <div className="summary-status"><Info size={22} /><span>Reported {selectedRoot ? "session" : "task"} status</span><Badge state={state} /></div>
                <h3>{selectedRoot ? snapshot.session.title : (task?.label ?? node?.label ?? "Task summary")}</h3>
                <p>{statusDescription(state, selectedRoot ? "session" : "task")}</p>
                <div className="summary-note"><BookOpen size={20} /><p>Full responses and any test evidence stay in the OmO session. Completion alone does not verify the result.</p></div>
                {(task?.model ?? snapshot.session.model) && (
                  <p className="summary-model">
                    Model:{" "}
                    <strong>{task?.model ?? snapshot.session.model}</strong>
                  </p>
                )}
              </div>
            )}
          </div>
          <footer className="inspector-footer">
            <button
              className="primary"
              onClick={() =>
                setTab(tab === "Activity" ? "Details" : "Activity")
              }
            >
              <ArrowSquareOut size={22} />
              {tab === "Activity" ? "View details" : "View activity"}
            </button>
          </footer>
        </aside>
        )}
      </div>
    </div>
  );
}
export function App() {
  const parameters = new URLSearchParams(location.search);
  const preview = parameters.get("demo") === "1";
  const researchPreview = preview && parameters.get("scene") === "research";
  const initialTrail = researchPreview && parameters.get("trail") === "1";
  const [snapshot, setSnapshot] = useState(preview ? (researchPreview ? researchDemo : demo) : null);
  const [connection, setConnection] = useState(preview ? "demo" : "loading");
  const [reason, setReason] = useState("");
  useEffect(() => {
    if (preview) return;
    let stopped = false;
    let timer;
    const controller = new AbortController();
    const hash = location.hash.slice(1);
    if (/^[a-f0-9]{64}$/.test(hash)) {
      sessionStorage.setItem("omo-herdr-token", hash);
      history.replaceState(null, "", location.pathname + location.search);
    }
    const token = sessionStorage.getItem("omo-herdr-token");
    if (!token) {
      setConnection("offline");
      setReason("Open this view with /herdr web in your OmO session.");
      return;
    }
    async function poll() {
      try {
        const response = await fetch("/api/snapshot", {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(5000),
          ]),
          cache: "no-store",
        });
        if (!response.ok)
          throw new Error(
            response.status === 401
              ? "This session link has expired. Run /herdr web again."
              : "Could not connect to the session.",
          );
        const next = await response.json();
        if (
          next.schemaVersion !== 1 ||
          !Array.isArray(next.tasks) ||
          !Array.isArray(next.runs)
        )
          throw new Error("Unsupported snapshot format.");
        if (!stopped) {
          setSnapshot(next);
          setConnection("live");
          setReason("");
        }
      } catch (error) {
        if (!stopped) {
          setConnection("offline");
          setReason(error.message);
        }
      } finally {
        if (!stopped) timer = setTimeout(poll, 1500);
      }
    }
    poll();
    return () => {
      stopped = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [preview]);
  if (!snapshot)
    return (
      <div className="welcome">
        <TreeStructure size={52} />
        <h1>omo-herdr</h1>
        <h2>
          {connection === "loading"
            ? "Connecting to your session…"
            : "Your agent overview"}
        </h2>
        <p>{reason || "Loading reported work from OmO."}</p>
        {connection !== "loading" && (
          <a className="primary" href="?demo=1">
            Explore demo data
          </a>
        )}
      </div>
    );
  return (
    <Overview key={snapshot.session.id} snapshot={snapshot} preview={preview} connection={connection} initialTrail={initialTrail} />
  );
}
