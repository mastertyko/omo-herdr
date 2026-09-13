# omo-herdr

[![CI](https://github.com/mastertyko/omo-herdr/actions/workflows/ci.yml/badge.svg)](https://github.com/mastertyko/omo-herdr/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/omo-herdr.svg)](https://www.npmjs.com/package/omo-herdr)
[![GitHub release](https://img.shields.io/github/v/release/mastertyko/omo-herdr.svg)](https://github.com/mastertyko/omo-herdr/releases/latest)

An OMO Native extension that reports lifecycle state and session metadata to [Herdr](https://herdr.dev/docs/integrations/).
Herdr displays `omo` as the pane's agent and uses the reported state for its normal
status, waits, notifications, and workspace rollups.

The extension has no runtime dependencies and does not modify Herdr.

## Requirements

- OMO Native with Senpi **2026.9.12 or later**. Verified with `omo-ai 5.0.0-0.beta.56` and Senpi `2026.9.12`.
- Herdr **0.9.0**, running the OMO terminal pane.
- Node.js **24 or later** for development and tests. OMO's own loader loads the TypeScript extension.

Older Senpi versions may lack the UI prompt events or TUI mode field this extension needs.
Only terminal (`tui`) sessions report status; RPC, app-server, JSON and print sessions are excluded.

## Install

```sh
omo install npm:omo-herdr
```

Restart OMO inside a Herdr pane. The extension reports status automatically; no API key
or additional configuration is needed for status reporting. Outside Herdr, only the
`/herdr` diagnostic command is available.

Update or remove the package with:

```sh
omo update npm:omo-herdr
omo remove npm:omo-herdr
```

`herdr integration install omo` is **not available** in Herdr 0.9.0.

### Try a local checkout

From a Herdr pane, run OMO with the absolute path to the extension:

```sh
omo -e /absolute/path/to/omo-herdr/src/index.ts
```

This enables the extension for that invocation. Run it from the project you want OMO to
work on. For a persistent local install, use `omo install /absolute/path/to/omo-herdr`.
Load either the installed package or the local `-e` path, not both at once.

## Lifecycle mapping

| Senpi event | Herdr behavior |
| --- | --- |
| `session_start` | Claim the pane, reset stale activity and report the current session (startup, new, resume, fork or reload) |
| `agent_start` | `working` |
| `ui_prompt_start` | `blocked`, with the message `Waiting for user input` |
| `ui_prompt_end` | Return to `working` or `idle` after the last open prompt |
| `agent_settled` | `idle` after retries and automatic continuations have settled |
| `session_abort` | Clear working state when work outside an active run is aborted |
| `tool_execution_start/end` | Show the tool name and number of other running tools |
| `session_before_compact` | Show `working` with `Compacting context` |
| `session_compact/failed` | Clear compaction activity; preserve an ongoing agent run until it settles |
| `session_info_changed`, `model_select`, `message_end` | Refresh session name, model and context usage |
| `session_shutdown` | Drain the in-flight request, clear owned metadata, then release authority |

`agent_end` deliberately does not mark the pane idle: it can precede retries,
compaction or queued continuations. Cancelled UI prompts return to the previous activity state.
If a dialog remains open after the run settles, the pane remains blocked until the dialog closes.

The UI events cover prompts routed through Senpi's extension UI. A third-party tool
that bypasses that API and reads terminal input directly will need a separate adapter.

## Session metadata and diagnostics

The extension publishes the explicit session name as the pane title, with the following custom tokens:

| Token | Example |
| --- | --- |
| `$omo_model` | `provider/model` |
| `$omo_context` | `42% (420/1000)`; `unknown` when usage is unavailable after compaction |
| `$omo_activity` | `Running bash`, `Running read (+1)` or `Compacting context` |
| `$omo_task` | Explicit short task label supplied by OmO |
| `$omo_work_item` | Compact reference, e.g. `PR #42` or `Issue #17` |
| `$omo_project` | One compact repository/worktree identity |
| `$omo_summary` | Attention, current activity, or a verified result, selected for the current state |
| `$omo_tasks` | `2 running · 1 pending · 3 completed` |
| `$omo_attention` | `Needs your input` or `1 failed task` |
| `$omo_result` | Explicit outcome, e.g. `12 tests passed · PR #42` |
| `$omo_branch` / `$omo_worktree` | Git branch / worktree directory name |
| `$omo_elapsed` | `08:32` or `Waiting 02:14` |
| `$omo_elapsed_compact` | `02:14`, with waiting status shown separately |
| `$omo_context_meter` | `Context 42%`, `High context 80%`, `Critical context 90%` |
| `$omo_context_percent` | Numeric `42`, for custom numeric color rules |

The compact sidebar keeps lifecycle status separate from the current activity or result.
Waits and notifications continue to use the normal semantic states. Ordinary tool arguments, tool results and prompt
text are never copied automatically. The `herdr_summary` tool intentionally publishes only
the short labels supplied to it. Session names and tool names are sanitized and length-limited for terminal display.

For the compact session overview, merge [profiles/sidebar.toml](profiles/sidebar.toml)
into your Herdr `config.toml`. The profile uses at most four nonempty rows: PR/issue
reference, project identity, current summary, and status with elapsed time. It omits
context usage, duplicate pane/workspace titles, standalone branch names and completed-task
counts. Attention and failures take precedence over ordinary summaries. References and
summaries are not dimmed; long labels are shortened for narrow terminal panels.
Paired references shorten labels and separators before dropping any identifier digits.
When both numbers cannot fit, `+1` explicitly marks the omitted second reference.
The profile ships in the npm package. Keep a backup and replace existing
`[ui.sidebar.agents]` settings rather than defining tables twice. Preserve any personal
`rows_by_agent` overrides when merging. Use Herdr's global
menu **reload config** to refresh the client's sidebar. `herdr server reload-config` refreshes
the server configuration; client presentation also needs the client menu action.

This changes the default Agent layout. Herdr 0.9.0 only accepts built-in agent IDs in
`rows_by_agent`, so `omo` cannot have a separate layout override. The shipped overrides
retain native identity rows for built-in agents. Missing custom tokens and empty rows
disappear. Extremely narrow sidebars can still truncate text; put references on their
own row rather than behind a long repository name.

Metadata uses its own source, `custom:omo:metadata`, scoped to the `custom:omo` agent.
It refreshes every 15 seconds, expires after 45 seconds without a refresh, and clears on
session changes or shutdown. Only the extension's named tokens and its own presentation
fields are cleared. Failed metadata delivery does not suppress lifecycle reports.
Set `OMO_HERDR_METADATA=0` before launching OmO to disable metadata while keeping status.

Inside OmO:

```text
/herdr status
/herdr doctor
```

`status` shows ownership, configuration and recent delivery health without CLI probes.
`doctor` also checks Herdr's version and current pane through bounded, read-only CLI calls.
Both explain missing configuration and inactive reporters, including nested processes.

## Session overview and DAG coexistence

`omo-herdr` provides native lifecycle reporting and the compact sidebar overview,
with no bundled web feature. Use [omo-herdr-dag](https://github.com/jc01rho/omo-herdr-dag)
for the separate DAG/task viewer. This extension doesn't install or manage that viewer,
create, close, rename or control it, or consume its snapshots.

The adapter listens for `omo.task.updated` on Senpi's public shared event bus
(`senpi:extension-rpc-event`). The payload is an OmO-specific, version-sensitive contract,
verified against `omo-ai 5.0.0-0.beta.56`. A complete snapshot replaces the previous counts.
Only direct tasks with the current `parent_session_id` are counted; DAG nodes and nested
child tasks are not counted again. `pending` means scheduled/queued, not waiting for a human.
`error`, `interrupted` and `lost` contribute to failed tasks; cancelled and unknown states
are shown separately. Truncated snapshots explicitly show how many tasks are omitted.
Counts cover the current session, not just its latest turn. Until OmO emits a snapshot,
no counts are shown. No private task-store files or transcripts are scanned.

Task failures are presentation metadata; they do not change the parent agent to `blocked`
or `idle`. An actual open Senpi prompt takes precedence with `Needs your input`.
The event listener captures startup snapshots, filters other sessions and unsubscribes
on unload. Session replacement clears the previous overview. If a future OmO version
changes the payload, lifecycle reporting and other metadata continue independently.

The model-facing `herdr_summary` tool accepts optional `task`, `result` and `workItem` strings, each
at most 160 characters. Use two to four words for task/result labels; existing longer
labels are preserved in the session and shortened only for display. Supply the known
PR/issue separately at the start and update it when the target changes. For example:

```json
{"task":"Verify login","workItem":"PR owner/repo#42","result":"Tests passed"}
```

These are explicit agent-reported labels, not independently inferred test/PR facts.
When working on a PR or issue, OmO is instructed to set `workItem` at the start of each
run and update it when the target changes or a PR is created. Include `owner/repo`
when needed to distinguish repositories. No GitHub lookup or prompt scanning is used.
The sidebar puts the compact reference first, followed by one project identity and a
short activity or verified result. Idle state and completed tasks never imply approval
or a merged PR. Existing installs
need the updated profile and an OmO reload/restart to load the new tool field.
Empty strings clear fields. Labels are stored as custom entries in the current OmO session
and restored from its active branch on reload/resume; this does not enable Herdr native
session restore. A new run clears the previous task, result and PR/issue reference.
Abort displays `Stopped` and retains the reference. Normal
shutdown clears Herdr metadata, while the saved session entry remains available on resume.

Elapsed time starts at `agent_start`, survives automatic continuations and freezes at
`agent_settled` or abort. Open prompts show a separate waiting timer. Live display samples
every 5 seconds. Git identity refreshes at most every 15 seconds using bounded, read-only
local Git commands; no remote requests, status scans or repository writes occur.
Detached HEAD uses the short commit; non-Git folders show the directory name without a branch.
Metadata opt-out also disables this overview, its tool, event subscription, Git probes and timers.

## Reporting and ownership

- Activates only with `HERDR_ENV=1`, an absolute `HERDR_BIN_PATH`, `HERDR_PANE_ID`
  and `HERDR_SOCKET_PATH`. Outside Herdr it registers no lifecycle hooks and starts no background processes or timers.
- Uses the Herdr CLI with argument arrays, never a shell. The inherited socket selects the server.
- Reports `--source custom:omo --agent omo` with increasing sequence numbers that survive
  extension reloads in the same process.
- Limits delivery to one in-flight request and one pending snapshot. New snapshots replace
  older pending ones. Successfully delivered duplicate states are suppressed.
- Times out each CLI call after 750 ms. Failed reports retry the latest snapshot after 2 seconds.
  Shutdown cancels timers and makes at most 2 metadata-clear attempts and 2 release attempts
  after the current call finishes.
- Claims the pane only for a TUI session. `OMO_HERDR_OWNER_PID` is set in the agent process
  and inherited by children, preventing nested OMO processes from reporting over their parent.
  A process-local guard also prevents duplicate extension instances from owning the same pane.
- Sends no prompts, model output, tool arguments or credentials. Session ID/path, explicit session name, model identifier, context usage and tool names
  are included, together with task counts, branch/worktree names, timing and explicit
  summary-tool labels. Dialog titles are not copied into Herdr status messages.

This guard covers inherited child processes. A separate process that manually fabricates the
same Herdr environment is outside the ownership model. Normal shutdown releases authority;
`SIGKILL` cannot run extension cleanup. If state is stuck, restart/reload OMO and inspect
the pane through Herdr's agent tools.

## Session restore boundary

Reports include `--agent-session-id` and, when available, `--agent-session-path`.
The CLI accepts these fields, but Herdr 0.9.0 does not register `custom:omo` as an official
resumable source. **This package does not enable native session restore.** The live check
confirmed lifecycle state; it did not expose a native OmO session reference in `pane get`.

You can keep using official Herdr. Install, update and remove this extension with OmO's
package commands. Native restore and `herdr integration install omo` require changes in
Herdr itself and are outside this package's scope.

## Development

```sh
bun install --frozen-lockfile
bun run check
bun run pack:dry
```

The tests cover lifecycle transitions, nested dialogs, session replacement, TUI isolation,
ownership, stale-clock sequencing, delivery ordering, retries, shutdown and CLI argument safety.
They do not make model requests or access user sessions.

The host smoke check uses the actual Senpi loader, `ExtensionRunner`, UI prompt machinery
and installed Herdr CLI against a temporary mock socket server:

```sh
HERDR_BIN_PATH="$(command -v herdr)" bun run qa:host
HERDR_BIN_PATH="$(command -v herdr)" bun run qa:live
```

It verifies that the extension loads, its factory is passive, real Senpi UI events are handled,
and Herdr's CLI sends the expected socket requests, including session identity and release.
It reads the installed CLI's protocol version to implement the mock handshake.

The live check starts an isolated official Herdr 0.9.0 server with its own configuration,
socket, state and shell pane. It verifies metadata, prompts, session replacement, diagnostics,
isolation and cleanup. CI downloads the official binary with a pinned SHA-256 checksum
and runs both checks on Linux. Neither check changes user configuration or calls a model.

### Verification on 2026-09-12

- TypeScript check and 24 automated tests passed.
- Real Senpi loader/UI events and Herdr CLI passed the host smoke check.
- An isolated **real Herdr 0.9.0 server** accepted and exposed the sequence
  `idle → working → blocked → working → idle → unknown` after release, with agent label `omo`.
  The check used a synthetic Senpi run and real UI prompt events; no model requests were made.
  The test server used its own configuration, socket and shell pane, and was stopped afterward.
- Native session restore and a human-driven OmO TUI/model run have not been tested.

For the interactive check, launch with `-e` inside Herdr, ask OMO to work and to request
user input, then exercise cancellation and `/reload`. Inspect the pane using:

```sh
herdr agent list
herdr pane get "$HERDR_PANE_ID"
```

## CI and releases

Pull requests and pushes to `main` run the required **Bun check** on GitHub Actions.
Owner PRs from branches in this repository have auto-merge enabled after required checks
and resolved review threads. Each unreleased `main` revision can produce an automatic patch
release using npm trusted publishing, followed by a GitHub release.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the release workflow and bootstrap requirements.

## References

- [Herdr custom integration contract](https://herdr.dev/docs/integrations/#integrate-your-own-agent)
- [Herdr socket API](https://herdr.dev/docs/socket-api/#agent-state-reporting)
- [Herdr OMP integration](https://github.com/herdrdev/herdr/blob/master/src/integration/assets/omp/herdr-agent-state.ts)
- [Herdr session resume policy](https://github.com/herdrdev/herdr/blob/master/src/agent_resume.rs)

The implementation uses Senpi's current events rather than copying OMP's different lifecycle API.
