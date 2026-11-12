import { KLEND_PROGRAM } from "../kamino/constants";
export { KLEND_PROGRAM, SQUADS_PROGRAM, UPGRADEABLE_LOADER, SYSTEM_PROGRAM, NULL_PUBKEY, isConfiguredKey, identity } from "../kamino/constants";
export const KAMINO_LEND_TARGET = Object.freeze({
  "market": "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF",
  "klendProgram": "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD",
  "globalConfig": "BEe6HXZf6cByeb8iCxukjB8k74kJN3cVbBAGi49Hfi6W"
});
export const SCOPE_PROGRAM = "HFn8GnPADiny6XqUoWE8uRPPxb29ikn4yTuPa9MF2fWJ";
export const SWITCHBOARD_PROGRAM = "SW1TCH7qEPTdLsDHRgPuMQjbQxKdH2aBStViMFnt64f";
export const SQUADS_V3_PROGRAM = "SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu";
export const CONTROL_CANDIDATES = Object.freeze([
  "7WZWJXd1V4MAbxX47PR42tihCxdFWR1EBZiWBYzyaoEF",
  "7idEEVRidWrahZJhxXMqniDbV6ESj7ZjyLrigcMcEt6H",
  "9thcmURbz3xgvv362Fy2uGVGoxMnD3ADRuwRp13nuXE5",
  "53EGEAU2TqM9rrqhskJUT5qFfxfPADb647LnCqrfciVV",
  "6hhBGCtmg7tPWUSgp3LG6X2rsmYWAc4tNsA6G4CnfQbM",
  "4htL3T1tBMRNczRXiQrZvNMhmZsxL7PPQtQSzMuSDpvX",
  "DDJGaWjVREXffoMe9nyvb1c7wpajLdh7fTnAb2giD9RM"
]);
export const ADDRESS_MANIFEST = Object.freeze([
  {
    "role": "program",
    "address": "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:53Z"
  },
  {
    "role": "programdata",
    "address": "9uSbGW1y9H5Av6H5TKxQ1wnFApSq2t3oEpfF2YfjDQGA",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:53Z"
  },
  {
    "role": "market",
    "address": "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF",
    "status": "observed",
    "observedAt": "2026-11-11T18:26:58Z"
  },
  {
    "role": "market-authority-pda",
    "address": "9DrvZvyWh1HuAoZxvYWMvkf2XCzryCpGgHqrMjyDWpmo",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:53Z"
  },
  {
    "role": "global-config",
    "address": "BEe6HXZf6cByeb8iCxukjB8k74kJN3cVbBAGi49Hfi6W",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:53Z"
  },
  {
    "role": "market-owner",
    "address": "24LjDBukaUSHgPowcF2wY1XscnhChcBUDETN2UhBZMMT",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:53Z"
  },
  {
    "role": "emergency-council",
    "address": "4VtJ1yCCyU2YGgPTZGHZRwzwaZ3hmzgqMtRQo8RqMa57",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:53Z"
  },
  {
    "role": "proposer-authority",
    "address": "BN73b8HCQUsqdrBTqFuzqk9o1SH7fUTEcXxYmv43agJH",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:53Z"
  },
  {
    "role": "upgrade-authority",
    "address": "GzFgdRJXmawPhGeBsyRCDLx4jAKPsvbUqoqitzppkzkW",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:53Z"
  },
  {
    "role": "global-admin",
    "address": "A9rQoX1sictAQkyXxaZA8nz674xutHwoqpK2mwLyexCZ",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:53Z"
  },
  {
    "role": "fee-collector",
    "address": "7WZWJXd1V4MAbxX47PR42tihCxdFWR1EBZiWBYzyaoEF",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:53Z"
  },
  {
    "role": "multisig:market-owner",
    "address": "7idEEVRidWrahZJhxXMqniDbV6ESj7ZjyLrigcMcEt6H",
    "status": "observed",
    "observedAt": "2026-11-11T18:28:55Z"
  },
  {
    "role": "multisig:emergency-council",
    "address": "9thcmURbz3xgvv362Fy2uGVGoxMnD3ADRuwRp13nuXE5",
    "status": "observed",
    "observedAt": "2026-11-11T18:28:55Z"
  },
  {
    "role": "multisig:proposer-authority",
    "address": "53EGEAU2TqM9rrqhskJUT5qFfxfPADb647LnCqrfciVV",
    "status": "observed",
    "observedAt": "2026-11-11T18:28:55Z"
  },
  {
    "role": "multisig:klend-upgrade-authority",
    "address": "6hhBGCtmg7tPWUSgp3LG6X2rsmYWAc4tNsA6G4CnfQbM",
    "status": "observed",
    "observedAt": "2026-11-11T18:28:55Z"
  },
  {
    "role": "multisig:global-admin (Squads v3)",
    "address": "4htL3T1tBMRNczRXiQrZvNMhmZsxL7PPQtQSzMuSDpvX",
    "status": "observed",
    "observedAt": "2026-11-11T18:28:55Z"
  },
  {
    "role": "program:squads-v4",
    "address": "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf",
    "status": "observed",
    "observedAt": "2026-11-11T18:28:55Z"
  },
  {
    "role": "program:squads-v3",
    "address": "SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu",
    "status": "observed",
    "observedAt": "2026-11-11T18:28:55Z"
  },
  {
    "role": "program:scope",
    "address": "HFn8GnPADiny6XqUoWE8uRPPxb29ikn4yTuPa9MF2fWJ",
    "status": "observed",
    "observedAt": "2026-11-11T18:29:46Z"
  },
  {
    "role": "programdata:scope",
    "address": "DuKtB88SQGJbow5jxmUSwgJWmC7zma8mX3Nodz1Gsjs2",
    "status": "observed",
    "observedAt": "2026-11-11T18:29:46Z"
  },
  {
    "role": "upgrade-authority:scope",
    "address": "4R33WT7isNgzALNyvpZKiZQARtZNAXarWB3prUbPkXX7",
    "status": "observed",
    "observedAt": "2026-11-11T18:29:46Z"
  },
  {
    "role": "multisig:scope-upgrade-authority",
    "address": "DDJGaWjVREXffoMe9nyvb1c7wpajLdh7fTnAb2giD9RM",
    "status": "observed",
    "observedAt": "2026-11-11T18:30:03Z"
  },
  {
    "role": "oracle:scope-price-feed",
    "address": "3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:53Z"
  },
  {
    "role": "oracle:scope-price-feed",
    "address": "3NJYftD5sjVfxSnUdZ1wVML8f3aC6mp1CXCL6L7TnU8C",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:53Z"
  },
  {
    "role": "oracle:switchboard-price",
    "address": "2fnxDPcLAZzYy1pJTMFNUo2mxWHD4ggrEgTu6my54Npm",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:53Z"
  },
  {
    "role": "program:switchboard",
    "address": "SW1TCH7qEPTdLsDHRgPuMQjbQxKdH2aBStViMFnt64f",
    "status": "observed",
    "observedAt": "2026-11-11T18:29:46Z"
  },
  {
    "role": "oracle-mappings:scope (unpinned)",
    "address": "4zh6bmb77qX2CL7t5AJYCqa6YqFafbz3QJNeFvZjLowg",
    "status": "inferred",
    "observedAt": "2026-11-11T18:29:46Z"
  },
  {
    "role": "oracle-mappings:scope (unpinned)",
    "address": "Chpu5ZgfWX5ZzVpUx9Xvv4WPM75Xd7zPJNDPsFnCpLpk",
    "status": "inferred",
    "observedAt": "2026-11-11T18:29:46Z"
  },
  {
    "role": "reserve",
    "address": "d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:26Z"
  },
  {
    "role": "reserve",
    "address": "StGKGcLQoTsWzQ1tFY2bWqrdiuBhqdFE4niiAutQxQB",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:26Z"
  },
  {
    "role": "reserve",
    "address": "D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:26Z"
  },
  {
    "role": "reserve",
    "address": "EVbyPKrHG6WBfm4dLxLMJpUDY43cCAcHSpV3KYjKsktW",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:26Z"
  },
  {
    "role": "reserve",
    "address": "CkgQnPbuHHwSv2mNdAKH79TKSqC6jsyttK9yh4MPH6z3",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:26Z"
  },
  {
    "role": "reserve",
    "address": "37Jk2zkz23vkAYBT66HM2gaqJuNg2nYLsCreQAVt5MWK",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:26Z"
  },
  {
    "role": "reserve",
    "address": "ESCkPWKHmgNE7Msf77n9yzqJd5kQVWWGy3o5Mgxhvavp",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:26Z"
  },
  {
    "role": "reserve",
    "address": "DGQZWCY17gGtBUgdaFs1VreJWsodkjFxndPsskwFKGpp",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:26Z"
  },
  {
    "role": "reserve",
    "address": "2gc9Dm1eB6UgVYFBUN9bWks6Kes9PbWSaPaa9DqyvEiN",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:26Z"
  },
  {
    "role": "reserve",
    "address": "CExamod1Ai3d1N8Vh7sBjt5xbZzb2VmGMAFocf7fxCzm",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:26Z"
  },
  {
    "role": "reserve",
    "address": "CHBNUPdjeo2N5QkZY2uAqv7TW5EbCTMsfvaskCBuxbom",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:26Z"
  },
  {
    "role": "reserve",
    "address": "FBSyPnxtHKLBZ4UeeUyAnbtFuAmTHLtso9YtsqRDRWpM",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:26Z"
  },
  {
    "role": "reserve",
    "address": "2EXNMnkHE5TY1wTwA9UKi3wpTvoXpFsDPeGC5GVttu5F",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:26Z"
  },
  {
    "role": "reserve",
    "address": "H3t6qZ1JkguCNTi9uzVKqQ7dvt2cum4XiXWom6Gn5e5S",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:26Z"
  },
  {
    "role": "reserve",
    "address": "4Hyrqb9Mq7y1wkq4YoqHkPdPx3VQyFY3mxMj67naC1Cb",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:26Z"
  },
  {
    "role": "reserve",
    "address": "H9vmCVd77N1HZa36eBn3UnftYmg4vQzPfm1RxabHAMER",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:26Z"
  },
  {
    "role": "reserve",
    "address": "Ht9NoB1udjpRqws1sCw1j2dL7MeTDHYCDdDFkbc1Arst",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:26Z"
  },
  {
    "role": "reserve",
    "address": "HV9KsS5mB4b9CFhDJVKdfxWBAomYfUk5PeUsdgMQsUrB",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:26Z"
  },
  {
    "role": "reserve",
    "address": "HD93Fq3gmVh3J7euJJ5MBw8Ph3ebeMFS699JQePN4XgN",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:26Z"
  },
  {
    "role": "reserve",
    "address": "BHUi32TrEsfN2U821G4FprKrR4hTeK4LCWtA3BFetuqA",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:26Z"
  },
  {
    "role": "reserve",
    "address": "febGYTnFX4GbSGoFHFeJXUHgNaK53fB23uDins9Jp1E",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:26Z"
  },
  {
    "role": "reserve",
    "address": "A2J2CEwmwa9aTKbEfNoik6YTyNep9GtvNjU65okWYhwn",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:26Z"
  },
  {
    "role": "reserve",
    "address": "EAA3VVsxUuQB1Tm5x7TJkq9ATtiX5Qwq8ok7gXwim7oo",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:26Z"
  },
  {
    "role": "reserve",
    "address": "J5oj3VKWQNKRZx3heWZx7JZC59AEDQ9UQwqqiy63nCuf",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:26Z"
  },
  {
    "role": "reserve",
    "address": "ApQkX32ULJUzszZDe986aobLDLMNDoGQK8tRm6oD6SsA",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:26Z"
  },
  {
    "role": "reserve",
    "address": "Fqjbo3L4NAyzPcy6swv1XXLm1c7tUTKWMDkjCo9mfSDq",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:26Z"
  },
  {
    "role": "reserve",
    "address": "2gFjdQLFaFqTKMv4nFGMAP4bX2F5KAsyiJn8yZQHPKSE",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:26Z"
  },
  {
    "role": "reserve",
    "address": "2UFz8kwraHybFyKhGQRwAsE5NtNpAhWs2X5grGoS7hnQ",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:26Z"
  },
  {
    "role": "reserve",
    "address": "EGPE45iPkme8G8C1xFDNZoZeHdP3aRYtaAfAQuuwrcGZ",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:26Z"
  },
  {
    "role": "reserve",
    "address": "HYnVhjsvU1vBKTPsXs1dWe6cJeuU8E4gjoYpmwe81KzN",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:26Z"
  },
  {
    "role": "reserve",
    "address": "BvafE5Sm6rLrBbVRtJ2FkCzfNJQ2TjcL8bvPZULUDYrt",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:26Z"
  },
  {
    "role": "reserve",
    "address": "4AFAGAm5G8fkcKy7QerL88E7BiSE22ZRbvJzvaKjayor",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:26Z"
  },
  {
    "role": "reserve",
    "address": "Bpc4kAh29J3YDQUMJJdGdr1zBAhTQjC48R1B8YTWudsi",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:26Z"
  },
  {
    "role": "reserve",
    "address": "6vKCRnEzrxRS1NybsMVEyNE3ztFAxCz6WusiiGft1PbA",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:26Z"
  },
  {
    "role": "reserve",
    "address": "B5uYvxUcwX5fCB4msGU4DaHh8k6fsSkKHNboy94F9vbt",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:26Z"
  },
  {
    "role": "reserve",
    "address": "9Ukd2MSw5RvVFaN8jLhWxjHLEGiF1F6Hf7v3Zq5hZsKB",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:26Z"
  },
  {
    "role": "reserve",
    "address": "57U9pEC8NsWvHgWywd2xHTRkGQzWWYsWivxYRhtxZrLB",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:26Z"
  },
  {
    "role": "reserve",
    "address": "GhGPbkWmPjSkbkgZbhNGBTxzwQKjqDpZwNfaf2gQKgdG",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:26Z"
  },
  {
    "role": "reserve",
    "address": "FMbsZf4HuQ1a8a7VdmALT3S8WRfu3EocphRKPXxRsfGd",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:26Z"
  },
  {
    "role": "reserve",
    "address": "6U9CnJYCQwHUEmf4Pq4oGVKHVvD29wZvtPbFNjYmgjaF",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:26Z"
  },
  {
    "role": "reserve",
    "address": "Hcz1o77tF9TpdEHcvrx29tz7SBKoQEwJA1wuJqGZYnTw",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:26Z"
  },
  {
    "role": "reserve",
    "address": "DaGyAQJrdkLCzYZiUWg49NV8vabDnhR7ETwLu5eQgL56",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:26Z"
  },
  {
    "role": "reserve",
    "address": "8gVpWfWDCtCcUX1meSphqqpyWBceLCcrs9yEXwKKjQrL",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:26Z"
  },
  {
    "role": "reserve",
    "address": "FPAwg5jadDs8AvUtvtAbit2RCZdkZES6yY5X6nCSuEw9",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:26Z"
  },
  {
    "role": "reserve",
    "address": "64AZMUHLB6NYvQSt41JTer4v8NAFDCz5sUPb7dYpCxa",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:26Z"
  },
  {
    "role": "reserve",
    "address": "HMCXsf1jFUDbvGGhvUzCzwkKbmUhxhxz7gYZwXpTuReT",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:26Z"
  },
  {
    "role": "reserve",
    "address": "AxuWrPrJfwrUTvCWRxpkSQct6q8k1YSJzxhyYw2AAmv2",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:26Z"
  },
  {
    "role": "reserve",
    "address": "8qnVHjKMcWAdkFnKvmRigj9J7UAVj2ooJ83GfeNn2DpR",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:26Z"
  },
  {
    "role": "reserve",
    "address": "AWnKJ9dsiHcoDCThxE5E93ikDTAXkApoNwrKM2tp9KFJ",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:26Z"
  },
  {
    "role": "reserve",
    "address": "75WrtSz7rLCdBvAQhtHi8M2jC8HnpT8iUxcYkdeawr37",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:26Z"
  },
  {
    "role": "reserve",
    "address": "4eUxuaHSHNTftaui3XVW32d2Ph2hKBLpuMP25gQ5MqF4",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:26Z"
  },
  {
    "role": "reserve",
    "address": "GFLLgX9V6PR1PzhgsGzeyUddpt2ws2PBRAxRwoLrboGp",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:26Z"
  },
  {
    "role": "reserve",
    "address": "5xXxt9uVHrcT5b1KveAT5ZWgk2f74aDjnLEDDEeAxgpN",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:26Z"
  },
  {
    "role": "reserve",
    "address": "6pazpY4icuXZ5sb2jMWAqdG4TtbUoY1SJ45237Fjht9h",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:26Z"
  },
  {
    "role": "reserve",
    "address": "5YpGenXaAowj4HS33AvirVb8P4tgue7S7YaY6MyYZ7LD",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:26Z"
  },
  {
    "role": "reserve",
    "address": "9JB9EMxEp9gZy3i1jqD2yvNYWKRZCP6f3drdQw853swH",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:26Z"
  },
  {
    "role": "reserve",
    "address": "G31zKdH2SkDZPhmoQraep5xbTSPyk3VZxAeBdC3nmq5J",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:26Z"
  },
  {
    "role": "reserve",
    "address": "Ggn9EUzL5QQPM8JPsyu1MU1uD3rGJty7iXddLQnmxPyS",
    "status": "observed",
    "observedAt": "2026-11-11T18:27:26Z"
  },
  {
    "role": "mint",
    "address": "27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4",
    "status": "observed",
    "observedAt": "2026-11-11T18:29:46Z"
  },
  {
    "role": "mint",
    "address": "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo",
    "status": "observed",
    "observedAt": "2026-11-11T18:29:46Z"
  },
  {
    "role": "mint",
    "address": "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH",
    "status": "observed",
    "observedAt": "2026-11-11T18:29:46Z"
  },
  {
    "role": "mint",
    "address": "3Fb5DMRWoBLWD36Lp4BtG41LaFjVeEJNCH9YLNPYdVqj",
    "status": "observed",
    "observedAt": "2026-11-11T18:29:46Z"
  },
  {
    "role": "mint",
    "address": "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh",
    "status": "observed",
    "observedAt": "2026-11-11T18:29:46Z"
  },
  {
    "role": "mint",
    "address": "3jsFX1tx2Z8ewmamiwSU851GzyzM2DJMq7KWW5DM8Py3",
    "status": "observed",
    "observedAt": "2026-11-11T18:29:46Z"
  },
  {
    "role": "mint",
    "address": "3orqhCKM5admbcHkHQhRAEKbXhUT5VPgsQqz7fBa6QdF",
    "status": "observed",
    "observedAt": "2026-11-11T18:29:46Z"
  },
  {
    "role": "mint",
    "address": "4G9USgnbg6fDTQ5AUfpCjM89zqbzWj32xfqvsaAu66DM",
    "status": "observed",
    "observedAt": "2026-11-11T18:29:46Z"
  },
  {
    "role": "mint",
    "address": "6DNSN2BJsaPFdFFc1zP37kkeNe4Usc1Sqkzr9C9vPWcU",
    "status": "observed",
    "observedAt": "2026-11-11T18:29:46Z"
  },
  {
    "role": "mint",
    "address": "7Q2afV64in6N6SeZsAAB81TJzwDoD6zpqmHkzi9Dcavn",
    "status": "observed",
    "observedAt": "2026-11-11T18:29:46Z"
  },
  {
    "role": "mint",
    "address": "7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj",
    "status": "observed",
    "observedAt": "2026-11-11T18:29:46Z"
  },
  {
    "role": "mint",
    "address": "7kbnvuGBxxj8AG9qp8Scn56muWGaRaFqxg1FsRp3PaFT",
    "status": "observed",
    "observedAt": "2026-11-11T18:29:46Z"
  },
  {
    "role": "mint",
    "address": "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs",
    "status": "observed",
    "observedAt": "2026-11-11T18:29:46Z"
  },
  {
    "role": "mint",
    "address": "9HB4kAMLSYfGFfN142DKMyPyHyZQ8pXF8M1STbDudodY",
    "status": "observed",
    "observedAt": "2026-11-11T18:29:46Z"
  },
  {
    "role": "mint",
    "address": "9zNQRsGLjNKwCUU5Gq5LR8beUCPzQMVMqKAi3SSZh54u",
    "status": "observed",
    "observedAt": "2026-11-11T18:29:46Z"
  },
  {
    "role": "mint",
    "address": "BNso1VUJnh4zcfpZa6986Ea66P6TCp59hvtNJ8b1X85",
    "status": "observed",
    "observedAt": "2026-11-11T18:29:46Z"
  },
  {
    "role": "mint",
    "address": "BonK1YhkXEGLZzwtcvRTip3gAL9nCeQD7ppZBLXhtTs",
    "status": "observed",
    "observedAt": "2026-11-11T18:29:46Z"
  },
  {
    "role": "mint",
    "address": "Bybit2vBJGhPF52GBdNaQfUJ6ZpThSgHBobjWZpLPb4B",
    "status": "observed",
    "observedAt": "2026-11-11T18:29:46Z"
  },
  {
    "role": "mint",
    "address": "CASHx9KJUStyftLFWGvEVf59SGeG9sh5FfcnZMVPCASH",
    "status": "observed",
    "observedAt": "2026-11-11T18:29:46Z"
  },
  {
    "role": "mint",
    "address": "CDCSoLckzozyktpAp9FWT3w92KFJVEUxAU7cNu2Jn3aX",
    "status": "observed",
    "observedAt": "2026-11-11T18:29:46Z"
  },
  {
    "role": "mint",
    "address": "CgnTSoL3DgY9SFHxcLj6CgCgKKoTBr6tp4CPAEWy25DE",
    "status": "observed",
    "observedAt": "2026-11-11T18:29:46Z"
  },
  {
    "role": "mint",
    "address": "CtzPWv73Sn1dMGVU3ZtLv9yWSyUAanBni19YWDaznnkn",
    "status": "observed",
    "observedAt": "2026-11-11T18:29:46Z"
  },
  {
    "role": "mint",
    "address": "Dk2X1HCbwJae44P7FpqdFoeT6LEw4JVyyHvZMHUzHWbi",
    "status": "observed",
    "observedAt": "2026-11-11T18:29:46Z"
  },
  {
    "role": "mint",
    "address": "Dso1bDeDjCQxTrWHqUUi63oBvV7Mdm6WaobLbQ7gnPQ",
    "status": "observed",
    "observedAt": "2026-11-11T18:29:46Z"
  },
  {
    "role": "mint",
    "address": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "status": "observed",
    "observedAt": "2026-11-11T18:29:46Z"
  },
  {
    "role": "mint",
    "address": "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    "status": "observed",
    "observedAt": "2026-11-11T18:29:46Z"
  },
  {
    "role": "mint",
    "address": "GYiUmJ8reqYAdTQtx6CRFawHqPXx9yzkUFvaUVE8PskP",
    "status": "observed",
    "observedAt": "2026-11-11T18:29:46Z"
  },
  {
    "role": "mint",
    "address": "HUBsveNpjo5pWqNkH57QzxjQASdTVXcSK7bVKTSZtcSX",
    "status": "observed",
    "observedAt": "2026-11-11T18:29:46Z"
  },
  {
    "role": "mint",
    "address": "HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr",
    "status": "observed",
    "observedAt": "2026-11-11T18:29:46Z"
  },
  {
    "role": "mint",
    "address": "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
    "status": "observed",
    "observedAt": "2026-11-11T18:29:46Z"
  },
  {
    "role": "mint",
    "address": "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
    "status": "observed",
    "observedAt": "2026-11-11T18:29:46Z"
  },
  {
    "role": "mint",
    "address": "LAinEtNLgpmCP9Rvsf5Hn8W6EhNiKLZQti1xfWMLy6X",
    "status": "observed",
    "observedAt": "2026-11-11T18:29:46Z"
  },
  {
    "role": "mint",
    "address": "LnTRntk2kTfWEY6cVB8K9649pgJbt6dJLS1Ns1GZCWg",
    "status": "observed",
    "observedAt": "2026-11-11T18:29:46Z"
  },
  {
    "role": "mint",
    "address": "So11111111111111111111111111111111111111112",
    "status": "observed",
    "observedAt": "2026-11-11T18:29:46Z"
  },
  {
    "role": "mint",
    "address": "StepAscQoEioFxxWGnh2sLBDFp9d8rvKz2Yp39iDpyT",
    "status": "observed",
    "observedAt": "2026-11-11T18:29:46Z"
  },
  {
    "role": "mint",
    "address": "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB",
    "status": "observed",
    "observedAt": "2026-11-11T18:29:46Z"
  },
  {
    "role": "mint",
    "address": "USDH1SM1ojwWUga67PGrgFWUHibbjqMvuMaDkRJTgkX",
    "status": "observed",
    "observedAt": "2026-11-11T18:29:46Z"
  },
  {
    "role": "mint",
    "address": "USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA",
    "status": "observed",
    "observedAt": "2026-11-11T18:29:46Z"
  },
  {
    "role": "mint",
    "address": "ZScHuTtqZukUrtZS43teTKGs2VqkKL8k4QCouR2n6Uo",
    "status": "observed",
    "observedAt": "2026-11-11T18:29:46Z"
  },
  {
    "role": "mint",
    "address": "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1",
    "status": "observed",
    "observedAt": "2026-11-11T18:29:46Z"
  },
  {
    "role": "mint",
    "address": "cPQPBN7WubB3zyQDpzTK2ormx1BMdAym9xkrYUJsctm",
    "status": "observed",
    "observedAt": "2026-11-11T18:29:46Z"
  },
  {
    "role": "mint",
    "address": "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij",
    "status": "observed",
    "observedAt": "2026-11-11T18:29:46Z"
  },
  {
    "role": "mint",
    "address": "he1iusmfkpAdwvxLNGV8Y1iSbj4rUy6yMhEA3fotn9A",
    "status": "observed",
    "observedAt": "2026-11-11T18:29:46Z"
  },
  {
    "role": "mint",
    "address": "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL",
    "status": "observed",
    "observedAt": "2026-11-11T18:29:46Z"
  },
  {
    "role": "mint",
    "address": "jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v",
    "status": "observed",
    "observedAt": "2026-11-11T18:29:46Z"
  },
  {
    "role": "mint",
    "address": "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",
    "status": "observed",
    "observedAt": "2026-11-11T18:29:46Z"
  },
  {
    "role": "mint",
    "address": "pSo1f9nQXWgXibFtKf7NWYxb5enAM4qfP6UJSiXRQfL",
    "status": "observed",
    "observedAt": "2026-11-11T18:29:46Z"
  },
  {
    "role": "mint",
    "address": "picobAEvs6w7QEknPce34wAE4gknZA9v5tTonnmHYdX",
    "status": "observed",
    "observedAt": "2026-11-11T18:29:46Z"
  },
  {
    "role": "mint",
    "address": "sctmB7GPi5L2Q5G9tUSzXvhZ4YiDMEGcRov9KfArQpx",
    "status": "observed",
    "observedAt": "2026-11-11T18:29:46Z"
  },
  {
    "role": "mint",
    "address": "sctmTAsDn4tLUcemqoqYijfuRkiEfAMPi84PNq2EueR",
    "status": "observed",
    "observedAt": "2026-11-11T18:29:46Z"
  },
  {
    "role": "mint",
    "address": "sctmY8fJucsJatwHz6P48RuWBBkdBMNmSMuBYrWFdrw",
    "status": "observed",
    "observedAt": "2026-11-11T18:29:46Z"
  },
  {
    "role": "mint",
    "address": "stke7uu3fXHsGqKVVjKnkmj65LRPVrqr4bLG2SJg7rh",
    "status": "observed",
    "observedAt": "2026-11-11T18:29:46Z"
  },
  {
    "role": "mint",
    "address": "strng7mqqc1MBJJV6vMzYbEqnwVGvKKGKedeCvtktWA",
    "status": "observed",
    "observedAt": "2026-11-11T18:29:46Z"
  },
  {
    "role": "mint",
    "address": "vSoLxydx6akxyMD9XEcPvGYNGq6Nn66oqVb3UkGkei7",
    "status": "observed",
    "observedAt": "2026-11-11T18:29:46Z"
  },
  {
    "role": "mint",
    "address": "xStpgUCss9piqeFUk2iLVcvJEGhAdJxJQuwLkXP555G",
    "status": "observed",
    "observedAt": "2026-11-11T18:29:46Z"
  }
]);
export const RECORD_FILES = ["api-reserves.json", "rpc-state.json", "rpc-assets.json", "rpc-control.json", "rpc-programs.json"] as const;
export const KAMINO_LEND_LAYOUT_SOURCES = Object.freeze([
  "Kamino-Finance/klend-sdk@6a26d6f1b5afb29953ffd139ee8c0c4ca5f26ce6/src/idl/klend.json",
  "Kamino-Finance/klend-sdk@6a26d6f1b5afb29953ffd139ee8c0c4ca5f26ce6/src/utils/seeds.ts",
  "Squads-Protocol/v4@af94153ff77a28b6effe46b9c94baaa93742b48c/programs/squads_multisig_program/src/state/multisig.rs",
  "SPL Token Mint base layout (82 bytes)"
]);
