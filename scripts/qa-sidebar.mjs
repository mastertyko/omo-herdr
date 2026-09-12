#!/usr/bin/env node
/** Official Herdr -> real PTY -> xterm.js -> Chrome PNG. No model calls.
 * node scripts/qa-sidebar.mjs --preliminary
 * node scripts/qa-sidebar.mjs --profile profiles/sidebar.toml --label final
 * Optional: HERDR_BIN_PATH, QA_CHROME_PATH, QA_PYTHON, QA_SIDEBAR_DEPS
 * Dependencies install only inside the disposable directory unless an existing
 * QA_SIDEBAR_DEPS/node_modules is supplied. No project/global installs or config.
 */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { Overview } from '../src/overview.ts';
import { metadataArgs } from '../src/metadata.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  assert.ok(args[index + 1] && !args[index + 1].startsWith('--'), `Missing ${name} value`);
  return args[index + 1];
}
const preliminary = args.includes('--preliminary');
const label = option('--label', preliminary ? 'preliminary' : 'profile');
assert.match(label, /^[a-z0-9-]+$/);
const profilePath = resolve(root, option('--profile', 'profiles/sidebar.toml'));
const bin = process.env.HERDR_BIN_PATH ?? join(homedir(), '.local/bin/herdr');
assert.ok(isAbsolute(bin));
const chrome = process.env.QA_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const base = await mkdtemp(join(tmpdir(), 'omo-sidebar-qa-'));
const artifacts = join(root, '.omo/evidence/compact-sidebar', label);
const dependencyRoot = process.env.QA_SIDEBAR_DEPS ? resolve(process.env.QA_SIDEBAR_DEPS) : join(base, 'deps');
const run = promisify(execFile);
const bus = new EventEmitter();
const commands = [], processes = [], captures = [], cleanup = [];
let server, client, browser, socket, serverLog = '', clientLog = '', failed;
const env = {
  ...process.env, HOME: join(base, 'home'), XDG_CONFIG_HOME: join(base, 'config'),
  XDG_STATE_HOME: join(base, 'state'), XDG_RUNTIME_DIR: join(base, 'runtime'),
  XDG_CACHE_HOME: join(base, 'cache'), HERDR_SOCKET_PATH: join(base, 'api.sock'),
  SHELL: '/bin/sh', ENV: '/dev/null', OMO_CODING_AGENT_DIR: join(base, 'agent'),
  TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'en_US.UTF-8',
};
for (const key of Object.keys(env)) {
  if (key.startsWith('HERDR_') && key !== 'HERDR_SOCKET_PATH' || key === 'OMO_HERDR_OWNER_PID') delete env[key];
}
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const preliminaryProfile = `# PRELIMINARY synthetic-token profile; not shipped-profile evidence.
[ui.sidebar.agents]
rows = [
  [{ token = "$omo_work_item", bold = true }],
  ["$omo_project"],
  ["$omo_summary"],
  ["state_icon", "state_text", "$omo_elapsed_compact"],
]
[ui.sidebar.agents.rows_by_agent]
codex = [["state_icon", "machine", "workspace", "tab"], ["agent", "state_text"]]
`;
const fixtures = [
  { id: 'active-pr', agent: 'omo', state: 'working', item: 'PR owner/omo-herdr#379, Issue owner/omo-herdr#1234', project: 'omo-herdr', summary: 'Fix sidebar spacing', duration: 180000 },
  { id: 'verified-pr', agent: 'omo', state: 'idle', item: 'https://github.com/owner/omo-herdr/pull/380', project: 'omo-herdr', summary: 'Tests passed', duration: 480000 },
  { id: 'input-issue', agent: 'omo', state: 'blocked', item: 'Issue owner/api-service#42', project: 'api-service', summary: 'Review issue', duration: 60000 },
  { id: 'plain-work', agent: 'omo', state: 'working', project: 'docs-site', summary: 'Update installation', duration: 42000 },
  { id: 'unicode', agent: 'omo', state: 'working', item: 'Issue #900', project: '国際化-長いリポジトリ-🧪-feature-worktree', summary: '日本語の表示を検証', duration: 7200000 },
  { id: 'builtin', agent: 'codex', state: 'idle' },
];

