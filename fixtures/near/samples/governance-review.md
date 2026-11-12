# Governance review: burrow.sputnik-dao.near #1746

Snapshot: near-2026-11-09 · blocks 223810396–223810731 · host archival-rpc.mainnet.fastnear.com · constructed: no · as of 2026-11-09T19:33:38.487Z

## Proposals

### Proposal 1746

Decoded: FunctionCall · status Approved · proposer brhost.near · fact nf:near-2026-11-09:4c20d038d0a0f8cc4a4a54fc009cef20fc01183e [^r6]

Receiver: contract.main.burrow.near [^r6]

Method: execute · argsFormat: json · deposit 1 · gas 120000000000000 [^r6]

```json
{
  "actions": [
    {
      "Withdraw": {
        "amount": "251000000000000000000000",
        "token_id": "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"
      }
    }
  ]
}
```

Effect class: funds · rule A09 [^r6]

Execution: role council · permission *:VoteApprove · needed 3 of 5 · approve 3 / reject 0 / remove 0 · executesOn approve [^r6][^r2]
Remaining members: farbread8025.near, nicktrust.near [^r6][^r2]
Flags: none [^r6][^r2]

- council · *:VoteApprove · threshold source default · RoleWeight · threshold {"ratio":[1,2]} · quorum 0 · needed 3 of 5 · counts 3/0/0 · remaining farbread8025.near, nicktrust.near [^r6][^r2]

Expiry: submitted 2026-11-08T09:42:18.955Z · period 604800000000000 ns · expires 2026-11-15T09:42:18.955Z · read block 223810422 at 2026-11-09T19:30:40.331Z · closed [^r6][^r2]

Reach:
- nf:near-2026-11-09.governance:7e5751d6f9d1b9574ad90d31f04c7da290653280 · near:mainnet:burrow.sputnik-dao.near#proposal:1746 · moves-funds-from · near:mainnet:contract.main.burrow.near · derived · verified [^r2][^r6]
- nf:near-2026-11-09.governance:a7079fa2ca7c18015ba078cdfdc756ad0073705b · near:mainnet:burrow.sputnik-dao.near#proposal:1746 · moves-funds-to · near:mainnet:burrow.sputnik-dao.near · derived · verified [^r2][^r6]

What this DAO controls (as read):
- nf:near-2026-11-09:c3c3c48a7c309c1346507c8dfe6ca352dbd255e7 · near:mainnet:contract.main.burrow.near · owned-by · near:mainnet:burrow.sputnik-dao.near · observed · verified [^r7]

Against near:mainnet:contract.main.burrow.near:
- hop 0 · near:mainnet:contract.main.burrow.near · moves-funds-from · nf:near-2026-11-09.governance:7e5751d6f9d1b9574ad90d31f04c7da290653280 [^r2][^r6]
- hop 1 · near:mainnet:burrow.sputnik-dao.near · moves-funds-to · nf:near-2026-11-09.governance:a7079fa2ca7c18015ba078cdfdc756ad0073705b [^r2][^r6]

This proposal moves funds from near:mainnet:contract.main.burrow.near to near:mainnet:burrow.sputnik-dao.near. (facts: nf:near-2026-11-09.governance:7e5751d6f9d1b9574ad90d31f04c7da290653280, nf:near-2026-11-09.governance:a7079fa2ca7c18015ba078cdfdc756ad0073705b)

## Changes to governance itself

| at | kind | source |
| --- | --- | --- |
| 2026-05-08T00:50:58.728Z | membership | near:mainnet:burrow.sputnik-dao.near#proposal:1610 · nf:near-2026-11-09:5c1b3f3eb972a850ed4e7c07df8eeb6c98295b6e · nf:near-2026-11-09:2c64518c1598d4210389a6520d120719c5277a0b [^r3] |
| 2026-05-08T00:51:11.648Z | membership | near:mainnet:burrow.sputnik-dao.near#proposal:1611 · nf:near-2026-11-09:209983360ecd2b8b58f1c07eb0b504ac36c02c07 · nf:near-2026-11-09:430a50a1cab9a80d1cd1560c87641daa2bd9a187 [^r3] |
| 2026-07-07T08:56:38.755Z | membership | near:mainnet:burrow.sputnik-dao.near#proposal:1696 · nf:near-2026-11-09:dd599e53c03bd2b17a53e69a6371a1cc94f38ba3 · nf:near-2026-11-09:ac9000a69794391a072b6c857c9e4d6c8f7d13ad [^r6] |
| 2026-07-07T09:00:26.870Z | membership | near:mainnet:burrow.sputnik-dao.near#proposal:1697 · nf:near-2026-11-09:88cab6ac0bf65133cbe94fce900244fc3b12ee68 · nf:near-2026-11-09:86198b955867b3e1e39116a83bea1a9b43505b22 [^r6] |
| 2026-09-08T07:39:42.382Z | policy | near:mainnet:burrow.sputnik-dao.near#proposal:1714 · nf:near-2026-11-09:89711429649e10d89eb46227fb43051d74e27960 · nf:near-2026-11-09:902f2e5051f563a664a06da7d02d6a6a7a93325a [^r6] |
| 2026-10-09T14:24:41.789Z | membership | near:mainnet:burrow.sputnik-dao.near#proposal:1719 · nf:near-2026-11-09:ed52296f02474a104e1bc33c8089efd4d3f11a95 · nf:near-2026-11-09:0f3d78eb54c7bb0c40c5f09539a3b52bb0f5b6c3 [^r6] |
| 2026-10-09T14:25:24.487Z | membership | near:mainnet:burrow.sputnik-dao.near#proposal:1720 · nf:near-2026-11-09:2d11a7e71dbe6a1129ab77e4a63f3425e2d51ad9 · nf:near-2026-11-09:f6fc66728c4b58b68df396ec45e1b3c156006bd6 [^r6] |

