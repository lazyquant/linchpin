# Marinade contract interfaces and parameter control

The G1 / G2-first-part layer reads program interfaces and selected account state through `RecordingRpc`. It does not use the spike IDLs in `tests/vectors/idl/` as evidence. Those files are test inputs only. No changes to the existing pack registry, pack output, web UI or pack fixtures are required.

## Reads and output

`src/contracts/marinade.ts` consumes `packs/marinade/registry.json` and `packs/marinade/contracts.json` and produces:

- Every registry program's upgrade-authority read and classification, on-chain legacy Anchor IDL (or an evidenced absence), IDL authority, hash, and instruction inventory. Nested instruction account groups become dotted paths; signer and writable flags remain the IDL's declarations.
- The liquid-staking `State` singleton and the MNDE VSR `Registrar` singleton. The latter is derived under VSR using the realm, UTF-8 `registrar`, and MNDE mint seeds. Owners and account discriminators must match before decoding. Missing required singletons or IDLs fail explicitly.
- All configured full account enumerations, filtered by base58-encoded discriminator at memcmp offset zero, with every account decoded. Count enumerations use the same filter and `dataSlice: { offset: 0, length: 0 }`; their output contains only a count and provenance, not account rows.
- Twenty liquid-staking parameters, ten classified authority/account references, both treasury/LP mSOL token balances, the inferred parameter-control map, and Registrar voting settings with classified realm and grant authorities.
- Checks against the registry's mSOL/LP mints, Registrar realm and governing mint, and MNDE's presence among voting mints. These checks report `verified` or `contradiction` rather than hiding unexpected state.
- Registry claim `v1`: `verified` exactly when decoded `rewardFee.basisPoints` is zero; otherwise `contradiction`, with the decoded basis-point value stated first.

The output is `out/contracts-marinade/contracts.json`, with its evidence records embedded. An additional `evidence.jsonl` is appended by the recorder. Big integers are decimal strings, public keys are base58 strings, and byte arrays are base64. Ordinary Borsh vectors/arrays remain JSON arrays, including `vec<u8>` and `[u8; n]`; the Borsh `bytes` type is a byte array. Enum values use `{ variant, fields }`, where `fields` is omitted for unit variants, an object for named fields, or an array for tuple variants.

IDL `dataLength` is the compressed payload length from the account header. `idlSha256` hashes the exact decompressed JSON bytes, preserving their whitespace. Account `bytesRead` includes the eight-byte discriminator; `trailingBytes` reports unconsumed allocation and is not silently treated as decoded fields. The reader rejects invalid tags, unknown types, truncated reads and non-finite floats with field paths. It limits nesting to 128 and decoding to one million values to keep malformed layouts/lengths bounded.

## Provenance vocabulary

Every evidence-bearing row has `basis`, `slot`, and `evidenceIds`:

| Basis | Meaning in this layer |
| --- | --- |
| `decoded` | Values decoded from account bytes, account ownership classifications, and counts of discriminator-filtered RPC results. This describes extraction, not verified economic behaviour. |
| `declared` | Interface, argument, account and signer structure published in an on-chain IDL. |
| `inferred` | Argument/field name matches, signer-role/holder matches, and the explicit pause/resume name mapping. |
| `derived` | PDA calculations, including the IDL and Registrar addresses and native-treasury PDA classifications. |

Rows derived from a singleton use its account-read slot and link both account and IDL evidence. Nested classifications and balances keep their own observation slots. IDL inventory rows use the IDL slot. The layer's `asOfSlotRange` spans all reads: recording is not an atomic snapshot. PDA input values from the registry/contracts inputs are declarations; a derived address alone is not proof of its account contents.

An IDL is a layout declaration. A successful decode, correct discriminator and independent registry mint checks strengthen confidence in the layout, but neither prove that an instruction implements a setter nor establish its full authorization rules. Classification reuses `classifyAuthority` with the registry's governance program and the realm's governances discovered through `listGovernances`. `dao-governance-account` reflects program ownership; it is not by itself proof of council membership or a voting threshold.

## Record and replay

From the repository root, with `LINCHPIN_RPC_URL` supplied securely in the environment:

```sh
bun run scripts/record-contracts.ts --record
```

The case ID is `marinade-contracts`, and fixtures go under `fixtures/marinade-contracts/`. Recording fills missing fixtures and reuses existing ones. A failed capture can be resumed with the same command. To recapture every read, use:

```sh
bun run scripts/record-contracts.ts --record --refresh
```

To replay without any network calls:

```sh
bun run scripts/record-contracts.ts --offline
```

Offline mode fails with the RPC method and expected fixture path if anything is missing. It never falls back to test vectors or a live call. `--offline --refresh` still replays. With no mode flag, the script records unless `LINCHPIN_OFFLINE=1`; explicit `--record` overrides that environment setting. Explicit `--record` and `--offline` together are rejected. Existing recorder timeout, throttling, retry, redaction and refresh environment settings apply.

