# Linchpin

**Understand what your DeFi capital depends on.**

Linchpin's mission is to make DeFi understandable and its risks independently verifiable, across protocols and chains. We are building an evidence-backed risk analyst for portfolios, treasuries and vaults: what does the capital depend on, how could access or value be affected, and what supports the answer?

The current prototype reviews selected NEAR dependencies and Solana governance and protocol economics. It links recorded chain reads and attributed documents into an evidence graph, preserving what is claimed, decoded, simulated and observed. It does not yet provide comprehensive portfolio risk modelling.

## First finding: who can change NEAR Intents?

Linchpin shows what a DeFi contract depends on and who can change it. Read on NEAR mainnet on 14 November 2026, blocks 224528509–224529178:

- The Sputnik DAO `intents.sputnik-dao.near` holds super-admin and role-granting powers over `intents.near`, the contract that settles NEAR Intents.
- That DAO's `get_factory_info` reads `auto_update: true`. Its code version (Sputnik v3.1) lets the factory `sputnik-dao.near` replace the DAO's code through `update()`, with no proposal and no vote.
- The factory owns itself, so its authority is three full-access keys.

Replay it from the recorded snapshot, then compare with the committed report:

```sh
bun install --frozen-lockfile
bun --no-env-file run linchpin near intent \
  --asset nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near \
  --snapshot near-2026-11-14 --offline --out out/near-usdc-1114
cmp out/near-usdc-1114/intent-review.md fixtures/near/samples/intent-review-usdc-2026-11-14.md
```

**Expected result:** `cmp` exits 0. In the [report](fixtures/near/samples/intent-review-usdc-2026-11-14.md), the row `intents.sputnik-dao.near | upgrade | sputnik-dao.near / 1` cites the `get_factory_info` receipt, and the row `sputnik-dao.near | upgrade` lists the three keys. This is a path of control recorded at those blocks. It is not evidence that anyone has used it or intends to. The 9 November snapshot did not read `get_factory_info`, so a comparison with it reports this edge as `missing-coverage`, not as a change.

The factory `update()` path across Sputnik DAOs was also published during the hackathon by the Docket project; Linchpin's contribution is the chain from those keys to the contract behind NEAR Intents.

## Start with a cross-chain asset

**What does holding this USDC representation through NEAR Intents make me depend on, and what remains unknown about getting it back out?**

Read the [worked case](fixtures/near/samples/usdc-case.md): a specific NEAR token representation, its recorded Omni bridge mapping and control dependencies, and the limits of the available origin-chain evidence. The case explains why the observations matter and links to their receipts. A dependency path is not a probability of loss or proof that withdrawal will succeed.

