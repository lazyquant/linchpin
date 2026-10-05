# Linchpin

## What Linchpin is

Linchpin is the dependency engine for protocol economics and tokenomics. Its first application is Solana governance review: a TypeScript CLI that turns a Solana Realms proposal into a reproducible review packet, keeping claims, decoded instructions, conditional simulations and observed execution separate. The demo produces JSON and static HTML from committed evidence fixtures, with a control path from the treasury token account to governance. It needs no server, database or LLM.

## What the demo shows

The demo reviews two real Marinade MIP-14 proposals:

- **Execution proposal:** “MIP-14: Burn 30% of MNDE Total Supply.” The payload decodes to a burn of **300,000,000 MNDE** from the governance's treasury token account. The receipt records a source-account change of exactly **−300,000,000 MNDE** and matches the decoded effect.
- **Opinion proposal:** “MIP-14: Burn 0–50% of MNDE Total Supply.” Its five options contain no instructions. The packet says **“no executable payload: signaling only”** and treats execution eligibility as not applicable.

The execution proposal's **30% is a claim**. The decoded 300,000,000 MNDE matches that percentage only under the **forum claim of 1,000,000,000 MNDE pre-burn supply**; on-chain pre-execution supply was not captured. Other forum figures remain captured claims for human review.

The recorded historical-payload preview fails with insufficient funds against the state at its capture slot. A separately labelled fixture that burns **1 MNDE** succeeds. Both results are conditional previews. The successful historical receipt remains separate from those previews. The unrelated assertion-guard program in the receipt is kept visible in the reconciliation notes.

BonkDAO BIP-76 “Sowellian BonkDAO” adds a treasury-transfer case. Its description matched the payload: send 4,426,104,450,305.966 BONK to the stated recipient's token account. The packet flags the effectively full-treasury transfer (33 raw units left) to a destination that held 0 before execution, a hold-up of 0 with the transfer executed 49 seconds after voting ended, and a quorum cleared by about 0.0028 percentage points. The proposal entered execution after 38 seconds. Outlet reports remain attributed claims; voter count and concentration are not analysed. This is a historical review, with no claim that Linchpin detected or would have detected it before execution.

## Run instructions

The build plan uses Bun 1.4.2. For initial setup, with package access available:

```sh
bun install
```

With dependencies already installed, run the demo offline from the repository root:

```sh
bun run demo
open out/mip-14/packet.html out/mip-14-opinion/packet.html out/bonk-bip76/packet.html
```

All three cases replay from committed fixtures (`fixtures/<case>/`), recorded from public mainnet RPC on 2026-10-05; `--record` refreshes them when network is available.

`bun run demo` uses `--offline` and replays the committed fixtures. To demonstrate that it does not depend on a reachable RPC endpoint:

```sh
LINCHPIN_RPC_URL=http://127.0.0.1:1 bun run demo
```

The output reports `historical-payload=fail fixture=ok` and `observed: all receipts match decoded effects` for MIP-14. The opinion control reports `not executed` and `no simulation`. Each case writes `packet.json`, `packet.html`, `graph.json` and `evidence.jsonl` under `out/<case-id>/`.

Review one recorded case or run the checks:

```sh
bun run linchpin review cases/mip-14.json --offline
bun test
bun run typecheck
```

The timed walkthrough is in [docs/demo-script.md](docs/demo-script.md).

## How to read a packet

Start with the four evidence columns:

| Basis | What it tells you |
| --- | --- |
| **Claimed** | Proposal and forum statements, with their source and retrieval time. A statement's presence does not verify it. |
| **Decoded** | Supported instruction bytes and their effects, including treasury movement and supply change. Unsupported instructions remain `unknown`. |
| **Simulated** | Conditional previews, labelled by payload, capture slot, assumptions, logs and success or failure. The 1 MNDE fixture is an altered payload. |
| **Observed** | The historical execution receipt and reconciliation with the decoded effect, including token balance changes and other programs in the transaction. |

Follow the **control path**: treasury token account → native treasury PDA → governance → Marinade DAO. This identifies the account-control relationships behind the burn authority.

Read the checks and the five dimensions separately:

| Dimension | MIP-14 execution packet |
| --- | --- |
| `description_matches_effects` | `covered (see assumptions)`; the percentage depends on the unverified supply claim, and free-text claims remain unchecked. |
| `execution_eligible` | `already executed (historical)` |
| `simulation_result` | Historical payload failed; the labelled 1 MNDE fixture succeeded. |
| `execution_status` | `observed: all receipts match decoded effects` |
| `policy_result` | `no policy configured: human review required` |

The packet includes a `bindingSha256` for the payload. A changed payload changes the binding and invalidates a review decision tied to the earlier binding. The generated review decision is `not-recorded`; a human records approve, reject or needs-work against the binding.

## What it does not claim

- A successful simulation does not prove authorization, governance execution eligibility or safety. Signature verification is disabled, the recent blockhash is replaced, and the preview is not submittable.
- State at a preview's capture slot is not the historical pre-execution state. Offline replay uses recorded state; it does not refresh today's balances.
- The forum's pre-burn supply and other forum figures are claims. The packet does not establish on-chain pre-burn supply or machine-check every prose statement.
- There is no policy engine or automatic approval. Unsupported programs and instructions need review; this slice does not decode arbitrary instructions or analyze program upgrades.
- The demo does not yet map downstream dependencies or evaluate voter-weight anomalies. Its checks are separate review dimensions, not a single safety verdict.

## Roadmap

Planned work after this demo includes MIP-21, broader destination history, voter concentration checks and the Python core. The next demonstration direction is the MIP-21 treasury exchange, a dependency map to mSOL and protocol fees, and a pilot with one DAO. These are roadmap items, outside the current demo.

## Licence

Apache-2.0. See [LICENSE](LICENSE).
