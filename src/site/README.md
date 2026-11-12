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
