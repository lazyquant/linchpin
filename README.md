# Linchpin

**The dependency engine for protocol economics.**

Linchpin reads a protocol's programs, live state and transactions straight from Solana mainnet and links them into one evidence graph. Every value carries its basis: what the protocol *claims*, what the code *allows*, and what *happened* on chain. Funds, DAOs and protocol teams use it to see who controls what, what a proposal moves, and which claims hold, before they allocate, vote or ship a change.

> Follow the money. Find the control. Verify the claim.

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

1. **Read.** Programs' published Anchor interfaces (IDLs), account state and transactions through any Solana RPC endpoint. Every read is recorded with its slot, retrieval time and response hash.
2. **Decode.** Instructions, authorities, fee parameters, governance configuration, votes and receipts, with an IDL-driven Borsh decoder and the SPL Governance SDK.
3. **Link.** One evidence graph with typed relationships, in Neo4j or in memory. Every value is labelled `declared`, `decoded`, `observed`, `derived`, `claimed`, `reported` or `inferred`.
4. **Answer.** Review packets, research bundles, a local research workspace and canned graph queries. Every number opens its evidence records.

Recorded evidence replays offline and deterministically; live refresh reads current state through your endpoint and shows what changed.

## Quick start

Requires [Bun](https://bun.sh) 1.4 or later.

```sh
bun install
bun test
bun run web
```

Open http://127.0.0.1:8875. The workspace starts on recorded evidence and works offline. For a guided tour of the two flagship cases, open http://127.0.0.1:8875/#walkthrough-bonk. The [workspace guide](docs/workspace.md) describes every view.

Live reads and Neo4j are optional. Configure them in an environment file outside the repository, for example `~/.config/linchpin.env` with mode 600:

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
| `docs/` | [Workspace](docs/workspace.md), [tokenomics API](docs/tokenomics-api.md), [contract reading](docs/contracts.md), [Neo4j: governance cases](docs/neo4j.md), [Neo4j: tokenomics graph](docs/neo4j-tokenomics.md) |

## Scope

Linchpin checks economics and control against chain state. It is not a code audit and does not search programs for bugs. A successful simulation is a conditional preview: signature verification is disabled and the blockhash replaced, so it proves neither authorization nor safety. Recorded state at a capture slot is not historical pre-execution state. Prices, ratings and investment recommendations are out of scope.

## Roadmap

- **Alerts on control changes:** notify when fees, authorities, upgrade rights or governance configuration change, or when a proposal that touches them is created.
- **Pre-vote exposure:** dated pre-execution balances and policies, so a review states how much of a treasury a payload moves before the vote.
- **Live tokenomics refresh:** the research view refreshed from chain like the governance cases, with a diff against the last capture.
- **More Solana protocols:** registries and fee-route maps for further Anchor and Realms protocols; the readers for interfaces, authorities and governance are protocol-independent.
- **Deeper governance analysis:** treasury exchanges, voter concentration and delegation, veto paths.
- **Hosted workspace and API** for funds, DAOs and protocol teams.
- **Claim extraction:** documentation and forum claims captured with an agent layer, always checked against chain evidence.
- **EVM readers** on the same evidence model.

## License

Apache-2.0. See [LICENSE](LICENSE).
