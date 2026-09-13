import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { watch } from "node:fs";
import type { ExtensionAPI, ExtensionContext, RegisteredCommand } from "@code-yeongyu/senpi";
import omoHerdr from "../src/index.ts";

type Handler = (event: object, ctx: ExtensionContext) => unknown;
function field(args: string[], key: string) { const index = args.indexOf(key); return index < 0 ? undefined : args[index + 1]; }

test("session changes, tool concurrency, compaction, metadata cleanup and doctor use the public API", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omo-herdr-features-"));
  const log = join(directory, "calls.jsonl");
  const original = { ...process.env };
  const bin = new URL("./fixtures/herdr-cli.mjs", import.meta.url).pathname;
  await chmod(bin, 0o755);
  Object.assign(process.env, {HERDR_ENV:"1",HERDR_BIN_PATH:bin,HERDR_SOCKET_PATH:join(directory,"socket"),HERDR_PANE_ID:"w1:p1",OMO_HERDR_TEST_LOG:log});
  delete process.env.OMO_HERDR_OWNER_PID;
  delete process.env.OMO_HERDR_METADATA;
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, Omit<RegisteredCommand,"name"|"sourceInfo">>();
  const notifications: string[] = [];
  let id = "first";
  let name: string | undefined = "First session";
  let context = {tokens:420,percent:42,contextWindow:1000};
  const ctx = {cwd:directory,mode:"tui",hasUI:true,isIdle:()=>true,hasPendingMessages:()=>false,
    sessionManager:{getSessionId:()=>id,getSessionFile:()=>`/tmp/${id}.jsonl`,getSessionName:()=>name},
    model:{provider:"test",id:"first-model"},getContextUsage:()=>context,
    ui:{notify:(message:string)=>notifications.push(message)},
  } as unknown as ExtensionContext;
  const emit = async (event: string, payload = {}) => { await handlers.get(event)?.(payload,ctx); };
  const calls = async (): Promise<string[][]> => {
    try {return (await readFile(log,"utf8")).trim().split("\n").filter(Boolean).map(line=>JSON.parse(line));}
    catch (e) {if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];throw e;}
  };
  const last = async (command: string) => (await calls()).filter(args=>args[1]===command).at(-1)!;
  const observe = (predicate: () => Promise<boolean>, action: () => Promise<void>) => new Promise<void>((resolve, reject) => {
    const signal = AbortSignal.timeout(5000);
    const finish = (error?: unknown) => {
      watcher.close();
      signal.removeEventListener("abort", abort);
      if (error) reject(error); else resolve();
    };
    const check = async () => { if (await predicate()) finish(); };
    const watcher = watch(directory, () => { void check().catch(finish); });
    watcher.on("error", finish);
    const abort = () => finish(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void action().then(check).catch(finish);
  });
  try {
    omoHerdr({events:{on:()=>()=>{}},registerTool:()=>{},appendEntry:()=>{},on:(event:string,handler:Handler)=>handlers.set(event,handler),registerCommand:(key:string,command:Omit<RegisteredCommand,"name"|"sourceInfo">)=>commands.set(key,command)} as unknown as ExtensionAPI);
    await observe(async()=>field(await last("report-metadata")??[],"--title")==="First session", () => emit("session_start"));
    await observe(async()=> (await last("report-metadata"))?.includes("omo_summary=Running read (+1)")??false, async () => {
      await emit("tool_execution_start",{toolCallId:"a",toolName:"bash",args:{secret:"NEVER-SEND"}});
      await emit("tool_execution_start",{toolCallId:"b",toolName:"read"});
    });
    await observe(async()=> (await last("report-metadata"))?.includes("omo_summary=Running read")??false,
      () => emit("tool_execution_end",{toolCallId:"a"}));
    await observe(async()=> (await last("report-metadata"))?.includes("omo_summary=Compacting context")??false,
      () => emit("session_before_compact"));
    await observe(async()=> (await last("report-metadata"))?.includes("omo_summary=Running read")??false,
      () => emit("session_compact",{accepted:false,willRetry:false}));
    await observe(async()=> (await last("report-metadata"))?.includes("omo_summary=Needs your input")??false,
      () => emit("ui_prompt_start",{kind:"confirm",title:"PRIVATE TITLE"}));
    // Switch without destroying the extension: old tools/prompts/name/context must disappear.
    id="second";name=undefined;context={tokens:50,percent:5,contextWindow:1000};
    await observe(async()=> field(await last("report-agent")??[],"--agent-session-id")==="second" &&
      ((await last("report-metadata"))?.includes("omo_context=5% (50/1000)")??false), () => emit("session_start",{reason:"resume"}));
    assert.equal(field(await last("report-agent"),"--state"),"idle");
    assert.ok((await last("report-metadata")).includes("--clear-title"));
    assert.ok(!(await last("report-metadata")).includes("--state-label"));
    ctx.model={...ctx.model!,id:"second-model"};
    await observe(async()=> (await last("report-metadata"))?.includes("omo_model=test/second-model")??false, () => emit("model_select"));
    await observe(async()=>field(await last("report-agent")??[],"--state")==="working", () => emit("session_before_compact"));
    await observe(async()=>field(await last("report-agent")??[],"--state")==="idle", () => emit("session_compact_failed",{aborted:true}));
    const command = commands.get("herdr")!;
    const commandCtx=ctx as Parameters<typeof command.handler>[1];
    await command.handler("doctor",commandCtx);
    assert.match(notifications.at(-1)!,/Connection: OK/);
    assert.match(notifications.at(-1)!,/State: OK/);
    process.env.OMO_HERDR_TEST_PROBE_FAIL="1";
    await command.handler("doctor",commandCtx);
    assert.match(notifications.at(-1)!,/Connection\/pane probe failed/);
    assert.ok(!notifications.join("\n").includes("SECRET"));
    await emit("session_shutdown");
    const captured=await calls();
    assert.equal(captured.at(-1)![1],"release-agent");
    assert.ok(captured.at(-2)!.includes("--clear-token"));
    for (const key of ["omo_work_item", "omo_project", "omo_summary", "omo_elapsed_compact"]) assert.ok(captured.at(-2)?.includes(key));
    assert.ok(!JSON.stringify(captured).includes("NEVER-SEND"));
    assert.ok(!JSON.stringify(captured).includes("PRIVATE TITLE"));
  } finally {
    await emit("session_shutdown");
    for(const key of Object.keys(process.env)) if(!(key in original)) delete process.env[key];
    Object.assign(process.env,original);
    await rm(directory,{recursive:true,force:true});
  }
});