The script prints IDL and singleton counts, each enumeration count, parameter and unique classified-address counts (including upgrade, State, Registrar and matched signer holders), claim v1's result, failed known-value checks, the price sanity check and RPC replay/live totals. It only writes the output after the complete layer builds. A successful process exit means capture/build completed; callers should also inspect the reported checks and claim status.

Run verification with:

```sh
bun test
bun run typecheck
```

The four mainnet-fixture tests in `tests/contracts-marinade.test.ts` explicitly skip while the fixture directory is absent or contains no JSON files. Once any JSON fixture exists, incomplete captures fail loudly instead of being skipped. Synthetic RPC tests exercise the whole layer without network access or fixture writes.

## Field semantics and assumptions

| Fields | Interpretation |
| --- | --- |
| `rewardFee`, `liqPool.treasuryCut`, `liqPool.lpMinFee`, `liqPool.lpMaxFee`, `maxStakeMovedPerEpoch` | `Fee.basisPoints`: basis points, denominator 10,000. The last field represents a movement-limit proportion; the shared Fee encoding does not imply a charged fee. |
| `delayedUnstakeFee`, `withdrawStakeAccountFee`, `depositSolFee`, `depositStakeAccountFee` | `FeeCents.bpCents`: hundredths of a basis point, denominator 1,000,000. |
| `liqPool.lpLiquidityTarget`, `stakingSolCap`, `liqPool.liquiditySolCap`, `minDeposit`, `minWithdraw`, `availableReserveBalance`, `circulatingTicketBalance` | Lamports, not SOL UI amounts. These state balances are not assumed to equal current account lamports or reconciled totals. |
| `paused` | The decoded Borsh boolean; enforcement and the scope of the pause are not established. |
| `msolPrice` | Raw u64 divided by 2^32, interpreted as SOL per mSOL using the Marinade source convention supplied with the task. This source was not independently fetched. The output explicitly labels the assumption and checks the inclusive heuristic range 1–3. A failure is preserved as `sanityCheck.passed: false`; no price is clamped or replaced. The raw integer is exact; the displayed ratio is a floating-point approximation. |
| `msolSupply` | Raw mSOL token units, without assuming a decimal conversion or reconciling against the mint supply. |
| `circulatingTicketCount` | Integer ticket count. |
| `stakeSystem.stakeList`, `validatorSystem.validatorList` | `List` structs; their `.account` fields are the addresses classified. Other members are list metadata. |
| Other State authority and account fields | The named public key is classified as an account reference. Operational accounts, token accounts, mints and list accounts are not thereby identified as signers or ultimate controllers. |
| Registrar `realm`, `realmGoverningTokenMint`, `realmAuthority` | Direct decoded public keys; governing mint is presented as `governingTokenMint`. |
| Registrar voting mints | `mint`, signed `digitShift`, raw `baselineVoteWeightScaledFactor`, raw `maxExtraLockupVoteWeightScaledFactor`, `lockupSaturationSecs` in seconds, and `grantAuthority`. No denominator, voting-power formula, or multiplier is assumed for the raw scaled factors. All slots are retained; a zero public key is not interpreted as an active mint or an effective grant authority. |

Parameter matching ignores case and underscores in leaf names and includes nested state paths. The explicit argument aliases are `rewardsFee → rewardFee`, `admin → adminAuthority`, and `validatorManager → validatorSystem.managerAuthority`. For each argument, the matcher considers the argument itself and one level of a defined struct's fields (also through option/coption wrappers). Struct containers that do not match remain in `unmatched`, even when their children match. Ambiguous names remain unmatched with their candidate paths. No arguments are silently discarded.

Signer roles use the same normalized field-name rules and aliases to identify a unique State public key. If no such field exists, the holder and classification remain null with an explicit unresolved reason. A setting's signer list can include operational/user signers: name matches are not proof of administrative control. The no-argument `pause` and `resume` instructions are explicitly mapped to `paused` by instruction name and marked inferred. Parameters without matches remain visible with an unresolved note.

Legacy `option` uses a one-byte tag; `coption` uses a four-byte little-endian tag. In this reader, a zero tag consumes no value payload. Arrays and vectors retain order; enums use a one-byte variant index. The supported grammar is the legacy Anchor IDL format, not Anchor's newer IDL schema or arbitrary Rust/C memory layouts. Trailing bytes are permitted, but Borsh reads inside the declared layout must fit exactly within the available data.

## Participation (G3)

`readParticipation(rpc, registry, contracts, layer)` in `src/contracts/participation.ts` consumes the G1 layer and writes `out/contracts-marinade/participation.json`. The record script runs this after G1, then authority resolution. All reads use `RecordingRpc`; runtime code never reads test IDL vectors. Existing G1 full enumerations are reused; count-only enumerations become separate full reads for participation. The original fixture keys remain unchanged.

The output includes:

- MNDE Registrar-filtered VSR Voters, decoded used deposits, voter authorities, exact native amounts and nine-decimal display strings, mint supply, supply shares, totals by decoded lockup variant and remaining-time bucket, top 20 voters, and top-10 concentration. `totalDeposited` includes unlocked used deposits; `timeLocked` excludes the `none` bucket. The summary prints both. Unused deposits are excluded even if their serialized amount is nonzero. Used deposits for other configured mints contribute voting power but never MNDE totals or MNDE vault reconciliation. Invalid mint indexes fail the read.
- Per-voter vault reconciliation, counts of matched/mismatched/missing vaults, first ten mismatch examples, and grand totals of deposits and available decoded vault balances. Missing balances are null per voter; grand totals sum only readable balances. The vault is **assumed** to be the associated token account of `(Voter account, MNDE mint)`, allowing the off-curve Voter owner. Batches have at most 100 accounts. Token program/layout, token mint and token owner are checked in addition to amount. An invalid token account is mismatched; a missing account is missing. Neither is silently repaired. An unexpected but readable token balance remains visible in the reconciliation total alongside its mismatch reason.
- Registrar voting configurations and a separate derived voting-power estimate, per used deposit and per voter, with total and top-20 share ranked by voting power. The formula attribution is **claimed from voter-stake-registry 0.2.x**, `programs/voter-stake-registry/src/state/{deposit_entry,voting_mint_config,lockup}.rs`; it was not fetched or independently verified during this offline implementation. This implements the duration formula requested for G3: shift the deposited native amount by `10^digitShift` (divide for a negative shift), calculate baseline and maximum extra using factors scaled by `1_000_000_000`, then add `extra × min(remaining, saturation) / saturation`. Integer division truncates at each step. Nonzero extra with zero saturation fails explicitly. This is a duration-based estimate, not a verified simulation of Daily/Monthly vesting, initially locked balances or an executable VSR voting instruction. The source claim has `basis: claimed`; computed weights have `basis: derived`; decoded amounts stay separate.
- Full Realm, Gaugemeister, Gauge, Escrow, GaugeVoter and GaugeVote rows from escrow-relocker, counts, sums of numeric amount/weight/count fields, and escrow amounts grouped by realm. Escrow totals across realms are raw units, not assumed to all be MNDE. The captured Escrow IDL has NFT mint/vault references but no owner or explicit lockup-end field. Owners and lockup ends are therefore null with an explanation. Decoded state, `claimTime` and `cooldown` remain visible; neither NFT ownership nor end-time semantics are invented. GaugeVoter/GaugeVote references and weights remain visible without assigning an unstored owner.
- Newest 25 signatures for each of the nine Anchor programs, known newest/oldest block times, and an activity-rate estimate. The estimate is the number of signatures with known times divided by elapsed days between the endpoints; null or zero-length windows give null. Signatures include failed transactions and address mentions, so activity is not proof of successful calls. `dormant` is true only when the newest known transaction is more than 30 days older than `asOf`; empty or untimed results, or an unknown timestamp on the newest signature, give null. This is the evidence window for Q18, not a claim about the entire program history.
- Directed-stake Roots and all VoteRecords, counts grouped by the IDL's `target`, top 20 targets, and the total. This IDL has no amount or weight field; neither a stake balance nor a weight is invented. Targets remain public keys without assuming they are verified validator vote accounts.
- Referral GlobalState and all ReferralState rows, stored partner names/accounts, fee and accumulated amount fields. `Pct` fields are percent by name, explicitly described as a name-based claim. The captured IDL does not document fee denominators or token denominations; these stay raw with units marked unverified. Full operation counters and other state fields are retained in rows.
- All Native proxy Roots (the spike counted 40; that number is not forced), distinct `admin`, `operator` and `alternateStaker` addresses classified against the full recorded realm governance discovery, and the Roots each serves. No fee is invented: this Root IDL has no fee field.
- A count-mode TicketAccountData read filtered to the decoded liquid-staking State, alongside its circulating ticket count and lamport balance. Count agreement is reported; differing read slots can produce a real disagreement. Ticket balances are not independently summed in count mode.

Voter and ticket filters compute their field offsets from the on-chain IDL's fixed-width prefix, including the Anchor discriminator. A variable-width prefix fails explicitly instead of using a guessed offset. No spike offsets are used in production.

Every aggregate figure has `value` (or exact `raw`/`display` for MNDE amounts), `basis`, `slot`, `asOf` and `evidenceIds`. Decoded account rows carry provenance for all fields in their `value` struct; those raw structs retain their IDL shape. `slot` is the highest non-null slot among the figure's evidence. `asOf` is the latest evidence `retrievedAt` across the G1 layer and participation reads, including replayed evidence timestamps; the current machine clock does not change an offline replay. Evidence records are embedded. Reads are not an atomic snapshot, and a resumed record can mix old and newly captured state. Use `--refresh` for a full recapture.