One live snapshot; a comparison pair is not recorded.

Supporting evidence:
- nf:near-2026-11-09:57f70cb373c9100000713f5108d5a01c2a3322c4 · near:mainnet:burrow.sputnik-dao.near · proposal-period · 604800000000000 · observed · verified [^r2]
- nf:near-2026-11-09:66eee853be5fa5b570b838c68a19b5285e4248f1 · near:mainnet:burrow.sputnik-dao.near · council-member · near:mainnet:brhost.near · observed · verified [^r2]
- nf:near-2026-11-09:6da53de944663cf6b2c6869e28098376638f2eaf · near:mainnet:burrow.sputnik-dao.near · bond · 1000000000000000000000000 · observed · verified [^r2]
- nf:near-2026-11-09:847593871fa4954d1e3a6882a9f66bfee7ea83f5 · near:mainnet:burrow.sputnik-dao.near · council-member · near:mainnet:brrrb.near · observed · verified [^r2]
- nf:near-2026-11-09:922195382e4767c550c14409c0850f7ca75ca8a7 · near:mainnet:burrow.sputnik-dao.near · council-member · near:mainnet:farbread8025.near · observed · verified [^r2]
- nf:near-2026-11-09:99d267c5960d306fcca87d6c4cce1a74ff810c68 · near:mainnet:dclv2.ref-labs.near · owned-by · unknown · unknown · unverified [^r1]
- nf:near-2026-11-09:c3c3c48a7c309c1346507c8dfe6ca352dbd255e7 · near:mainnet:contract.main.burrow.near · owned-by · near:mainnet:burrow.sputnik-dao.near · observed · verified [^r7]
- nf:near-2026-11-09:c4749babce0f6c3b2d6aec8add2f7f327e28a2a1 · near:mainnet:aggregate-oracle.near · owned-by · unknown · unknown · unverified [^r4]
- nf:near-2026-11-09:cb076ca93a8a391726a7e03fbee71e1f31711db7 · near:mainnet:priceoracle.near · owned-by · unknown · unknown · unverified [^r5]
- nf:near-2026-11-09:dbed919db4825fc11eb546c624125a396bb8e5e9 · near:mainnet:burrow.sputnik-dao.near · council-member · near:mainnet:nicktrust.near · observed · verified [^r2]
- nf:near-2026-11-09:dfdd567e2ab096b8d471ab669b053313d1cfb163 · near:mainnet:burrow.sputnik-dao.near · council-member · near:mainnet:wannamakeit.near · observed · verified [^r2]
- nf:near-2026-11-09:f00b704708db6283d38edb8d4ffa685314a4667b · near:mainnet:burrow.sputnik-dao.near · vote-threshold · 1/2\|default\|RoleWeight\|quorum:0 · observed · verified [^r2]

## Unknowns and reasons