async function fixtureMetadata(fixture) {
  let summaryTool;
  const overview = new Overview({
    events: { on: () => () => {} },
    registerTool: tool => { summaryTool = tool; },
    appendEntry() {},
  }, () => {});
  const ctx = {
    cwd: join(base, fixture.project), mode: 'tui', hasUI: true,
    sessionManager: { getSessionId: () => fixture.id, getBranch: () => [] },
  };
  await mkdir(ctx.cwd, { recursive: true });
  try {
    overview.start(ctx);
    overview.begin(0);
    await summaryTool.execute('fixture', {
      workItem: fixture.item ?? '', task: fixture.state === 'idle' ? 'Run tests' : fixture.summary,
      result: fixture.state === 'idle' ? fixture.summary : '',
    }, undefined, undefined, ctx);
    if (fixture.state === 'idle') overview.settle(false, fixture.duration);
    if (fixture.state === 'blocked') overview.metadata(true, 0);
    return overview.metadata(fixture.state === 'blocked', fixture.duration,
      fixture.state === 'working' ? 'Running bash' : undefined);
  } finally { overview.stop(); }
}

// Every asynchronous wait subscribes before its triggering action; timers only bound failure.
function wait(event, predicate, description, timeout = 20000) {
  let handler, timer;
  const promise = new Promise((resolveWait, reject) => {
    handler = value => {
      if (!predicate(value)) return;
      clearTimeout(timer); bus.off(event, handler); resolveWait(value);
    };
    bus.on(event, handler);
    timer = setTimeout(() => {
      bus.off(event, handler);
      reject(new Error(`Timeout waiting for ${description}`));
    }, timeout);
    timer.unref();
  });
  // Triggers can fail before the await; keep that failure from becoming unhandled.
  promise.catch(() => {});
  return promise;
}
async function command(...argv) {
  try {
    const result = await run(bin, argv, { env, timeout: 10000 });
    commands.push({ argv, code: 0 });
    // Herdr's reporting/control commands succeed without a JSON response body.
    return result.stdout.trim() ? JSON.parse(result.stdout) : undefined;
  } catch (error) {
    commands.push({ argv, code: error.code, stderr: error.stderr });
    throw error;
  }
}
async function stopClient() {
  if (!client || client.exitCode !== null) return;
  const child = client;
  const exited = once(child, 'exit');
  const deadline = setTimeout(() => child.kill('SIGTERM'), 5000);
  child.stdin.end(JSON.stringify({ stop: true }) + '\n');
  try {
    const [code] = await exited;
    cleanup.push({ name: 'pty-bridge', pid: child.pid, code });
    assert.equal(code, 0, 'PTY bridge exited cleanly and reaped the Herdr client');
  } finally { clearTimeout(deadline); client = undefined; }
}

