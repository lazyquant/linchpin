# What does this USDC representation depend on?

Linchpin's mission is to make DeFi understandable and its risks independently verifiable, across protocols and chains. This case is a bounded example: it connects one asset's recorded dependencies to questions about control and access, with evidence the reader can inspect.

**Question:** What does holding this USDC representation through NEAR Intents make me depend on, and what remains unknown about getting it back out?

**Asset:** `nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near`.

**Scope:** recorded NEAR mainnet evidence in `near-2026-11-09`, with latest observation at `2026-11-09T21:43:57.668Z`. The reads span blocks 223810396–223824327; they are not a simultaneous cross-chain snapshot. The [full report](intent-review-usdc.md) has outcome `partial`. This narrative is an authored explanation of that report, not a new simulation or an automated economic model. No real user's holding is assumed.

## 1. The representation has a bridge dependency

The recorded `omni.bridge.near` mapping associates this NEAR token with `sol:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`, and a reverse lookup returns the NEAR token. The token's captured state decodes to controller `omni.bridge.near`. The report classifies the route as `omni_bridge` under its recorded SDK 0.95.0 rules. [Route evidence](intent-review-usdc.md#route-evidence), [raw route reads](../near-2026-11-09/intents/route-reads.json).

**Why it matters:** the representation adds a bridge/control dependency to the question about the underlying asset. For a withdrawal relying on this bridge path, the bridge's applicable controls and origin-side settlement behaviour need examination. The mapping identifies an association; it does not establish available backing, successful redemption or current Solana-side security.

## 2. Access depends on more than the token label

At the recorded NEAR observations, `intents.near` was not paused. Its ACL assigned `Upgrader` to `ctl-intents.near`, `PauseManager` to seven accounts and `UnrestrictedAccountLocker` to two accounts. These are observed configuration facts, not a record of those accounts taking action. [Control interpretation and receipts](intent-review-usdc.md#control), [raw ACL response](../near-2026-11-09/5ba855a7de713bf7beaba66b28dc315040052ad6aa9ce8d33c15bb568f08d005.json), [raw pause response](../near-2026-11-09/c5d106d093a012e8b2a1e4aef2e35f2c7901614d2fcebe79d9a037a086539888.json).

**Why it matters:** these are distinct control questions behind an Intents-held balance. If a relevant operation is covered by a pause or account lock, exercising that control could affect access; an upgrade can change the code that governs later operations. This case does not trace every method's guards, simulate a withdrawal, predict an intervention or estimate its likelihood or duration. “Not paused at capture” does not answer “can I exit now?”.

The graph connects these subjects and their evidence so the analysis can move from the asset to the relevant control path. The path is a way to locate the next question; reachability alone is not proof of a loss mechanism.

## 3. The evidence stops before a complete withdrawal assessment

The review explicitly records `origin-chain-balance-not-read` and `omni-solana-derivation-path` as missing coverage. An origin-program authority appears as a reported research claim, with a conflict/coverage warning, rather than a fresh Solana observation. No 1Click quote is recorded. [Origin and unknowns in the full report](intent-review-usdc.md), [attributed origin report](../near-2026-11-09/intents/reported.json).

**What is still needed:** dated origin-side custody balances, the applicable program and authority state, evidence connecting the signing/derivation path, and the exact intended withdrawal's guards and settlement path. A current quote or an execution receipt would answer additional questions, but neither is supplied here. The case also does not quantify liquidity, depeg exposure or portfolio-level loss.

The useful result is a supported dependency explanation and a precise list of unresolved questions. It is not a safety verdict.

## Inspect the evidence

Each receipt below resolves in the replayed `intent-review.json`. The links open the underlying recorded responses; for the route-read collection, search for the complete response hash. Times are UTC on 9 November 2026. A hash identifies retained bytes, not an independent guarantee that their interpretation is correct.

| Claim | Basis / status | Receipt and observation | Raw source |
|---|---|---|---|
| NEAR token maps to the named Solana mint | observed / verified | `route:3a2b8d6ed8cde5cfd9016fccf444ed0ad95cb6f8`; block 223824233, 21:43:03.557 | [Route reads](../near-2026-11-09/intents/route-reads.json); response SHA-256 `b885d71a468233474559275dfe7a66d142dbee43897b190a3da1a24d61e5cb73` |
| Reverse mapping returns this NEAR representation | observed / verified | `route:f66ff37f2d8de8e689bc7ef98478939d6cb556c1`; block 223824235, 21:43:04.564 | [Route reads](../near-2026-11-09/intents/route-reads.json); response SHA-256 `f332bb5c47aae3f5f1965daa3cc17c96acf17e86cd882032fcc138c4e2a2ab53` |
| Token controller decodes to `omni.bridge.near` | decoded / verified | `route:7ec56fbc599977ed2c53a0aae035fc73fd7bb12f`; block 223823983, 21:40:39.455 | [Route reads](../near-2026-11-09/intents/route-reads.json); response SHA-256 `b4b0f0c31668da3d08a001a0efb99bc026c51cb71a7db77a04b9bfa0ba27a01e` |
| Intents upgrade, pause and account-lock role grants | observed / verified | `nr:near-2026-11-09:5ba855a7de713bf7beaba66b28dc315040052ad6`; block 223810509, 19:31:30.348 | [ACL response](../near-2026-11-09/5ba855a7de713bf7beaba66b28dc315040052ad6aa9ce8d33c15bb568f08d005.json); response SHA-256 `dadecc7e3ebacff1fbd443578491a97de1316c073193b05e1867f6ce761da756` |
| Intents was not paused at capture | observed / verified | `nr:near-2026-11-09:c5d106d093a012e8b2a1e4aef2e35f2c7901614d`; block 223810512, 19:31:32.373 | [Pause response](../near-2026-11-09/c5d106d093a012e8b2a1e4aef2e35f2c7901614d2fcebe79d9a037a086539888.json); response SHA-256 `c0e3830f68974a33524f9554e049afb9dde510aba4f0de4a10c6228aa8338b1b` |

The RPC host is `archival-rpc.mainnet.fastnear.com` for these rows except the decoded controller state, which came from `rpc.mainnet.fastnear.com`. The [snapshot manifest](../near-2026-11-09/manifest.json) and [Intents extension manifest](../near-2026-11-09/intents/manifest.json) bind the stored captures. Query reasons and the raw response remain available even when a conclusion is undetermined.

## Replay it

From the repository root with Bun 1.4 or later:

```sh
bun install --frozen-lockfile
bun run linchpin near intent \
  --asset nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near \
  --snapshot near-2026-11-09 --offline --out out/near-usdc
```

The command prints the report and writes Markdown and JSON to `out/near-usdc/`. The Markdown should match the [recorded full report](intent-review-usdc.md) byte for byte:

```sh
cmp fixtures/near/samples/intent-review-usdc.md out/near-usdc/intent-review.md
```

No output and exit code 0 means the bytes match. This checks replay, not the completeness of the assessment. In the JSON, `legs[0].classification.routeEvidence` holds the mapping and controller observations; `control` holds the interpreted control rows; `origin.lacks`, `unknowns` and `quoteNotRecorded` expose the limits; `receipts` links the claims to source observations.

The [README](../../../README.md) provides the local desk command. Its example positions and quantities are synthetic. A model service is optional and is not required for this review.
