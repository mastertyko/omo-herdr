# omo-herdr backlog

## Scope

This extension provides native Herdr lifecycle reporting and sidebar metadata,
including task counts and explicit task, result and PR/issue labels. The supplied
sidebar profile keeps context usage hidden; the context tokens remain available
for custom layouts.

Use [omo-herdr-dag](https://github.com/jc01rho/omo-herdr-dag) for the separate
DAG/task viewer. This extension doesn't bundle, install or manage that viewer.
Viewer work belongs in that project, not this backlog.

## Native integration follow-up

- [ ] Verify a human-driven OmO TUI/model run, including input prompts, cancellation
  and reload, using the interactive check in [README.md](README.md).

Native session restore and `herdr integration install omo` require changes in
Herdr itself and remain outside this package's scope.