- missing-coverage · near:mainnet:burrow.sputnik-dao.near · near:mainnet:burrow.sputnik-dao.near#proposals:1549-1748 
- missing-coverage · near:mainnet:rainbowbridge.sputnik-dao.near · near:mainnet:rainbowbridge.sputnik-dao.near#proposals:135-334 
- missing-coverage · near:mainnet:ref-finance.sputnik-dao.near · near:mainnet:ref-finance.sputnik-dao.near#proposals:860-1059 
- missing-coverage · near:mainnet:burrow.sputnik-dao.near · one-live-snapshot:near-2026-11-09 
- missing-subject · near:mainnet:bim.near · near-2026-11-09.governance 
- missing-subject · near:mainnet:brhost.near · near-2026-11-09.governance 
- missing-subject · near:mainnet:brrrb.near · near-2026-11-09.governance 
- missing-subject · near:mainnet:doublerose.near · near-2026-11-09.governance 
- missing-subject · near:mainnet:farbread8025.near · near-2026-11-09.governance 
- missing-subject · near:mainnet:nicktrust.near · near-2026-11-09.governance 
- missing-subject · near:mainnet:refchef.near · near-2026-11-09.governance 
- missing-subject · near:mainnet:wannamakeit.near · near-2026-11-09.governance 
- missing-subject · near:mainnet:zzxbzz.near · near-2026-11-09.governance 
- unknown-controller · near:mainnet:aggregate-oracle.near · nf:near-2026-11-09:c4749babce0f6c3b2d6aec8add2f7f327e28a2a1 [^r4]
- unknown-controller · near:mainnet:dclv2.ref-labs.near · nf:near-2026-11-09:99d267c5960d306fcca87d6c4cce1a74ff810c68 [^r1]
- unknown-controller · near:mainnet:priceoracle.near · nf:near-2026-11-09:cb076ca93a8a391726a7e03fbee71e1f31711db7 [^r5]

## Receipts

[^r1]: nr:near-2026-11-09:0c9f1e1b63eab4ea806e2a7167064f44ff4c8b4a · near-rpc:archival-rpc.mainnet.fastnear.com · block 223810498 · B6dvSC28DswffFXxJUbsF8jVEpyzmnP8fzyU27zHBo7r · response sha256 8d61b9f213f4bef82ae88aa3a419e8a18a247761edecffb646cd371c67d3277d · retrieved 2026-11-09T19:31:24.382Z · current-only
[^r2]: nr:near-2026-11-09:1650e0c6ec434e78c493d2c58c874ae27f135c4a · near-rpc:archival-rpc.mainnet.fastnear.com · block 223810412 · 7WAEdSJFiLdAaRfgqSLXyTfxUYvG9Wd8SbqSPWQo8FA9 · response sha256 a53de94d04c87280f40b51ca2d0e949c94a2a7179a4e4552c94c5c7e538f638a · retrieved 2026-11-09T19:30:34.309Z · current-only
[^r3]: nr:near-2026-11-09:54f6b671fa124d0aae07bf57185cadef9749d2d9 · near-rpc:archival-rpc.mainnet.fastnear.com · block 223810418 · 7TRQHbKvvprmDr4cpankHFatZ16KmG4nBWu1sTc1vMgM · response sha256 32670349d45bafebd1e9ee9d7cf7fac6dc9fe34be9d60ac1cb55fadcd6ee8a8a · retrieved 2026-11-09T19:30:38.354Z · current-only
[^r4]: nr:near-2026-11-09:5515e97ff6af700280a1ccc63deef12a34ab5ec5 · near-rpc:archival-rpc.mainnet.fastnear.com · block 223810432 · GcEj8hBLVtdzmBBMH8dNUizH4cbdHLT2Fz9f5U8Der3j · response sha256 d8237d331bd29f737237bdce35becda653fcc4697bbb50d8c0b51d712694832a · retrieved 2026-11-09T19:30:46.323Z · current-only
[^r5]: nr:near-2026-11-09:589ea7b5491cb213565363864fca756f538667cb · near-rpc:archival-rpc.mainnet.fastnear.com · block 223810442 · A65oUq2G6xscNNFYRLEzpbvaSkHPBJCgMHZKktQh6Jx9 · response sha256 6e14568e2bec31f848fae04fffe23df0b8df5e9bd43c4dcecc8cb0d6ba5dd841 · retrieved 2026-11-09T19:30:52.371Z · current-only
[^r6]: nr:near-2026-11-09:6b3f029a635dc5c71483c2f8d28fa0075b79f4c5 · near-rpc:archival-rpc.mainnet.fastnear.com · block 223810422 · E37sJHrNFVFoejgY6n4Wx25QsZAigmzuje65vpBs97f5 · response sha256 6fcefe09380f6a06d4678ea2a62d2d2b5e789a786f0ea0845833d08636ab28ca · retrieved 2026-11-09T19:30:40.331Z · current-only
[^r7]: nr:near-2026-11-09:b8c5aa84602e9aa9e4d8e515827e922ea56892f2 · near-rpc:archival-rpc.mainnet.fastnear.com · block 223810402 · 2MhMquWbYBote5zaAo7ojonh4b2qcUKvZcDbTN1zfSu2 · response sha256 0e34e50fad6d477bb19c8b120e0cd24fc5ccd585883e29ad7a4ac6b581fb1fd6 · retrieved 2026-11-09T19:30:28.329Z · current-only
