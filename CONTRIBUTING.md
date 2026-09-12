# Contributing

## Local workflow

Use Bun 1.3.14 and Node.js 24 or later. The checked-in Bun lockfile pins development
dependencies; OMO supplies Senpi at runtime.

```sh
bun install --frozen-lockfile
bun run check
HERDR_BIN_PATH="$(command -v herdr)" bun run qa:host
HERDR_BIN_PATH="$(command -v herdr)" bun run qa:live
npm pack --dry-run
```

The host check needs Herdr installed. It uses a temporary mock socket with the real
Senpi loader and UI events. It does not open user sessions or call models. For lifecycle
or metadata changes, run `qa:live` against official Herdr 0.9.0. It starts and stops an
isolated server and checks the real protocol without touching user sessions. CI downloads
the official binary with a pinned checksum and runs both checks. A human-driven TUI/model
run is a separate optional check with `omo -e /absolute/path/to/src/index.ts`.

Keep tests focused on observable behavior, including retries, session replacement,
child-process isolation, and shutdown ordering. Use only Senpi's public extension API.
Use `agent_settled`, not `agent_end`, to mark a run idle. Keep cleanup idempotent.

## Pull requests

GitHub Actions runs the required `Bun check` on pull requests and pushes to `main`.
The default branch requires a PR, up-to-date checks and resolved review threads, and
rejects force pushes and deletion. Owner PRs from the same repository have auto-merge
enabled. No approval is required, matching `omo-codex-computer`.

## Releases

The `Release` workflow runs on pushes to `main`, after the owner auto-merge workflow,
and on manual dispatch. All triggers are gated by
`NPM_TRUSTED_PUBLISHING_ENABLED=true`.

It checks the source, computes the next patch version, validates the release package,
and creates a version commit on a temporary `chore/release-vX.Y.Z` branch. It publishes
to npm with GitHub Actions trusted publishing, creates a GitHub release and tag pointing
to the version commit, and removes the temporary branch. The version commit remains
reachable from the release tag; `main` is not changed by the release workflow.

Do not bump `package.json` for ordinary feature PRs. The workflow owns patch versions
and skips `main` revisions already represented by the newest release tag.
The `workflow_run` trigger covers merges performed with `GITHUB_TOKEN`, which do not
trigger another push workflow. That path checks for a successful owner auto-merge job
and an actual merged owner PR before publishing trusted `main` code.

### npm bootstrap

The first package version must exist on npm before its trusted publisher can be configured.
An authenticated maintainer publishes that version with `npm publish --access public`.
Then configure the npm package's trusted publisher:

| Field | Value |
| --- | --- |
| Provider | GitHub Actions |
| Organization or user | `mastertyko` |
| Repository | `omo-herdr` |
| Workflow filename | `release.yml` |
| Environment | Leave empty (the workflow does not use a GitHub environment) |

Enable the repository variable only after that configuration is saved. Normal releases
use short-lived OIDC credentials and provenance; do not add an `NPM_TOKEN` repository secret.

After the first automatic release, verify the npm version, tarball contents, provenance,
GitHub tag and installation through `omo install npm:omo-herdr` in an isolated agent directory.
