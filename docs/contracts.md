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
