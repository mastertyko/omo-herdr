# Agent overview design QA

final result: passed

## Source and evidence

- Selected visual: the locally retained, user-approved dark three-column mockup.
- Source pixels: 1586 × 992.
- Implementation screenshot: `overview.png` (local QA artifact), 1586 × 992.
- Combined comparison: `work/comparison-final.png`, 3172 × 992, reference on the left and implementation on the right.
- First comparison: `work/comparison-before.jpg`.
- Both designs compared at 1586 × 992 CSS pixels, density 1. A browser iframe provided the exact desktop viewport; the screenshot was cropped without scaling to extract the implementation.
- State: Overview, Backend selected, demo fixture; Tester is a child of Backend and waits on Auth API. The interface language changed to English at the user's explicit request.
- Preview: http://127.0.0.1:4173/?demo=1

## Comparison history

1. Initial visual comparison found P2 typography that was too small, loose tree row spacing, an off-center graph, and an unnecessarily scrolling inspector. Initial 743px desktop-panel observation also showed horizontal clipping.
2. Increased card/agent/detail typography; tightened tree spacing; observed canvas resizing before fitting the graph; showed only unmet dependencies in the inspector; added a narrow-panel drawer. Preserved English translations and real data constraints.
3. The final combined comparison confirms the three-column proportions, active-node treatment, complete graph, readable status labels and sub-agent hierarchy. Routed the upper dependency to the destination card's top handle to avoid an overlapping connector. No actionable P0/P1/P2 findings remain.

## Required fidelity surfaces

- Fonts: bundled Inter Variable with system fallback; distinct 20–24px headings, 13–15px card/details text, legible status labels. The generated reference has slightly more condensed lettering; this is a P3 refinement, not a readability issue.
- Spacing: retained 23% / flexible center / 25% columns, 55px topbar, bordered panels, compact activity strip and fixed inspector footer. All primary controls remain visible at the reference viewport. No document overflow at the separately inspected 2115 × 1435 desktop viewport. The packaged UI was also inspected at 1280 × 720.
- Colors: navy/charcoal surfaces, off-white text, muted blue secondary labels, periwinkle selected node, teal completed and amber waiting states. Grid contrast was reduced after comparison.
- Assets: Phosphor icons are the closest matching line icon set. React Flow draws the actual interactive graph; no screenshot is used as the UI. No illustrative/raster assets were required. Source/result composites were inspected at full view and the 1586px implementation crop was opened for readable tree, card and inspector detail review.
- Copy: interface and demo are English. Incoming task names preserve the source text. Demo is explicitly marked. Unknown/missing values are never presented as successful outcomes.

## Interaction verification

Tested in the Codex in-app browser:

- Agent selection and graph-card selection update the inspector.
- Tester reports Backend as its parent and Auth API as its blocking dependency.
- An unassigned Integration node is inspectable and lists its two unmet dependencies.
- Parent collapse/expand hides and restores the child row.
- Overview / Activity navigation, inspector Details / Activity / Results tabs, activity-row navigation and footer action work.
- Zoom and fit controls change the viewport; active-focus is available.
- Search filters agent rows and clearing it restores them.
- The packaged UI can select a DAG or All tasks; the latter draws no invented dependency edges. Independent nodes use a grid layout.
- A controlled snapshot changed Backend from Working to Done without browser reload.
- Stopping the controlled-event server produced Disconnected and a visible stale-data/reconnection notice.
- All inspected pages rendered without a crash. Raw browser-console collection was not exposed by the chosen CUA interface; no claim of a console-log audit is made.

## Deliberate implementation differences

- The reference's Open session button is View activity. The event data does not establish a supported way to open an arbitrary child session in Herdr, so the button performs an available action instead of pretending to navigate there.
- Real activity shows received status/tool changes, not invented file edits. Full prompts, responses, transcripts and test evidence are not exposed.
- Agent ownership comes only from explicit child-session links. DAG edges are dependencies. Nested snapshots must reach this host's event bus to appear.
- A bounded live model-driven OmO run was subsequently verified in an isolated official Herdr 0.9.0 server. Two real subagents ran in sequence through one DAG; public task/DAG events and authenticated HTTP snapshots showed the first node complete before the second started, then both completed and the main session idle. Chromium displayed both completed nodes and the real dependency edge. This verifies a two-node workflow, not every possible topology or recovery scenario.

## Real OmO run and subsequent functional checks

- Real-run screenshot: `real-omo-run.png` (local QA artifact).
- The test used the installed OmO launcher and the local extension source in a dedicated TUI session, with normal model configuration. `/herdr web` started the production viewer. The test adapter captured the OS browser-open URL for automated browser access; it did not fabricate task events or override model execution.
- The two arithmetic agents completed with results 4 and 6. Their output included introductory text despite the requested one-sentence format; this does not affect the integration status checks.
- The latest automated suite has 33 passing tests. The additional regression strips argument previews from OmO's actual `current_tool` display string.
- Browser checks cover search through collapsed ancestors, clearing search, no-results feedback, workflow selection resetting the inspector, long labels remaining bounded, disconnected/reconnected states, completion pulses, reduced motion, and centred arrow shafts.
- The regular demo preview remains available separately. New functionality remains local and unpublished.

## Follow-up polish

- P3: tune the exact condensed type character and subtler icon fill of the generated reference if desired.
- P3: very large graphs can require zoom/pan; the tree and active-focus provide navigation.