try {
  await mkdir(artifacts, { recursive: true });
  await rm(join(artifacts, 'failure.txt'), { force: true });
  for (const dir of ['home', 'config/herdr', 'state', 'runtime', 'cache', 'agent', 'repo']) {
    await mkdir(join(base, dir), { recursive: true });
  }
  const version = (await run(bin, ['--version'], { env, timeout: 5000 })).stdout.trim();
  assert.equal(version, 'herdr 0.9.0');
  const binaryHash = sha256(await readFile(bin));
  const profile = preliminary ? preliminaryProfile : await readFile(profilePath, 'utf8');
  await writeFile(join(artifacts, 'sidebar.toml'), profile);
  if (!process.env.QA_SIDEBAR_DEPS) {
    await mkdir(dependencyRoot);
    const install = await run('npm', ['install', '--prefix', dependencyRoot, '--no-audit', '--no-fund',
      '--ignore-scripts', '--save-exact', 'playwright-core@1.63.0', '@xterm/xterm@6.0.0', '@xterm/addon-unicode11@0.9.0'],
    { timeout: 120000 });
    await writeFile(join(artifacts, 'dependency-install.log'), install.stdout + install.stderr);
  }
  const moduleRoot = join(dependencyRoot, 'node_modules');
  const { chromium } = await import(pathToFileURL(join(moduleRoot, 'playwright-core/index.mjs')).href);
  const dependencyVersions = {};
  for (const name of ['playwright-core', '@xterm/xterm', '@xterm/addon-unicode11']) {
    dependencyVersions[name] = JSON.parse(await readFile(join(moduleRoot, name, 'package.json'), 'utf8')).version;
  }
  browser = await chromium.launch({ executablePath: chrome, headless: true });
  const browserVersion = browser.version();
  async function config(width) {
    const content = `onboarding = false\n[ui]\nsidebar_width = ${width}\nsidebar_min_width = ${width}\nsidebar_max_width = ${width}\n` + profile;
    await writeFile(join(base, 'config/herdr/config.toml'), content);
    await writeFile(join(artifacts, `config-${width}.toml`), content);
  }
  await config(24);
  const ready = wait('server', text => text.includes('herdr server running'), 'isolated server readiness');
  server = spawn(bin, ['server'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  processes.push({ name: 'herdr-sidebar-qa-server', pid: server.pid, command: [bin, 'server'] });
  server.on('error', error => bus.emit('process-error', error));
  for (const stream of [server.stdout, server.stderr]) stream.on('data', data => {
    serverLog += data; bus.emit('server', serverLog);
  });
  await ready;
  socket = createConnection(env.HERDR_SOCKET_PATH);
  await once(socket, 'connect');
  createInterface({ input: socket }).on('line', line => bus.emit('api', JSON.parse(line)));
  const subscribed = wait('api', value => value.id === 'sidebar-qa-subscribe', 'pane event subscription');
  socket.write(JSON.stringify({ id: 'sidebar-qa-subscribe', method: 'events.subscribe', params: {
    subscriptions: [{ type: 'pane.updated' }],
  } }) + '\n');
  assert.ok(!(await subscribed).error);
  const created = await command('workspace', 'create', '--cwd', join(base, 'repo'), '--label', 'Sidebar QA');
  const workspaceId = created.result.workspace.workspace_id;
  await command('workspace', 'focus', workspaceId);
  for (const [index, fixture] of fixtures.entries()) {
    const pane = index === 0 ? created.result.root_pane : (await command('tab', 'create', '--workspace', workspaceId,
      '--cwd', join(base, 'repo'), '--label', fixture.id)).result.root_pane;
    fixture.paneId = pane.pane_id;
    const source = fixture.agent === 'omo' ? 'custom:omo' : `qa-sidebar:${fixture.id}`;
    // A completed result follows a real working -> idle transition in Herdr.
    await command('pane', 'report-agent', fixture.paneId, '--source', source, '--agent', fixture.agent,
      '--state', 'working', '--seq', '1');
    await command('pane', 'report-agent', fixture.paneId, '--source', source, '--agent', fixture.agent,
      '--state', fixture.state, '--seq', '2');
    if (fixture.agent === 'omo') {
      fixture.metadata = await fixtureMetadata(fixture);
      const received = wait('api', value => value.event === 'pane_updated' && value.data?.pane?.pane_id === fixture.paneId
        && value.data.pane.tokens?.omo_summary === fixture.metadata.summary, `${fixture.id} metadata`);
      const args = metadataArgs(fixture.metadata, 3, fixture.paneId);
      args[args.indexOf('--ttl-ms') + 1] = '900000';
      await command(...args);
      await received;
    }
    const observed = (await command('pane', 'get', fixture.paneId)).result.pane;
    fixture.observed = observed;
  }
  // Keep a normal terminal focused: no viewed-completion ambiguity for synthetic agents.
  const focusPane = (await command('tab', 'create', '--workspace', workspaceId, '--cwd', join(base, 'repo'),
    '--label', 'render-provenance', '--focus')).result.root_pane.pane_id;
  await command('pane', 'run', focusPane, "printf '\\033[2J\\033[HREAL HERDR SIDEBAR QA\\nSynthetic metadata; no model calls.\\n'");

  for (const width of [24, 32, 40]) {
    await config(width);
    await command('server', 'reload-config');
    const directory = join(artifacts, `${width}-cols`);
    await mkdir(directory, { recursive: true });
    const cols = 112, rows = 64;
    const page = await browser.newPage({ viewport: { width: 1400, height: 1600 }, deviceScaleFactor: 1 });
    const browserErrors = [];
    page.on('pageerror', error => browserErrors.push(String(error)));
    await page.setContent('<!doctype html><html><head><title>Real Herdr compact sidebar QA</title></head><body style="margin:0;background:#1e1e2e"><div id="terminal"></div></body></html>');
    await page.addStyleTag({ path: join(moduleRoot, '@xterm/xterm/css/xterm.css') });
    await page.addScriptTag({ path: join(moduleRoot, '@xterm/xterm/lib/xterm.js') });
    await page.addScriptTag({ path: join(moduleRoot, '@xterm/addon-unicode11/lib/addon-unicode11.js') });
    await page.exposeFunction('ptyInput', data => {
      if (client && client.exitCode === null && !client.stdin.destroyed) {
        client.stdin.write(JSON.stringify({ input: Buffer.from(data).toString('base64') }) + '\n');
      }
    });
    await page.evaluate(({ cols, rows }) => {
      const terminal = new window.Terminal({ cols, rows, fontFamily: '"Hack Nerd Font Mono", Menlo, monospace',
        fontSize: 16, lineHeight: 1.15, cursorBlink: false, scrollback: 0,
        allowProposedApi: true, theme: { background: '#1e1e2e', foreground: '#cdd6f4' } });
      terminal.loadAddon(new window.Unicode11Addon.Unicode11Addon());
      terminal.unicode.activeVersion = '11';
      terminal.open(document.getElementById('terminal'));
      terminal.onData(data => window.ptyInput(data));
      window.terminal = terminal;
      // Crossterm probes these before rendering. xterm handles DA/DSR itself.
      for (const [code, value] of [[10, 'cdd6/f4f4/ffff'], [11, '1e1e/1e1e/2e2e']]) {
        terminal.parser.registerOscHandler(code, data => {
          if (data !== '?') return false;
          window.ptyInput(`\x1b]${code};rgb:${value}\x1b\\`); return true;
        });
      }
      terminal.parser.registerCsiHandler({ prefix: '?', final: 'n' }, params => {
        if (params[0] !== 996) return false;
        window.ptyInput('\x1b[?997;1n'); return true;
      });
      terminal.parser.registerCsiHandler({ final: 't' }, params => {
        if (params[0] !== 16) return false;
        window.ptyInput('\x1b[6;18;10t'); return true;
      });
    }, { cols, rows });
    await page.evaluate(() => document.fonts.ready);
    const raw = [];
    let frozen = false, pump = Promise.resolve(), currentText = '';
    // A parsed buffer is not yet a painted frame: Herdr uses synchronized output.
    // Subscribe to xterm's actual render event before starting the PTY.
    const expected = ['PR#379/Issue#1234', 'PR #380', 'Issue #42', 'docs-site', 'Issue #900', 'codex',
      'Fix sidebar', 'Tests passed', 'Needs your input', 'Update installation', '日本語', 'REAL HERDR'];
    const frame = wait(`frame-${width}`, value => expected.every(text => value.includes(text)), `all six scenarios at ${width} columns`);
    await page.exposeFunction('frameRendered', text => {
      if (!frozen && expected.every(marker => text.includes(marker))) {
        frozen = true;
        bus.emit(`frame-${width}`, text);
      }
    });
    await page.evaluate(() => {
      window.terminal.onRender(() => {
        const buffer = window.terminal.buffer.active;
        const text = Array.from({ length: window.terminal.rows }, (_, y) =>
          buffer.getLine(buffer.viewportY + y)?.translateToString(true) ?? '').join('\n');
        window.frameRendered(text);
      });
    });
    const bridgeReady = wait('bridge-ready', value => value.ready, 'PTY geometry initialization');
    client = spawn(process.env.QA_PYTHON ?? '/usr/bin/python3',
      [join(root, 'scripts/qa-sidebar.pty.py'), bin, String(cols), String(rows)],
      { env, stdio: ['pipe', 'pipe', 'pipe'] });
    processes.push({ name: `herdr-sidebar-qa-pty-${width}`, pid: client.pid });
    client.stderr.on('data', data => { clientLog += data; });
    client.on('error', error => bus.emit(`pump-error-${width}`, error));
    createInterface({ input: client.stdout }).on('line', line => {
      const value = JSON.parse(line);
      if (value.ready) {
        processes.push({ name: `herdr-sidebar-qa-tui-${width}`, pid: value.clientPid });
        bus.emit('bridge-ready', value);
      }
      if (value.stopped) cleanup.push({ name: `herdr-tui-${width}`, ...value });
      if (!value.data) return;
      pump = pump.then(async () => {
        if (frozen) return;
        const bytes = Buffer.from(value.data, 'base64'); raw.push(bytes);
        currentText = await page.evaluate(async data => {
          const bytes = Uint8Array.from(atob(data), character => character.charCodeAt(0));
          await new Promise(resolveWrite => window.terminal.write(bytes, resolveWrite));
          const buffer = window.terminal.buffer.active;
          return Array.from({ length: window.terminal.rows }, (_, y) => buffer.getLine(buffer.viewportY + y)?.translateToString(true) ?? '').join('\n');
        }, value.data);
      }).catch(error => bus.emit(`pump-error-${width}`, error));
    });
    const pumpError = wait(`pump-error-${width}`, () => true, 'PTY/browser pump error', 22000).then(error => { throw error; });
    pumpError.catch(() => {});
    await bridgeReady;
    try { await Promise.race([frame, pumpError]); await pump; }
    finally {
      await writeFile(join(directory, 'terminal-ansi.txt'), Buffer.concat(raw));
      await writeFile(join(directory, 'terminal.txt'), currentText);
    }
    const geometry = await page.evaluate(async () => {
      await new Promise(resolvePaint => requestAnimationFrame(() => requestAnimationFrame(resolvePaint)));
      const element = document.querySelector('.xterm-screen');
      const bounds = element.getBoundingClientRect();
      return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
        fontFamily: window.terminal.options.fontFamily, fontSize: window.terminal.options.fontSize };
    });
    const clip = { x: geometry.x, y: geometry.y, width: geometry.width, height: geometry.height };
    await page.screenshot({ path: join(directory, 'terminal.png'), clip });
    await page.screenshot({ path: join(directory, 'sidebar.png'), clip: {
      ...clip, width: Math.ceil(geometry.width / cols * width),
    } });
    const png = await readFile(join(directory, 'terminal.png'));
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(png.readUInt32BE(16), Math.floor(geometry.width));
    assert.equal(png.readUInt32BE(20), Math.floor(geometry.height));
    const cells = await page.evaluate(() => {
      const buffer = window.terminal.buffer.active, result = [];
      for (let y = 0; y < window.terminal.rows; y++) {
        const line = buffer.getLine(buffer.viewportY + y);
        for (let x = 0; x < window.terminal.cols; x++) {
          const cell = line?.getCell(x);
          if (cell?.getChars()) result.push({ x, y, chars: cell.getChars(), width: cell.getWidth(),
            bold: !!cell.isBold(), foreground: cell.getFgColor(), background: cell.getBgColor() });
        }
      }
      return result;
    });
    await writeFile(join(directory, 'cells.json'), JSON.stringify(cells, null, 2));
    assert.deepEqual(browserErrors, []);
    const metadata = { width, cols, rows, geometry, browserErrors, profileSha256: sha256(profile),
      ansiSha256: sha256(Buffer.concat(raw)), pngSha256: sha256(png), expected,
      provenance: 'Official Herdr TUI raw PTY bytes parsed/rendered by xterm.js in headless Chrome; no painted mock or terminal-cell rasterizer.' };
    await writeFile(join(directory, 'metadata.json'), JSON.stringify(metadata, null, 2));
    captures.push({ directory, ...metadata });
    await stopClient();
    await page.close();
  }
  await writeFile(join(artifacts, 'report.json'), JSON.stringify({ version, binaryHash, browserVersion,
    dependencyVersions, preliminary, profilePath: preliminary ? null : profilePath, profileSha256: sha256(profile),
    fixtures, captures, processes, invocation: process.argv,
    limitations: ['Synthetic report-agent/report-metadata inputs; not extension lifecycle or live-model verification.',
      'Three sidebar widths (24/32/40) in a 112x64 terminal; no claim about other dimensions.',
      'xterm.js Unicode 11 and local Hack Nerd Font Mono; other terminals/fonts may differ.',
      'Independent visual-review gate is separate; this harness does not assign a product PASS.'] }, null, 2));
} catch (error) {
  failed = error;
  await mkdir(artifacts, { recursive: true });
  await writeFile(join(artifacts, 'failure.txt'), String(error.stack));
} finally {
  try { await stopClient(); } catch (error) { failed ??= error; cleanup.push({ error: String(error) }); }
  socket?.destroy();
  if (server && server.exitCode === null) {
    const exited = once(server, 'exit');
    const deadline = setTimeout(() => server.kill('SIGKILL'), 7000);
    try {
      try { await command('server', 'stop'); }
      catch (error) { cleanup.push({ stopError: String(error) }); server.kill('SIGTERM'); }
      const [code, signal] = await exited;
      cleanup.push({ name: 'herdr-sidebar-qa-server', pid: server.pid, code, signal });
    } finally { clearTimeout(deadline); }
  }
  if (browser) { await browser.close(); cleanup.push({ name: 'isolated-chrome', closed: true }); }
  await writeFile(join(artifacts, 'server.log'), serverLog);
  await writeFile(join(artifacts, 'client.log'), clientLog);
  await writeFile(join(artifacts, 'commands.json'), JSON.stringify(commands, null, 2));
  await rm(base, { recursive: true, force: true });
  cleanup.push({ temporaryDirectory: base, removed: true });
  await writeFile(join(artifacts, 'cleanup.json'), JSON.stringify(cleanup, null, 2));
}
if (failed) { console.error(failed); process.exitCode = 1; }
else console.log(JSON.stringify({ artifacts, captures: captures.map(({ width, directory }) => ({ width, directory })), cleanup }, null, 2));
