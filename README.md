# omo-herdr

[![CI](https://github.com/mastertyko/omo-herdr/actions/workflows/ci.yml/badge.svg)](https://github.com/mastertyko/omo-herdr/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/omo-herdr.svg)](https://www.npmjs.com/package/omo-herdr)
[![GitHub release](https://img.shields.io/github/v/release/mastertyko/omo-herdr.svg)](https://github.com/mastertyko/omo-herdr/releases/latest)

An OMO Native extension that reports lifecycle state to [Herdr](https://herdr.dev/docs/integrations/).
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
or additional configuration is needed. Outside Herdr it is inactive.

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
| `session_start` | Claim the pane and report current status and session reference |
| `agent_start` | `working` |
| `ui_prompt_start` | `blocked`, with the message `Waiting for user input` |
| `ui_prompt_end` | Return to `working` or `idle` after the last open prompt |
| `agent_settled` | `idle` after retries and automatic continuations have settled |
| `session_abort` | Clear working state when work outside an active run is aborted |
| `session_info_changed` | Refresh the session reference if needed |
| `session_shutdown` | Drain the in-flight request, then release this source's authority |

`agent_end` deliberately does not mark the pane idle: it can precede retries,
compaction or queued continuations. Cancelled UI prompts return to the previous activity state.
If a dialog remains open after the run settles, the pane remains blocked until the dialog closes.

The UI events cover prompts routed through Senpi's extension UI. A third-party tool
that bypasses that API and reads terminal input directly will need a separate adapter.

## Reporting and ownership

- Activates only with `HERDR_ENV=1`, an absolute `HERDR_BIN_PATH`, `HERDR_PANE_ID`
  and `HERDR_SOCKET_PATH`. Outside Herdr it registers no hooks and starts no processes or timers.
- Uses the Herdr CLI with argument arrays, never a shell. The inherited socket selects the server.
- Reports `--source custom:omo --agent omo` with increasing sequence numbers that survive
  extension reloads in the same process.
- Limits delivery to one in-flight request and one pending snapshot. New snapshots replace
  older pending ones. Successfully delivered duplicate states are suppressed.
- Times out each CLI call after 750 ms. Failed reports retry the latest snapshot after 2 seconds.
  Shutdown cancels retries and makes at most 2 release attempts after the current call finishes.
- Claims the pane only for a TUI session. `OMO_HERDR_OWNER_PID` is set in the agent process
  and inherited by children, preventing nested OMO processes from reporting over their parent.
  A process-local guard also prevents duplicate extension instances from owning the same pane.
- Sends no prompts, model output, tool arguments or credentials. Session ID/path are included;
  dialog titles are not copied into Herdr status messages.

This guard covers inherited child processes. A separate process that manually fabricates the
same Herdr environment is outside the ownership model. Normal shutdown releases authority;
`SIGKILL` cannot run extension cleanup. If state is stuck, restart/reload OMO and inspect
the pane through Herdr's agent tools.

## Session restore boundary

Reports include `--agent-session-id` and, when available, `--agent-session-path`.
The CLI accepts these fields, but Herdr 0.9.0 does not register `custom:omo` as an official
resumable source. **This package does not enable native session restore.** The live check
confirmed lifecycle state; it did not expose a native OmO session reference in `pane get`.

The next Herdr change needs an official `omo` integration, install/uninstall/status support,
directory resolution matching OMO, session-reference registration, and a resume plan using
`omo --session <session>`. That command is supported by the installed Senpi argument parser;
automatic restore still needs an end-to-end restart test after the Herdr change.

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
```

It verifies that the extension loads, its factory is passive, real Senpi UI events are handled,
and Herdr's CLI sends the expected socket requests, including session identity and release.
It reads the installed CLI's protocol version to implement the mock handshake.

### Verification on 2026-09-12

- TypeScript check and 11 automated tests passed.
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
