# Kamino recorded evidence

This adapter covers six registered kVaults in `VAULT_TARGETS`. `KAMINO_TARGET` remains the Sentora PYUSD target. It replays public account bytes, API responses and documentation into an evidence snapshot, a typed mechanics model and a report. Names are display metadata; they do not establish controllers, backing or issuer relationships.

```ts
import { buildKaminoSnapshots, loadCapture, normalizeCapture } from "./index";

const snapshots = buildKaminoSnapshots("fixtures/kamino");
const { snapshot, mechanics, report, gaps } = normalizeCapture(loadCapture(captureDirectory));
```

The index is offline and never imports the recorder. `verifyCapture` validates the manifest, exact record shapes, hashes, slot consistency and duplicate account keys. `validateMechanics` checks entity kinds, directed endpoints and quantities. Both validators return owned copies and expose typed rejection codes.

For manual public recording:

```sh
bun run scripts/kamino-capture.ts --record
# Record again at least 30 minutes later, keeping exactly two real captures.
bun run scripts/kamino-capture.ts --record
bun run scripts/kamino-capture.ts --check fixtures/kamino
```

Recording uses bounded public GETs and `getMultipleAccounts` reads only. Final account state is one request of at most 100 keys. Programs and their programdata heads are a separate sliced request. Discovery responses are retained as provenance and do not emit facts. A capture is renamed from staging only after its manifest is written. The command without a flag prints usage and exits 2.

Snapshot facts describe decoded state; account types that cannot establish controller mechanisms remain unknown. HTTP observations have no slot. API yield components stay reported quantities, and documentation stays a claimed typical-buffer range. The report compares that range with the computed idle share only within a one-hour window. Computation uses integer fixed-point arithmetic and does not accrue interest past the recorded reserve refresh slot. Missing inputs stay missing.

The layout source revisions are exported as `LAYOUT_SOURCES`. All account decoders accept a raw JSON-RPC account (base64 tuple) and return a decoded object or `{ ok: false, reason }`. `decodeProgram` additionally takes the program address so its programdata PDA can be checked.

## Registered vaults

| Name | Slug | Capture root |
|---|---|---|
| Sentora PYUSD | `sentora-pyusd` | `fixtures/kamino` |
| RWA USDC | `rwa-usdc` | `fixtures/kamino-vaults/rwa-usdc` |
| Steakhouse High Yield USDG | `steakhouse-hy-usdg` | `fixtures/kamino-vaults/steakhouse-hy-usdg` |
| Kamino Institutional Commodity Yield | `kamino-commodity-yield` | `fixtures/kamino-vaults/kamino-commodity-yield` |
| Ethena PYUSD Prime | `ethena-pyusd-prime` | `fixtures/kamino-vaults/ethena-pyusd-prime` |
| Allez SOL | `allez-sol` | `fixtures/kamino-vaults/allez-sol` |

Use `bun run scripts/kamino-capture.ts --record [--vault <slug>] [--out <dir>]`.
The flags may appear in either order, once each. The default vault is Sentora PYUSD.
An unregistered slug exits 1 before any request or directory creation.
Replay each root with `bun run scripts/kamino-capture.ts --check <root>`;
the two real captures must name the same vault.

A capture binds to the registered slug followed by `-` at the start of its
captureId. Without a registered prefix it binds to Sentora PYUSD for legacy
constructed captures. Its manifest target must match that registry entry exactly.

Known defect: `vault.withdrawalPenaltyLamports` is emitted with unit `lamports`,
while its value is in the vault's deposit token. This is left for a later slice.
