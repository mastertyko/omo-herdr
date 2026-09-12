# Security policy

Security fixes target the latest published version and `main`.

Use GitHub's private vulnerability reporting for this repository when available.
Otherwise contact the maintainer privately. Do not put credentials, user prompts or
session files in a public issue. Include the affected version, reproduction steps
and expected impact.

## Boundaries

- The extension reports only from a Herdr TUI session using the inherited executable,
  socket and pane identifiers. It never executes interpolated shell commands.
- Reports contain status, session ID/path, explicit session name, model identifier, context
  usage, tool names, task counts, branch/worktree names and timing. Explicit task/result
  labels from `herdr_summary` are intentionally published and persisted in the local session.
  Do not extract prompts, outputs or credentials into those labels. Metadata is optional (`OMO_HERDR_METADATA=0`). Ordinary tool arguments,
  model output and credentials must not be copied into metadata automatically.
- Child processes must not replace their parent pane's status. Duplicate extension
  instances must not claim the same process ownership.
- Requests and shutdown must be bounded. Pending reports must not arrive after a release.
- Runtime files, auth configuration and test logs are excluded from published packages.
- The optional web research projection requires an explicit opt-in producer capability
  and observed session/task ownership. It may retain allowlisted search queries, source
  titles, sanitized web URLs and response metadata in bounded session memory. These
  fields do not go into Herdr pane metadata. Raw arguments, headers, transcripts and
  response bodies are excluded. Unavailable or incomplete coverage must remain explicit.
  Source links open only on user action; the viewer does not fetch or preview sources.
- Release credentials use npm trusted publishing. Never commit tokens or add a persistent
  npm publishing secret to the repository.
