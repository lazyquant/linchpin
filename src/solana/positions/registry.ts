export interface RecordedAt { readonly path: string; readonly slot: number }
export interface SolanaRegistry {
 readonly tokens: readonly {readonly id: "msol" | "mnde" | "kvault-share"; readonly mint: string; readonly decimals: number | null; readonly tokenProgram: string; readonly recordedAt: RecordedAt}[];
 readonly klendReserves: readonly {readonly reserve: string; readonly market: string; readonly liquidityMint: string; readonly collateralMint: string; readonly decimals: number | null; readonly recordedAt: RecordedAt}[];
}
// Values decoded from the cited captures; no runtime fixture access.
const recorded: SolanaRegistry = {
  "tokens": [
    {
      "id": "msol",
      "mint": "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",
      "decimals": 9,
      "tokenProgram": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      "recordedAt": {
        "path": "fixtures/marinade-contracts/getAccountInfo-ba300a779c0c.json",
        "slot": 453862910
      }
    },
    {
      "id": "mnde",
      "mint": "MNDEFzGvMt87ueuHvVU9VcTqsAP5b3fTGPsHuuPA5ey",
      "decimals": 9,
      "tokenProgram": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      "recordedAt": {
        "path": "packs/marinade/registry.json",
        "slot": 453658037
      }
    },
    {
      "id": "kvault-share",
      "mint": "DCqyVY1SFCwq8unnexv9pjujVAC7jsmjfoUWBrNLvbY",
      "decimals": 6,
      "tokenProgram": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      "recordedAt": {
        "path": "fixtures/kamino/sentora-pyusd-20261109T170418Z/rpc-state.json",
        "slot": 467394687
      }
    }
  ],
  "klendReserves": [
    {
      "reserve": "2gc9Dm1eB6UgVYFBUN9bWks6Kes9PbWSaPaa9DqyvEiN",
      "market": "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF",
      "liquidityMint": "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo",
      "collateralMint": "2dQkXr1e9LBvT2QcfKrzZaWY6gGAAVoCjLgkWFk3Mhkj",
      "decimals": 6,
      "recordedAt": {
        "path": "fixtures/kamino/sentora-pyusd-20261109T170418Z/rpc-state.json",
        "slot": 467394687
      }
    },
    {
      "reserve": "3ZUAwhEtK8XWfK4fy98z4yoptm4GeyeAu21L11HPXaZ5",
      "market": "CqAoLuqWtavaVE8deBjMKe8ZfSt9ghR6Vb8nfsyabyHA",
      "liquidityMint": "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo",
      "collateralMint": "2d835sBokkyWMeiZ7SzwFxkGefsSDYi48paVWmYDs4Zo",
      "decimals": 6,
      "recordedAt": {
        "path": "fixtures/kamino/sentora-pyusd-20261109T170418Z/rpc-state.json",
        "slot": 467394687
      }
    },
    {
      "reserve": "6A8D3ExQ4CdiZTBmij7MScUeKsgs6mSHksYzJbiY61FM",
      "market": "Btu8835QDYgdTnMJJBSidbfQhrZzryZbMhCpty6h6Xdk",
      "liquidityMint": "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo",
      "collateralMint": "92zgpHWPcGJNRxjn3iJPnxupiEeesXktdYYrgsdAsPoz",
      "decimals": 6,
      "recordedAt": {
        "path": "fixtures/kamino/sentora-pyusd-20261109T170418Z/rpc-state.json",
        "slot": 467394687
      }
    },
    {
      "reserve": "6bR98MJTH68s7eV8ssyBgfuuH5oR2bEt58P9rZPLpBrC",
      "market": "8BNUWRSibVasaAmhYpBCFpGgMisGKfVAf9ho3Cmf6vjr",
      "liquidityMint": "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo",
      "collateralMint": "2Bjayo2o5XNjUKKqgYZisXCWXmHHXCw1UL71QFLkGKz8",
      "decimals": 6,
      "recordedAt": {
        "path": "fixtures/kamino/sentora-pyusd-20261109T170418Z/rpc-state.json",
        "slot": 467394687
      }
    },
    {
      "reserve": "92qeAka3ZzCGPfJriDXrE7tiNqfATVCAM6ZjjctR3TrS",
      "market": "6WEGfej9B9wjxRs6t4BYpb9iCXd8CpTpJ8fVSNzHCC5y",
      "liquidityMint": "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo",
      "collateralMint": "EuMh3FEXw5WteSS6mu2ypa2VkFQGjVGJbdJhi9R2o43F",
      "decimals": 6,
      "recordedAt": {
        "path": "fixtures/kamino/sentora-pyusd-20261109T170418Z/rpc-state.json",
        "slot": 467394687
      }
    },
    {
      "reserve": "FswUCVjvfAuzHCgPDF95eLKscGsLHyJmD6hzkhq26CLe",
      "market": "DxXdAyU3kCjnyggvHmY5nAwg5cRbbmdyX3npfDMjjMek",
      "liquidityMint": "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo",
      "collateralMint": "FboVKpN3Wbxn2h2BA6YcT43ae4pR4kRmCjDeYVr83z77",
      "decimals": 6,
      "recordedAt": {
        "path": "fixtures/kamino/sentora-pyusd-20261109T170418Z/rpc-state.json",
        "slot": 467394687
      }
    },
    {
      "reserve": "J11HELuMrLs4WywWHpwoagqT5NMgHTGqCexKjrhM1PuU",
      "market": "CyyFApdfEzHM5dVowALutPiL3fZepMrThtQUed77A1KN",
      "liquidityMint": "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo",
      "collateralMint": "G37Hw1Fza5HYSkw3qN6tTPon7bL7orkni2kmKwz5ZYL6",
      "decimals": 6,
      "recordedAt": {
        "path": "fixtures/kamino/sentora-pyusd-20261109T170418Z/rpc-state.json",
        "slot": 467394687
      }
    }
  ]
};
for (const entry of [...recorded.tokens, ...recorded.klendReserves]) { Object.freeze(entry.recordedAt); Object.freeze(entry); }
Object.freeze(recorded.tokens); Object.freeze(recorded.klendReserves);
export const SOLANA_REGISTRY: SolanaRegistry = Object.freeze(recorded);
