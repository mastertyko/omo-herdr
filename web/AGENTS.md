# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.

Product decisions: Use English for all interface text and demo content. Match the selected dark three-column agent tree / dependency graph / inspector concept. Keep agent ownership separate from task dependencies.

Show subtle particles along dependencies feeding working tasks and a brief outgoing pulse on observed completion transitions. Keep inactive connections still, stop motion when disconnected, and respect reduced motion. These indicate task activity and dependencies, not message traffic.

Dependency lines and arrowheads must meet the card borders without gaps or abrupt bends, including after zooming. Particles follow the exact same path as the line.
Leave a straight, centred shaft before each arrowhead; curves must enter the middle of the arrow, not its side. Use a shared straight lead-out at branch points.
