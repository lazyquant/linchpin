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
