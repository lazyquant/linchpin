# Captured NEAR subject panels

A panel contains public facts from a recorded NEAR snapshot. Its capture line names the snapshot, block range and observation time. It is a snapshot, not a live feed. Evidence chips identify the original receipts; the receipts section also shows source identifiers and observation times.

Build one account, entirely offline:

~~~sh
bun --no-env-file run src/cli.ts near panel intents.near --snapshot near-2026-11-09 --out /tmp/near-panels --offline
~~~

The command writes exactly intents.near.html, intents.near.json and intents.near.chart.html. An account absent from the snapshot returns exit 2 with one stderr line and writes nothing. The default output directory is dist/near-panels. Unknown or duplicate flags are refused.

Compare two captures:

~~~sh
bun --no-env-file run src/cli.ts near panel intents.near --snapshot near-constructed-intents-locker-added --before near-2026-11-09 --out /tmp/near-comparison --offline
~~~

Constructed captures say CONSTRUCTED in the page and JSON. Changes come from exact account and account-owned subsubject queries, each compared at its own observation boundary. Without a comparison, the changes section says "one capture only: nothing to compare". A proposed action is a proposal, not observed execution.

Build the static landing page and all captured registry panels:

~~~sh
bun --no-env-file run site:build
~~~

The new files are in dist/site/panels. index.json contains one account entry with subject, kind, three relative paths and the sha256 of its exact JSON file. index.html is a plain list drawn by the shared kit. The pre-existing landing assets keep their original bytes. Older, unversioned constructed landing-only fixtures have no evidence store: their builds retain the landing files and emit an explicit warning instead of substituting other panel data.

An embedder can use the HTML as a frame:

~~~html
<iframe src="/panels/intents.near.html" title="Captured public facts for intents.near" width="100%" height="920" loading="lazy"></iframe>
~~~

Choose a fixed height appropriate for the host layout; longer content scrolls inside the frame. There is no resizing script or postMessage. A program can read /panels/intents.near.json. The panel's Chart and Index links are same-directory paths; when hosting one CLI output separately, place the desired index.html beside it.

## Projection API

buildPanel(store, snapshotId, subject, {beforeSnapshotId?}) returns PanelData without filesystem or network access. Sections follow identity/capture, controls, dependencies, reverse relationships, state, proposals, changes, gaps and receipts. Capture metadata is drawn by the subject header. Every row contains what, value, basis, status, factIds, evidenceIds and gap. Role rows also retain the role and the full qualified members list. None is an evidenced absence; unknown is an explicit gap with unverified status.

panelSurface(data) makes the shared kit messages. panelKitPage validates them with the data's public receipts. renderPanel(data) validates the data and returns messages, original kitHtml, composed html, exact json and the validated chart. preparePanels(store, snapshotId) computes a complete file map before any writer runs. writePanelFiles(outDir, files) writes only validated flat HTML/JSON names and refuses input overlap or symlinks.

The consumer document helper adds only a navigation region with Chart/Index and one inert application/json data block to an already validated kit page. Removing those two additions recovers the original page bytes. The HTML data block and external JSON use identical deterministic bytes. serializePanelData accepts plain JSON data, rejects cycles, non-finite numbers, accessors and unsupported values, and escapes JSON terminators. composePanelDocument(kitHtml, account, data, {chartHref,indexHref}?) rejects paths other than that account's same-directory chart and index.html.

The relation chart uses the existing flowchart generator and validator. Its generic edge provenance contains the source fact id followed by the original receipt ids; PanelData keeps these distinct as factIds and evidenceIds. A subject with no relation has one chart node and an explicit "no relation recorded" gap.

All fact rows, headings, evidence chips and styling come from the unchanged shared kit. The panel has no executable script or remote asset. The separate chart retains its own validated local viewer. Unknown coverage remains visible; panels contain no position data or policy outcome.