test("metadata opt-out disables summary registration and collection without disabling lifecycle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omo-herdr-optout-"));
  const log = join(directory, "calls.jsonl");
  const original = { ...process.env };
  const bin = new URL("./fixtures/herdr-cli.mjs", import.meta.url).pathname;
  const handlers = new Map<string, Handler>();
  const tools: string[] = [];
  const ctx = { cwd: directory, mode: "tui", hasUI: true, isIdle: () => true, hasPendingMessages: () => false,
    sessionManager: { getSessionId: () => "optout", getSessionFile: () => undefined },
    getContextUsage: () => assert.fail("metadata collection must remain disabled"),
  } as unknown as ExtensionContext;
  try {
    await chmod(bin, 0o755);
    Object.assign(process.env, { HERDR_ENV: "1", HERDR_BIN_PATH: bin, HERDR_SOCKET_PATH: join(directory, "socket"),
      HERDR_PANE_ID: "w1:p1", OMO_HERDR_TEST_LOG: log, OMO_HERDR_METADATA: "0" });
    delete process.env.OMO_HERDR_OWNER_PID;
    omoHerdr({ registerCommand: () => {}, registerTool: (tool: { name: string }) => tools.push(tool.name),
      on: (name: string, handler: Handler) => handlers.set(name, handler) } as unknown as ExtensionAPI);
    await handlers.get("session_start")?.({}, ctx);
    await handlers.get("session_shutdown")?.({}, ctx);
    const calls: string[][] = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(tools, []);
    assert.deepEqual(calls.map(args => args[1]), ["report-agent", "release-agent"]);
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx);
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    await rm(directory, { recursive: true, force: true });
  }
});

test("doctor is available outside Herdr while lifecycle hooks remain inactive", async () => {
  const old=process.env.HERDR_ENV;
  delete process.env.HERDR_ENV;
  let command: Omit<RegisteredCommand,"name"|"sourceInfo"> | undefined;
  const hooks:string[]=[];
  const notices:string[]=[];
  try {
    omoHerdr({events:{on:()=>()=>{}},registerTool:()=>{},appendEntry:()=>{},on:(event:string)=>hooks.push(event),registerCommand:(_key:string,value:typeof command)=>{command=value;}} as unknown as ExtensionAPI);
    assert.deepEqual(hooks,[]);
    assert.ok(command);
    await command.handler("doctor",{mode:"tui",hasUI:true,ui:{notify:(text:string)=>notices.push(text)}} as unknown as Parameters<typeof command.handler>[1]);
    assert.match(notices[0]!,/Start OmO inside a Herdr pane/);
  } finally {if(old===undefined)delete process.env.HERDR_ENV;else process.env.HERDR_ENV=old;}
});