Bucket rules use `asOf` in Unix seconds: `None` or expired → `none`; `(0,30 days)` → `under 30 days`; `[30,180 days)` → `30–180 days`; `[180,365 days]` → `180 days–1 year`; greater than 365 days → `over 1 year`. For `Constant`, remaining time means `max(endTs - startTs, 0)`, including when the stored end is already in the past. Other kinds use `max(endTs - asOf, 0)`. One day is 86,400 seconds and one year is 365 days. Registrar `timeOffset` is reported but not applied to this requested wall-clock estimate. These same duration rules feed the voting estimate. Bucket membership and time-locked amounts have derived provenance.

Supply shares use the MNDE mint read through the recorder in this run, require nine decimals, and are fractions (0–1), truncated to twelve decimal places. Zero denominators give null. `top10ShareOfDeposits` and `top10ShareOfSupply` explicitly distinguish concentration among Voters from concentration in the entire mint supply. Deposits and bucket totals retain exact decimal-string integers.

### Compressed fixtures

When the complete serialized fixture exceeds **1,000,000 UTF-8 bytes**, `RecordingRpc` writes `<existing-key>.json.gz`; smaller fixtures remain `<existing-key>.json`. Replay and record-resume accept either. Existing fixture keys and small-file serialization are unchanged. `responseSha256` and evidence IDs still hash the canonical JSON response, never gzip bytes. A refresh writes the appropriate encoding and removes its obsolete alternate so replay cannot return stale data after crossing the threshold. Existing uncompressed fixtures are not migrated on replay. Full Voter/Escrow/GaugeVoter/GaugeVote reads remain single RPC calls regardless of response size.

## Authority resolution (G2b)

`src/contracts/authorities.ts` writes `out/contracts-marinade/authorities.json`. Inputs are the G1 classifications `native-treasury-pda`, `pda-system`, `pda-no-account`, and `wallet`, deduplicated across State authorities, upgrade authorities, Registrar/grant authorities and matched signer holders, plus mSOL upgrade authority `551FBXSXdhcRDDkdcb3ThDRg84Mwe5Zs6YjJ1EEoyzBp` and the registry's Native Yield/Select staker and exit authorities.

For each address the reader records the newest 50 signatures and each transaction, sharing transaction reads across addresses. Null/pruned transactions stay visible. It handles legacy and versioned message shapes, including loaded address-table keys. Output retains top-level programs and instruction account lists; per-program transaction/instruction counts and oldest/newest times; recognized controller instructions; and appearances of the authority in inner instructions under an enclosing top-level program. A PDA cannot be a transaction-level signer. An account appearance in a CPI subtree is **observed**, never proof of signing or control. Failed transactions remain observations, with `succeeded: false`; unavailable status is null.

Only a reproduced PDA derivation followed by owned and decoded controller state yields `status: resolved`, with `basis: derived`:

1. **SPL Governance:** test `[UTF-8 "native-treasury", candidate governance account]` under each observed top-level program against the authority. On a match, require candidate ownership and a Governance account type, decode with `GovernanceAccountParser(Governance)`, read its realm through the recorder, require matching ownership and Realm account type, and decode with `GovernanceAccountParser(Realm)`. Report program, governance, realm address and name. Testing all observed program IDs supports custom governance deployments as well as Marinade and default SPL Governance.
2. **Serum-style multisig:** test `[candidate multisig account]` under the observed program. On a match, read the account and program's on-chain Anchor IDL through G1's `readOnChainIdl`. If an IDL exists it must decode; a malformed IDL does not silently fall back. If absent, the **claimed** coral-xyz Multisig layout is `owners: Vec<Pubkey>, threshold: u64, nonce: u8, owner_set_seqno: u32`, after the Anchor discriminator. Require account ownership, a valid threshold and the stored nonce matching the PDA bump. Report classified owners, threshold and owner-set sequence number. The program ID is discovered from observed instructions, not a hard-coded `msigmt…` guess.
3. **Squads v4:** for `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf`, test `[UTF-8 "multisig", candidate, UTF-8 "vault", u8 index]` for indices 0–3. Require owned Multisig state and a valid threshold; use an on-chain legacy Anchor IDL if available. With no IDL the explicitly **claimed** v4 fallback layout is create key, config authority, u16 threshold, u32 timelock, u64 transaction/stale indices, optional rent collector, bump, then members `(pubkey, u8 permissions)`. Report members, raw permission bitmasks and threshold. No permission-bit meaning or ultimate operator identity is inferred.

Known controller instructions include Marinade/default governance, Squads v4, observed `msig…` program IDs, and any program whose instruction produces a supported PDA match. All top-level instructions are retained so unknown deployments remain inspectable. Derivation attempts whose state is missing, has the wrong owner, or fails validation remain unresolved with a reason. A derivation establishes the address relationship and current decoded configuration; it does not establish historical membership, successful authorization of every observed transaction, or the identities behind owner keys. On-chain multisig IDLs remain declarations and fallback layouts remain claims even when the address relationship is derived.

For `551FBX…`, the reader also lists observed top-level and inner BPF Upgradeable Loader `Upgrade` instructions: little-endian u32 tag `3`, with the second account interpreted as the upgraded program. Each includes block time, transaction slot, signature and success status. This is bounded by the newest-50 window, not the complete upgrade history. Transaction observation rows retain their transaction slot; controller account evidence retains its own read slot.

