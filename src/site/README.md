# Landing page

A static page built with Bun. Every fact on it is rendered at build time from committed, receipted fixtures.

Review excerpt directories in `content.ts` are relative to the repository root.
Intent uses the first ten lines of `fixtures/near/samples/intent-review.md`, matching
the wrap.near command. Governance uses ten lines starting at `- council ·` in
`fixtures/near/samples/governance-review.md`: voting authority, expiry, fund movement
and ownership. The risk card retains its existing test sample until its report is
committed. Missing files do not fall back to another directory.

`bun run site:build --samples <directory>` overrides the directory for every card,
using the configured filenames and excerpt prefixes. `--strict` fails on a missing
file or unusable excerpt; otherwise that card shows the pending message. The run
instructions always show the report's first line, independently of the excerpt start.

## Captured panels

The normal build also writes `panels/<account>.html`, `.json` and `.chart.html` for each registered subject in the selected evidence snapshot, plus `panels/index.html` and `panels/index.json`. The JSON index records account, subject, kind, relative file paths and the sha256 of the exact JSON file. All panel rows and styling are drawn by the shared evidence kit; the two file links and extra inert data block are the bounded document additions.

Adding panels leaves existing landing assets unchanged. Legacy unversioned constructed landing-only inputs have no evidence store: their builds retain the landing output and warn explicitly instead of substituting panel data. See [the panel guide](../near/panel/README.md).
