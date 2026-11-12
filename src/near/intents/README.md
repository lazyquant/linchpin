# Intent review

`bun run linchpin near intent --asset nep141:wrap.near --offline` writes a receipted Markdown and JSON review.
Use `--from <asset> --to <asset> --amount <integer> --offline` to replay a recorded dry quote.
The shipped asset reviews show "not recorded", citing the retained HTTP 400 deadline-required attempt. Live quotes were skipped by decision; the dry-quote path is exercised with synthetic responses offline.
The retained failure has a request hash, response-body hash and date, but no raw response body or quote figures.
Quote replay without a recording exits 1 with `missing-fixture`; asset reviews exit 0 (including partial or unknown outcomes) and never call the network.
`capture --snapshot <id> --record --dry-run` describes an extension without network or writes; omit `--dry-run` to capture.
`--before <id> --after <id>` selects a change pair, with constructed provenance labelled.
For `.omft.near`, use `classifyAsset(id, ctx.rules, ctx.routeEvidence)` with `ctx = loadIntentContext()`; absent chain evidence stays undetermined.
Quote figures are claims outside the evidence store; signature verification is not performed.
Origin labels do not establish custody. Missing controllers and history remain explicit reasons.