The capture command, with the RPC URL already supplied securely in the environment, is:

```sh
bun run scripts/record-contracts.ts --record
```

For a fully refreshed capture use `bun run scripts/record-contracts.ts --record --refresh`. The script writes `contracts.json`, `participation.json`, `authorities.json` and the evidence log only after all three layers complete. Replay is `bun run scripts/record-contracts.ts --offline`. No new mainnet results were captured during this offline implementation.

`tests/participation.test.ts` and `tests/authorities.test.ts` contain synthetic tests and one mainnet replay test each. The mainnet tests explicitly skip with “until Claude records G3/G2b keys” in their names until the corresponding new Voter/signature fixture key exists, even if the G1 fixture directory already exists. Once a new sentinel key exists, an incomplete capture fails loudly. Participation replay checks sums, supply denominators and provenance; authority replay checks evidence and re-derives every resolved controller. Gzip tests use temporary directories and never modify committed fixtures.

## Value routes and flows

`readFlows(rpc, registry, layer, participation, holders, docsCapture, ledger?)` writes `out/contracts-marinade/flows.json`. Every instruction is retained. The explicit writable-account name patterns are treasury, fee, partner, beneficiary, bond, reserve, leg and vault. Decoded public-key fields resolve names within the same program; referral instructions can also reference liquid-staking State. The LP mSOL leg has an explicit alias. Unresolved names stay unresolved. `orderUnstake` has no destination account declared even though State has a delayed-unstake fee. Name matches describe declarations, not executable proof of value direction.

The eight liquid-staking fee parameters link to their decoded G1 values and instruction routes. Referral partner fee fields retain G3's unverified unit semantics and each ReferralState's mSOL partner destination. SAM, Select, lending and Native claims retain unresolved collection destinations. Captured fee sentences containing percentages or basis points are matched only when a unique parameter and quantity can be identified; FeeCents are divided by 100 to obtain basis points. Multiple quantities, unrelated fees and unmatched statements remain unresolved.

Treasury observations read the State treasury account's newest 1,000 signatures and transactions. Exact pre/post token differences are aggregated into incoming and outgoing raw units and mSOL by Anchor instruction candidate, with top-level and inner calls decoded from SHA-256 of `global:` plus the snake-case IDL name. Multiple account-bearing calls remain ambiguous; their transaction-wide delta is never allocated repeatedly. Failed or unavailable transactions and absent token-balance arrays do not become zero revenue. A missing balance on one side represents account creation or closure. Per-day values explicitly extrapolate only the oldest-to-newest sampled block-time window.

The treasury token authority is decoded and classified. Its newest 200 transactions supply outgoing SPL Token Transfer/TransferChecked instructions for mSOL, MNDE, wrapped SOL, USDC and USDT. Destination owners use historical token metadata where available; a current-account fallback is marked decoded and does not establish historical ownership. DAO native treasuries are derived, the registry buyback wallet label is claimed, and current VSR voter authorities are decoded. Other program-owned recipients are not assumed to be distributors.

The buyback wallet's derived MNDE ATA supplies another newest-1,000 sample. MNDE credits with same-transaction wallet spending are purchase candidates. Monthly UTC aggregates include MNDE bought, spend by asset, per-asset average prices, outgoing transfers, recipients and the share reaching current VSR voter authorities. SOL costs net wrapped SOL and remove the wallet's signature fee; rent and unrelated SOL movements can remain. Token deltas and raw SOL changes are retained for inspection. Incoming funding transfers can resemble purchases, so transaction intent is not asserted. Per-asset price denominators include only purchases spending that asset, and multi-asset prices must not be added together.

All v1–v9 checks state the chain result first. v5 never computes a ratio across different windows, incomplete samples or unmatched assets; even a same-window mSOL ratio does not establish total protocol revenue. v6 cannot prove historical reward eligibility or unobserved distributor payouts. v7 searches B.1 DAO transfers within 1% of 10 million MNDE and retains proposals and receipts. v8 proposal names provide claimed context only. v9 uses the unique modal Constant lockup duration by used MNDE deposit count, reporting ties as unresolved. The verdict separates declared/decoded links, account-operated transfers, unverified claims and B.1 outflows/unlocks. Its `enforcedByCode` entries explicitly qualify that IDLs and state do not prove executable enforcement.

The recorder reads B.1 from `out/marinade/packet.json`, falling back to `out/web/marinade/packet.json`; absence leaves ledger-dependent claims unresolved. The docs capture and B.1 artifact receive content-hash source references, separate from RPC evidence. B.1 evidence IDs refer to its prior recording. No live capture was made during implementation. Run `bun run scripts/record-contracts.ts --record` to capture; use `--offline` to replay. `tests/flows.test.ts` skips its mainnet replay until the G5b buyback-wallet signature fixture (limit 1,000) exists; partial captures then fail explicitly.

## Distributors and buyback funding