Requires [Bun](https://bun.sh) 1.4 or later. From a clone of this repository:

```sh
bun install --frozen-lockfile
bun run linchpin near intent \
  --asset nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near \
  --snapshot near-2026-11-09 --offline --out out/near-usdc
```

**Expected result:** the terminal prints an intent review and the command writes `out/near-usdc/intent-review.md` and `out/near-usdc/intent-review.json`. The recorded route is `omni_bridge`; the review outcome is `partial`. The snapshot's latest observation is 9 November 2026 at 21:43:57 UTC. The report contains dated observations, evidence receipts and explicit unknowns. It is a replay, not a current-state check. No wallet, RPC credential, model service or Neo4j instance is required for this command after dependencies are installed.

To inspect the existing local risk desk:

```sh
bun run linchpin desk quantrin-near-v1 \
  --snapshot near-2026-11-09 --positions fixtures/desk/book-synthetic.json
```

Open the loopback address printed by the command. The supplied book is **synthetic**, including its quantities and holders. Find the position whose asset starts `nep141:sol-5ce3...`; explore its dependency map, evidence and unknowns. The desk shows the position subject's control graph; use the asset report above for the bridge mapping and origin-side limits. Desk marks describe the sample policy's rules, not an overall asset risk rating. The optional agent panel is not required and its availability is not a claim of a demonstrated model integration. [Desk usage and limits](src/desk/README.md).

The [NEAR reader](src/near/README.md), [preflight](src/near/preflight/README.md) and [recorded full report](fixtures/near/samples/intent-review-usdc.md) provide additional detail. Preflight checks claimed actions against recorded evidence; Linchpin does not sign or execute them.

Captured [NEAR subject panels](src/near/panel/README.md) show public facts, gaps and receipts for registered accounts in a recorded snapshot. Build one account offline:

```sh
bun --no-env-file run src/cli.ts near panel intents.near --snapshot near-2026-11-09 --out out/near-panels --offline
```

The command writes the account’s HTML panel, exact JSON twin and validated relation chart. `bun run site:build` includes all captured registry panels under `dist/site/panels/`. These files describe dated observations; they are not a live feed.

## Use cases

### Governance review

Review a Realms proposal before the vote. Linchpin decodes the payload, previews it as a conditional simulation, reads the execution receipt when there is one, and traces the control path from the touched account to the realm. Claimed, decoded, simulated and observed stay side by side; nothing is collapsed into a verdict.

**BonkDAO BIP-76.** From the proposal's instructions alone, with receipts, balances and the vote result withheld, Linchpin identifies a transfer of 4,426,104,450,305.966 BONK from the treasury token account to an account created by the same proposal. The receipt then shows 99.9999 % of the source account moved, 49 seconds after voting ended, on a vote that cleared its 1 % threshold by 0.0028 percentage points.

**Marinade MIP-14.** The proposal claimed a 30 % burn. The payload decodes to a burn of exactly 300,000,000 MNDE from the DAO's treasury token account, and the receipt shows the account falling from 438,930,393 to 138,930,393 MNDE. The 30 % holds only under the forum's claimed one-billion pre-burn supply, and Linchpin labels it as a claim.

### Protocol and token research

Answer an economic question with evidence: *is there an enforceable path from the protocol's activity to token holders, what offsets it, and who can change it?*

**Marinade and MNDE: partly.** Program code routes the liquid-unstake treasury cut (50 % of the LP fee) and the 0.2 % stake-account withdrawal fee into the treasury; the reward fee is 0 %. Moving treasury funds, buying MNDE and funding the distributor are operated by accounts: the buyback wallet received 10.9 M MNDE since December 2025, and all four distributor claims observed so far went to current MNDE lockers. A five-member council sets the fees through a council-only governance; MNDE holders vote on the DAO treasury. The claimed 10 % revenue allocation to buybacks (MIP-22) is not visible on chain and stays unresolved.

### Monitoring and due diligence

The same graph answers who can change fees, pause a program or upgrade it, which accounts a proposal shares with a protocol's tokenomics, and where a DAO's tokens went.

## How it works

1. **Read.** NEAR account state and view calls, and Solana programs' published Anchor interfaces (IDLs), account state and transactions. Recorded reads carry their block or slot, retrieval time and response hash.
2. **Decode.** Instructions, authorities, fee parameters, governance configuration, votes and receipts, with an IDL-driven Borsh decoder and the SPL Governance SDK.
3. **Link.** One evidence graph with typed relationships, in Neo4j or in memory. Every value is labelled `declared`, `decoded`, `observed`, `derived`, `claimed`, `reported` or `inferred`.
4. **Answer.** Review packets, research bundles, a local research workspace and canned graph queries. Every number opens its evidence records.

Recorded evidence replays offline and deterministically; live refresh reads current state through your endpoint and shows what changed.

## Solana research workspace

Requires [Bun](https://bun.sh) 1.4 or later.

```sh
bun install
bun test
bun run web
```

Open http://127.0.0.1:8875. The workspace starts on recorded evidence and works offline. For a guided tour of the two flagship cases, open http://127.0.0.1:8875/#walkthrough-bonk. The [workspace guide](docs/workspace.md) describes every view.

Live reads and Neo4j are optional. Configure them in an environment file outside the repository, for example `~/.config/linchpin.env` with mode 600:

For local Neo4j Community Edition in Docker, follow the [local database setup](docs/local-neo4j.md).

```sh
LINCHPIN_RPC_URL=https://your-solana-rpc-endpoint
NEO4J_URI=neo4j+s://your-instance.databases.neo4j.io
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=your-password
```

```sh
bun run web:live
```

Credentials never reach the browser, the evidence or the output files; only the redacted host is shown.

### Command line

```sh
bun run linchpin review cases/mip-14.json --offline         # one governance review packet
bun run cases                                               # every recorded governance case
bun run linchpin pack packs/marinade/pack.json --offline    # Marinade control and supply map, DAO treasury ledger
bun run linchpin doctor                                     # check the configured RPC endpoint
```

Each review writes `packet.json`, `packet.html`, `graph.json` and `evidence.jsonl` under `out/<case>/`. `--record` fills missing evidence from the configured endpoint and `--record --refresh` re-reads it; `--offline` uses recorded evidence only.

Research layers and graph loaders:

```sh
bun run scripts/record-contracts.ts --offline                                       # contract, participation, authority, holder and flow layers
bun --env-file="$HOME/.config/linchpin.env" run scripts/load-neo4j.ts               # governance cases into Neo4j
bun --env-file="$HOME/.config/linchpin.env" run scripts/load-tokenomics-neo4j.ts    # tokenomics graph into Neo4j
```

Both loaders accept `--dry-run`.

## Reading the evidence

| Basis | Meaning |
| --- | --- |
| Declared | From a program's on-chain interface definition: structure, roles, accounts |
| Decoded | From instruction bytes or account state decoded at a stated slot |
| Simulated | A conditional preview with its payload, capture slot and assumptions; never proof of authorization or safety |
| Observed | From transactions and receipts: balances moved, instructions executed |
| Derived | Computed from decoded or observed values, with the method stated |
| Claimed | A statement from documentation, a forum or a proposal, kept with its source and retrieval time |
| Reported | A figure from a third party, attributed |
| Inferred | A labelled conclusion that the evidence does not establish directly |

Statuses stay explicit: `verified`, `claimed`, `contradiction`, `unresolved` and `outside-scope`. Unknown programs and unsupported instructions stay visible as unknown; missing evidence stays missing.

## Repository layout

| Path | Contents |
| --- | --- |
| `src/chain/` | Recording RPC client, evidence records, redaction, transaction-version handling |
| `src/governance/` | Realms reader, instruction decoding, effects, conditional simulation, receipts |
| `src/contracts/` | IDL reading and Borsh decoding, instruction inventory, authorities, participation, flows, holders, governance configuration |
| `src/tokenomics/` | Research sections, the tokenomics API contract, evidence lookup, bundle cache |
| `src/graph/` | Graph builders and Neo4j loaders with regression checks |
| `src/web/` | Research workspace server and interface |
| `cases/`, `packs/` | Governance case specifications; protocol registries and captured sources |
| `fixtures/` | Recorded mainnet evidence used for replay and tests |
| `tests/` | Unit, replay and integration tests |
| `docs/` | [Workspace](docs/workspace.md), [tokenomics API](docs/tokenomics-api.md), [contract reading](docs/contracts.md), [Neo4j: governance cases](docs/neo4j.md), [Neo4j: tokenomics graph](docs/neo4j-tokenomics.md), [plan harness](docs/harness.md) |

## Scope

Linchpin checks economics and control against chain state. It is not a code audit and does not search programs for bugs. A successful simulation is a conditional preview: signature verification is disabled and the blockhash replaced, so it proves neither authorization nor safety. Recorded state at a capture slot is not historical pre-execution state. Prices, ratings and investment recommendations are out of scope.

## Roadmap

The longer-term analyst will connect look-through exposures, yield sources, exit constraints and shared dependencies across chains. Each expansion needs its own evidence coverage and explicit model assumptions. The current dependency reviews are a foundation for that work, not a complete assessment of a portfolio's possible losses.

## NEAR integration

Linchpin existed as a Solana research project before the NEAR integration. The NEAR work adds recorded NEAR account and view-call evidence, Intents asset dependency reviews, governance reviews, policy checks, a read-only preflight and the local risk desk. The worked USDC case is the place to start. Existing Solana cases and later Solana work are separate from it.

The public [`pre-hackathon` baseline](https://github.com/lazyquant/linchpin/tree/pre-hackathon) and the [diff from that baseline to the current public branch](https://github.com/lazyquant/linchpin/compare/pre-hackathon...HEAD) show what the NEAR work changed. The diff also contains shared and Solana changes.

Reused foundations include this repository's evidence/receipt model, graph queries and Solana readers. Third-party libraries are listed in [package.json](package.json), with exact dependency versions in [bun.lock](bun.lock); the implementation uses Bun, TypeScript, Neo4j's driver and Solana SDKs. AI coding assistance was used. The route classification records the NEAR Intents SDK rule version alongside the result. There is no live 1Click quote in this demonstration and no transaction execution.

To reproduce the demonstration, follow **Start with a cross-chain asset** above. Bring a difficult DeFi position, inspect a receipt, or challenge a relationship in the graph.

## License

Apache-2.0. See [LICENSE](LICENSE).
