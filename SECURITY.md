# Security policy

Security fixes target the latest published version and `main`.

Use GitHub's private vulnerability reporting for this repository when available.
Otherwise contact the maintainer privately. Do not put credentials, user prompts or
session files in a public issue. Include the affected version, reproduction steps
and expected impact.

## Boundaries

- The extension reports only from a Herdr TUI session using the inherited executable,
  socket and pane identifiers. It never executes interpolated shell commands.
- Reports contain status and native session references. Prompt text, tool arguments,
  model output and credentials must not be included.
- Child processes must not replace their parent pane's status. Duplicate extension
  instances must not claim the same process ownership.
- Requests and shutdown must be bounded. Pending reports must not arrive after a release.
- Runtime files, auth configuration and test logs are excluded from published packages.
- Release credentials use npm trusted publishing. Never commit tokens or add a persistent
  npm publishing secret to the repository.