G5b adds `distributors`, `distributorSummary` and `buybackFunding` to the existing `flows.json`. Existing flow keys and shapes remain; v5/v6 explanations and verdict entries incorporate the new observations. No live G5b result was recorded during implementation.

For each program-owned MNDE recipient owner discovered in the buyback outflows, the reader fetches the owning program’s on-chain legacy Anchor IDL through `readOnChainIdl`. It does not hardcode the current recipient `Gb1RjdVr869FYpLGJSPYzmkTuA8T162hvcSdurQAuUms` or its reported owner program `meRdrpyDCAbQxunjZSLmJ78GxQcn4fJUvqU93GoHZr1`. A matching owner and account discriminator allow the full account layout to be decoded: roots, mint, maximum claim, claimed totals, node counts, admin and clawback fields are retained exactly when present, with `basis: decoded`. The published IDL name is evidence; no economic role is inferred from it. Missing IDLs produce `unresolved` rows with raw program-call and token-delta observations. A published IDL whose account layout cannot decode is also reported unresolved with its reason.

All decoded public-key references are classified with `classifyAuthority`. Names containing admin, authority, owner, clawback, operator or manager or matching an IDL signer-role name flag inferred authority roles, and off-curve references with those names go through the G2b resolver (its newest-50 authority-signature window and controller-derivation checks). All other public-key references remain classified so unusual names stay visible. Fields containing vault are read as token accounts. If the layout stores a mint but no vault reference, the reader tries the derived ATA of `(distributor, mint)` and explicitly marks that convention `derived`. Balances are exact raw token units, with missing accounts, mint disagreement and owner disagreement visible rather than repaired.

Each recipient account supplies its newest **300 signatures and transactions**. Successful top-level and inner program instructions are named by the Anchor discriminator. Instructions whose IDL name contains `claim` are claim candidates only when they mention that recipient. The claimant is a flattened IDL account named like claimant/user/authority that is declared a signer and actually signs the transaction; otherwise it is the fee payer. Amounts sum positive MNDE token-account deltas owned by that claimant. Repeated calls for the same claimant in one transaction count as multiple calls but credit the amount once. Calls to different distributors for the same claimant make attribution ambiguous; those amounts remain null. Missing balance metadata also stays null. Other credits in the same transaction can be included: the reader does not prove instruction-level causality.

Summaries report claim-call count, distinct claimants, known claimed amount, missing amounts, the fraction of distinct claimants who are **current decoded MNDE-registrar VSR voter authorities**, and their fraction of the known claimed MNDE. Cross-distributor summaries deduplicate transaction/claimant amounts and claimant identities. Empty denominators give null. These are current-authority overlaps, not proof that a claimant locked the payout, was historically eligible, voted, or received the particular fungible tokens bought by the wallet. The stored lifetime claimed total and the sampled claimed amount are separate observations.

Funding uses the buyback **wallet address**, independently of its MNDE ATA, for its newest **1,000 signatures and transactions**. A successful wallet-signed purchase candidate (positive MNDE credit and same-transaction wallet spending, or a purchase already identified by the ATA layer) is excluded. Remaining positive wallet lamport deltas are SOL credits; positive token-account credits owned by the wallet in other mints are retained separately. Wrapped SOL remains a separate token mint in funding. Missing/failed transactions and absent balance metadata are counted and retained.

Source attribution first reconciles decoded System Transfer/TransferWithSeed or SPL Transfer/TransferChecked amounts against the destination net credit and same-asset source debits. If that fails, a sole debit sufficient to cover the credit is an inferred source. Multiple or insufficient debits remain unresolved candidates; the reader never assigns the entire credit to every candidate or allocates it proportionally. Fee-only SOL debits are excluded from candidate sources. Token credits retain the debited token account and its historical owner where available, without substituting a current owner. Source classifications include candidate accounts. The treasury mSOL account’s owner has a decoded role, DAO native treasuries have derived roles, and the registry Labs treasury label has a claimed role. Fees, rent, swaps, internal token movements and unrelated same-transaction activity can affect these net observations.

`buybackFunding.bySource` and `.months` aggregate exact raw amounts by source, asset and decimals in UTC calendar months; unknown timestamps have an `unknown` bucket. Each month compares SOL received by source against SOL spent on MNDE in the **existing buyback months**. Both sample windows remain visible; a month can be partial and the two windows need not match. This is not a share of protocol revenue. v5 stays unresolved without a same-window protocol-revenue figure and includes the observed funding sources in its explanation. v6 can become `partly` based on claimant overlap and reports the count, amount percentage and sampled window while retaining its direct-recipient fields.

Distributor funding and observed claim activity, and wallet funding/purchases, enter `verdict.operatedByAccounts`. This reader has no independent executable proof of merkle enforcement, so it does not add distributor observations to `enforcedByCode`. IDL names and successful transactions alone do not establish all eligibility or authorization checks.

Claude can capture the missing reads, with `LINCHPIN_RPC_URL` already supplied securely in the environment:

```sh
bun run scripts/record-contracts.ts --record
```

