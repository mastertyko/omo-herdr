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
  usage, tool names, task counts, branch/worktree names and timing. Explicit task, result
  and PR/issue (`workItem`) labels from `herdr_summary` are intentionally published and
  persisted in the local session.
  Do not extract prompts, outputs or credentials into those labels. Metadata is optional (`OMO_HERDR_METADATA=0`). Ordinary tool arguments,
  model output and credentials must not be copied into metadata automatically.
- Child processes must not replace their parent pane's status. Duplicate extension
  instances must not claim the same process ownership.
- Requests and shutdown must be bounded. Pending reports must not arrive after a release.
- Runtime files, auth configuration and test logs are excluded from published packages.
- This extension provides native lifecycle reporting and sidebar metadata only. The
  separate [omo-herdr-dag](https://github.com/jc01rho/omo-herdr-dag) DAG/task viewer
  isn't bundled, installed or managed by this extension. Report issues specific to
  that viewer to its own project.
- Release credentials use npm trusted publishing. Never commit tokens or add a persistent
  npm publishing secret to the repository.
