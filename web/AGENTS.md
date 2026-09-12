# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.

Product decisions: Use English for all interface text and demo content. Match the selected dark three-column agent tree / dependency graph / inspector concept. Keep agent ownership separate from task dependencies.

For small graphs with 1–3 tasks, keep cards at a readable normal size instead of scaling a lone card to fill the canvas. Use multiline names and adapt independent-task rows to the available width. Keep the established arrow geometry. The inspector tab is Summary: it describes reported status and never implies that completion proves passing tests or verified results.

Show subtle particles along dependencies feeding working tasks and a brief outgoing pulse on observed completion transitions. Keep inactive connections still, stop motion when disconnected, and respect reduced motion. These indicate task activity and dependencies, not message traffic.

Dependency lines and arrowheads must meet the card borders without gaps or abrupt bends, including after zooming. Particles follow the exact same path as the line.
Leave a straight, centred shaft before each arrowhead; curves must enter the middle of the arrow, not its side. Use a shared straight lead-out at branch points.

Research trails should match the approved dark three-column concept: preserve the agent tree, unfold one selected agent into connected search and source cards in the centre, and inspect a selected search or source on the right. Keep Overview as the default, use an explicit Back to tasks action, and never unfold a trail automatically when live events arrive. Research action and search-result links have distinct visual treatments and must remain distinct from workflow dependencies. Show a fetched page differently from an unvisited search result; content retrieval does not imply usage or citation. Missing research coverage must be visible and must never be filled with invented history. All illustrative research events belong to an explicitly labelled demo scene.

Use recognisable bundled website logos for known research sources, including OpenAI, GitHub, X and established developer communities and documentation sites, consistently in source cards, returned-source lists and source details. Keep the source domain visible and use a neutral globe for unknown sites. Website identity and retrieval status remain visually distinct.