The command reuses recorded fixtures and captures missing reads; `--record --refresh` requests a fresh snapshot. Replay uses `bun run scripts/record-contracts.ts --offline`. The mainnet flow test skips until the wallet signature fixture exists, then requires complete replay; heavy contract-layer fixture tests have a **120-second timeout**. Synthetic tests cover on-chain IDL/account decoding, instruction discriminators, claimant signer/fallback extraction, CPI lookup keys, current-authority overlap, unavailable and ambiguous amounts, funding source reconciliation, monthly comparisons, and signed-purchase exclusion. They use mocked RPC calls and do not write fixtures.

## Holders and float

`readHolders(rpc, registry, layer, participation, authorities, labels?)` writes `out/contracts-marinade/holders.json`. The recorder now builds G1, G3, G2b, holders and flows before writing any layer outputs. It reads optional JSON files under `packs/marinade/sources/labels/` in filename order. A labels file must have `{ source, retrievedAt, labels: [{ address, label, category? }] }`; malformed files fail explicitly. No labels are fetched automatically.

MNDE uses all legacy SPL Token accounts filtered by `dataSize: 165` and mint at offset zero, with the exact owner/amount slice `{ offset: 32, length: 40 }`. Owner balances aggregate every account, including zero accounts in account counts. Top 10/100/1,000 shares use the mint supply read through the recorder during this run. Nakamoto is the fewest owners with **strictly more than** half that supply; it is null if enumerated balances cannot reach the threshold. Population Gini excludes zero owners. Histogram intervals are `[10^k, 10^(k+1))` MNDE, including negative exponents for balances below one token. Exact integers are preserved until display/share conversion. Both the supply difference and individual read slots are exposed; they are not forced to reconcile.

Top 50 nonzero MNDE owners and every owner above 0.1% of supply are classified using `getMultipleAccounts` in batches of at most 100. On-curve and off-curve system accounts, missing accounts, and program-owned accounts are distinct. Known roles attach separately: native treasuries derived from full realm governance discovery, registry Labs/buyback labels (claimed), G3 Voter accounts with voter authority and lockup kinds (decoded), current owners of decoded MNDE escrow vaults (decoded), and G2b resolved authorities (derived). Optional reported labels retain source and retrieval date. Role-name precedence is derived, decoded, claimed, reported; all labels remain visible.

Float displays the supply and each exclusion: DAO native treasury balances, VSR custody, current MNDE escrow vault balances, and the separately claimed Labs balance. `verifiedOnly` excludes the claimed Labs component; `includingClaimed` includes it explicitly. VSR uses G3's reconciled vault total only if every vault matched, otherwise the decoded deposited total with an incomplete-reconciliation note. This is a **custody remainder**: G3 deposits can include unlocked MNDE, and the separate G3 `timeLocked` figure is retained. Escrow subtraction uses current MNDE token accounts referenced by decoded escrows in realms whose decoded `govMint` is MNDE. Stored escrow amounts can survive exit and are not blindly subtracted. Exclusions are disjoint in DAO, VSR, escrow, Labs order; missing vaults and negative remainders remain visible. No component asserts market liquidity.

mSOL enumerates amount slices `{ offset: 64, length: 8 }`. Its concentration and Gini are **by token account**, while MNDE's are by owner. The independent `getTokenLargestAccounts` result (up to 20 accounts) is read in full to obtain owners and check its mint, with subsequent-read balance differences preserved. The LP mSOL leg and treasury token account receive derived G1 roles. Both mint enumerations use the recorder's existing compression; existing fixture keys are unchanged.

Downstream groups cover those top 20 mSOL accounts. A program-owned owner points to its decoded owning program. For a PDA with no account, the newest ten signatures of the **token account** are read, and successful Transfer/TransferChecked instructions moving tokens out identify their enclosing top-level programs. Failed transactions and mere account mentions supply no dependency. These programs are observations, not proof of control. Multiple observed programs can receive the same account in their group, so grouped holdings overlap and must not be summed. Wallets, unknown owners and PDAs without observed outflows remain entity groups. Protocol names come only from supplied reported-label files.

Every figure or containing observation row carries basis, slot, asOf and evidence IDs. Source hashes for registry and labels are separate from RPC records. `asOf` comes from recorded evidence, not replay wall time; separate or resumed reads can span slots and capture dates. The shared provenance index avoids repeated full evidence scans during large voter/holder aggregation and preserves the existing provenance fields.

Capture all layers with `bun run scripts/record-contracts.ts --record`; replay with `bun run scripts/record-contracts.ts --offline`. For a new snapshot use `--record --refresh`. No holder or flow mainnet results were generated during this offline implementation. The G4 fixture test skips until the exact new MNDE owner-slice fixture exists, then requires a complete capture. Synthetic reader tests cover query slices, supply disagreement, float components, labels and inner-instruction downstream attribution without network calls or fixture writes.

## Governance configuration and council membership

`readGovernanceConfig(rpc, registry, layer, authorities)` writes `out/contracts-marinade/governance.json` through `scripts/record-contracts.ts`. It reads the registry's DAO realm and every realm found in authority resolution, including the Emergency Council's default Realms deployment. All reads use `RecordingRpc` under `marinade-contracts`; the reader never accesses a live SDK connection.

Realm accounts and their SDK-derived realm-config PDAs supply names, community/council mints and both voter-weight and maximum-voter-weight add-ins. Mint accounts supply community decimals, council decimals, supply and mint authority. Governance enumeration issues the same account-type queries as `getGovernanceAccounts`, then uses `GovernanceAccountParser`. Every governance retains its native treasury PDA, community and council vote/veto threshold types and values, exact proposal minima, base voting time, cooling-off time, instruction hold-up and vote tipping.

Council token-owner-record enumeration filters by account type, realm and governing token mint. Filter offsets come from the installed SDK's schemas across all supported account versions and fail if those versions disagree; spike byte offsets are not used. Each record retains its owner, raw deposit and optional delegate. Current council membership means a positive deposit, not merely holding council tokens in a wallet. Council supply and deposits remain separate measurements. Overlaps are distinct member addresses intersected with the recorded Serum multisig owners controlling the mSOL upgrade authority; they establish shared addresses, not human identities.

Voting classifications are `council-only`, `community-only`, `community-and-council`, and `no-proposals`. `Disabled` turns off the corresponding vote or veto; `u64::MAX` prohibits proposal creation. Proposal creation also requires an enabled vote threshold and, for council proposals, a council mint. `no-proposals` takes precedence when neither side can create a proposal; vote/veto settings remain visible because existing proposals can still matter. Veto permission is independent of proposal creation.

The mapping covers tracked state authorities, every program upgrade authority, council mint authorities, and all native treasuries in all discovered realms. The API joins that complete treasury index to every MNDE owner in the holders layer, including the DAO treasury and the treasury called “Labs Treasury” by documentation. The latter identity remains claimed even when governance ownership is derived. This join does not rely on top-holder rank.

Capture the new reads with the exact command:

```sh
bun run scripts/record-contracts.ts --record
```

Then replay with `bun run scripts/record-contracts.ts --offline`. Existing fixtures are reused by the record command; a coherent new snapshot can be captured separately with `--refresh`. The B1d implementation was performed offline and did not record mainnet council membership. The governance and tokenomics fixture-backed tests skip until the new council record query fixture exists, then require the capture to be complete. Heavy fixture tests use a 120-second timeout. SDK-schema synthetic tests exercise all classifications, both token-owner-record versions, proposal prohibitions, membership, delegates, add-ins, authority/treasury mappings, council overlap, API paths and the graph query.

### Claims without an IDL

G5c adds `distributorClaims` without changing the existing distributor, summary or funding shapes. For each discovered distributor without an on-chain IDL (including `meRdrpyDCAbQxunjZSLmJ78GxQcn4fJUvqU93GoHZr1`), the vault is the actual `destination` of the recorded buyback MNDE transfer. Its newest **300 signatures and transactions** are read through `RecordingRpc`. A successful transaction with a negative vault MNDE delta selects every positive MNDE token-account delta in that transaction. The post-balance owner is the claimant; missing owners trigger a recorded current token-account read, with unresolved owners retained explicitly. Top-level/inner distributor invocation is reported independently and is not required for the balance observation.

`distributorClaims` includes the sample window, requested/read/unavailable transactions, vault-debit count and raw amount, distinct known claimants, exact raw and MNDE claim totals, current VSR authority count/amount shares, top ten claimants, and per-vault decoded current balances versus sampled buyback receipts. Shared transaction/account credits are counted once across vault samples. Unknown owners are excluded from the distinct-claimant denominator but their credits remain in the amount denominator. Separate balance/funding reads are not a conservation reconciliation; unrelated credits, other funding, current-owner changes and incomplete history can affect the observations.

Anchor `Program log: Instruction: <Name>` lines are assigned to their active program invocation, including nested calls, until success/failure. Names and counts carry `basis: observed (program log)`; failed or truncated invocation outcomes remain visible. Names never establish claim behaviour. v6 is `partly` only when observed claimed MNDE reaches current VSR voter authorities, states both shares and the window for this path, and remains `unresolved` without observed claims. Direct wallet payouts alone do not establish distributor claims. Eligibility rules are off-chain, so v6 is never `verified`.

No G5c mainnet reads were recorded during implementation. Claude can run `bun run scripts/record-contracts.ts --record` with `LINCHPIN_RPC_URL` supplied in the environment; replay uses `--offline`. The fixture-backed flow test and dependent tokenomics integration tests skip until the exact newest-300 signature fixture for the recorded vault `3HT41nesAgcoNDeGAVFKwss5mzScMH2Uik6pcP71xnhB` exists, then require a complete replay with a **120-second timeout**. Independent synthetic tests remain active and cover nested logs, multiple recipients, current-authority overlap, owner fallback, shared samples, exact large amounts, and ignored non-debits/failures.
