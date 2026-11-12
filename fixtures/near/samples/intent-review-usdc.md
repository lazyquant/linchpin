# Intent review · nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near
route family   omni_bridge (rules 0.95.0)
verifier       intents.near · paused false
upgrade        Upgrader → ctl-intents.near · 0.4.5 since 2026-10-07T19:53:17.418Z
pause          PauseManager → 7 accounts · UnpauseManager → 0
freeze         UnrestrictedAccountLocker → 2 accounts
roles          intents.sputnik-dao.near: 3 of 5 · no execution delay field
off-chain      solver-class, message-bus, operator-terms (claimed documents)
unknowns       29 reasons · outcome partial
snapshot       near-2026-11-09 · blocks 223810396–223824327 · asOf 2026-11-09T21:43:57.668Z

## Quote (claimed by 1Click)

not recorded

1Click requires a deadline for dry quotes (HTTP 400, recorded 2026-11-09); not sent by decision

Evidence: 1click.chaindefuser.com · HTTP 400 · recorded 2026-11-09 · request sha256 921d0759e61c57e0da5b9c5351cc34008bc7fb706854b2b37905e221f3bf1fee · response sha256 aa44f533abd1ba5c0b1decc27980afa6d2a3df49c328e90fb3be69bd2649d9de. Only the response hash and diagnostic were retained; no quote figures are recorded.

## Route evidence

- nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near: omni_bridge; migrated_from: poa
  SDK 0.95.0 documented migration table: listed; dist/src/constants/poa-tokens-migrated-to-omni-bridge.js; sha256 0d2d4ad9210972538d098b918caefabca54e37f79a599d37e9d07c8dfce0a5e3.
  - code hash: Ba6uZKxsuRPW5X7XVQrSnYEYScEjFLJLMqMWvZ1aS3tC · observed, verified · block 223824227 [^route:02d11af264ff0cf0a67511f8ad2b683e036c0612]
  - source metadata: {"version":"0.4.3","link":"https://github.com/Near-One/omni-bridge/tree/9f0bf056814265c0b0f85f5820cd4b4cff7e90a1","standards":[{"standard":"nep330","version":"1.3.0"}],"build_info":{"build_environment":"sourcescan/cargo-near:0.16.0-rust-1.86.0@sha256:3220302ebb7036c1942e772810f21edd9381edf9a339983da43487c77fbad488","build_command":["cargo","near","build","non-reproducible-wasm","--locked"],"contract_path":"near/omni-token","source_code_snapshot":"git+https://github.com/Near-One/omni-bridge?rev=9f0bf056814265c0b0f85f5820cd4b4cff7e90a1","output_wasm_path":"/home/near/code/near/target/near/omni_token/omni_token.wasm"}} · observed, verified · block 223824229 [^route:75b6b4c091d2ef8005c4264423d5f79b5ae00809]
  - owner: undetermined
  - controller: omni.bridge.near · decoded, verified · block 223823983 [^route:7ec56fbc599977ed2c53a0aae035fc73fd7bb12f]
  - Omni mapping: sol:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v · observed, verified · block 223824233 [^route:3a2b8d6ed8cde5cfd9016fccf444ed0ad95cb6f8]
  - Omni reverse mapping: near:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near · observed, verified · block 223824235 [^route:f66ff37f2d8de8e689bc7ef98478939d6cb556c1]
  - withdraw relayer (account fact only): 2d41f68af1207ee6b96d5002bf60671686facefb5a50e69e7a8aff2431dedc56 · decoded, verified · block 223823984 [^route:b2190736c42efc0af2f61520832a6249f03ec2a1]

## Chain

1. **asset** · sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near · omni_bridge [^nr:near-2026-11-09.intents:538f5f672b21b47fa698a323c51ad620465c6a68][^nr:near-2026-11-09:b1d681db66847fd9cec3d2530588cfee7b87ff46][^nr:near-2026-11-09:cb40d7ec300af5144bca2b1f908be5447c814b08][^nr:near-2026-11-09:f4b9cf3abe314ba42979fb2364e4a40cfb767eae][^route:75b6b4c091d2ef8005c4264423d5f79b5ae00809][^route:7ec56fbc599977ed2c53a0aae035fc73fd7bb12f]
   - unknown-controller · near:mainnet:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near · nf:near-2026-11-09.intents:330d33e2d03292d24c520811e9e42229068fa9cd
2. **verifier** · intents.near · common [^nr:near-2026-11-09:31415f8b44435f5a1f11223a9967dfb349c5d963][^nr:near-2026-11-09:5ba855a7de713bf7beaba66b28dc315040052ad6][^nr:near-2026-11-09:c5d106d093a012e8b2a1e4aef2e35f2c7901614d]
3. **controller** · ctl-intents.near · common [^nr:near-2026-11-09:1ac5a2208b004e4229414362a3872d03fef2cb7c][^nr:near-2026-11-09:c94883a42c4aef4e2a7c4b52048a3d2e7275b2c7]
4. **dao** · intents.sputnik-dao.near · common [^nr:near-2026-11-09:6180a2d40d6b1098dae64d7fcfbf07ef1eca5747][^nr:near-2026-11-09:8b60a80afbf19dfa2eb084040ffed35f29eb3688][^nr:near-2026-11-09:a8b82476cb56d6742a050251c40e2ce142494263][^nr:near-2026-11-09:e98efbbcc434016c7b400cbdfedfbfa7dc0bcd0f]
5. **factory** · sputnik-dao.near · common [^nr:near-2026-11-09:3984abb1bdd39d6b4f60d2e7f2bf5cbead12a509][^nr:near-2026-11-09:8780ac66b951c47774e74e30dde228d002744392]
6. **relay** · relay-key-manager.near · common [^nr:near-2026-11-09:405ec9a3f1bab217779ec9ce4215dec9d778b28d]
7. **bridge** · omni.bridge.near · omni_bridge [^nr:near-2026-11-09:72db96504580714ef8f76382e39cc7a6f5310116][^nr:near-2026-11-09:753026b14a824cc2315491abf1506dab7486a420][^nr:near-2026-11-09:9a111386962c4178bdd94d7aaf7da03cecbe6eca][^nr:near-2026-11-09:fe51c763553bb1227820659912e7e4a312c51095]
   - missing-coverage · near:mainnet:omni.bridge.near · omni-solana-derivation-path
8. **bridge-dao** · rainbowbridge.sputnik-dao.near · omni_bridge [^nr:near-2026-11-09:0fd4f360b7ccfc67df56b8fda82df07488a85b00][^nr:near-2026-11-09:30e901a23b9fa6a3d6d84364ac7baa3e90b51a3c][^nr:near-2026-11-09:70eb394d459197d59ee4aaf5269b5b2019f793a4][^nr:near-2026-11-09:a8b82476cb56d6742a050251c40e2ce142494263]
9. **bridge-ops** · bridge-ops.near · omni_bridge [^nr:near-2026-11-09:b2acb4740cbc14c6d4ddc0d8536548f928810102]
10. **mpc** · v1.signer · omni_bridge [^nr:near-2026-11-09:06ede66ee7945d937fb667f7ee6156f6450b80e2][^nr:near-2026-11-09:584a0261614247044637a1a0814182625df7cc22][^nr:near-2026-11-09:c213a4a6ca2c8b818fc955f131d38dc84d0a0f54]
11. **origin-artefact** · omni.bridge.near#solana:dahPEoZGXfyV58JqqH85okdHmpN8U2q8owgPUXSCPxe · omni_bridge [^rep:2a4009978a14d78452602542098379f7a5213f59]
   - missing-coverage · near:mainnet:omni.bridge.near#solana:dahPEoZGXfyV58JqqH85okdHmpN8U2q8owgPUXSCPxe · nf:near-2026-11-09.intents:fe4d639c57233310d26161190131fb218e5d9290
12. **offchain** · intents.near#offchain:solver-class · common [^doc:083e5f1206597c664535a3f05cf8e107aed52415]
13. **offchain** · intents.near#offchain:message-bus · common [^doc:710bba2b805b294424743b252c0fabc5864a0f8c]
14. **offchain** · intents.near#offchain:operator-terms · common [^doc:c7bbe4d7e16f33226ae80e8201db21a3ea0242d4]
15. **offchain** · intents.near#offchain:shield · common 
   - missing-evidence · — · document:shield

## Control

| Contract | Power | Holders / count | Evidence |
|---|---|---|---|
| sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near | upgrade | omni.bridge.near / 1 | Code control: role grantees, owner and full-access keys where observed [^nr:near-2026-11-09.intents:538f5f672b21b47fa698a323c51ad620465c6a68][^nr:near-2026-11-09:b1d681db66847fd9cec3d2530588cfee7b87ff46][^route:75b6b4c091d2ef8005c4264423d5f79b5ae00809][^route:7ec56fbc599977ed2c53a0aae035fc73fd7bb12f] · unknown-controller |
| intents.near | upgrade | ctl-intents.near / 1 | 0.4.5 since 2026-10-07T19:53:17.418Z [^nr:near-2026-11-09:31415f8b44435f5a1f11223a9967dfb349c5d963][^nr:near-2026-11-09:48d4361e413d776c69e1bf7d631e737dedf62130][^nr:near-2026-11-09:5ba855a7de713bf7beaba66b28dc315040052ad6] |
| intents.near | pause | 5024319f62e6f45f1b2364e6b92c58413d5279d20730cb2e616a613967cb692c, 8e69c33b572dad1f2da6f744c834705e651d3784af2471b58949f2fefd5b55d3, 9600c0ec4de7a77f828965528c8c6028ba3aa430e4537cd25b7865d9430f63ae, ac39364aae9f15438b575f677768c2cf4a7cc74b7dcd198980e8618f003ff538, c98fb45fe2941904f763ff4c2fa2b621b5eb9a57f8daf420679957c08c1a1c34, e33d30ea7c7b271a580bd609100d4f21a07c83f4eb643a1d151c2639471368d0, pm.bridge.near / 7 | PauseManager 7; paused false; UnpauseManager 0 [^nr:near-2026-11-09:5ba855a7de713bf7beaba66b28dc315040052ad6][^nr:near-2026-11-09:c5d106d093a012e8b2a1e4aef2e35f2c7901614d] |
| intents.near | pause (interpretation) | intents.near, intents.sputnik-dao.near / 2 | No account holds UnpauseManager; resuming needs a super admin: near:mainnet:intents.near, near:mainnet:intents.sputnik-dao.near. intents.near has no full-access key. [^nr:near-2026-11-09:31415f8b44435f5a1f11223a9967dfb349c5d963][^nr:near-2026-11-09:5ba855a7de713bf7beaba66b28dc315040052ad6] |
| intents.near | freeze | ac39364aae9f15438b575f677768c2cf4a7cc74b7dcd198980e8618f003ff538, b6be09281567fc42ee6a453c6156445deeb8f09723d769a751646216c5ea00fc / 2 | UnrestrictedAccountLocker: 2 accounts [^nr:near-2026-11-09:5ba855a7de713bf7beaba66b28dc315040052ad6] |
| intents.near | freeze | — / 0 | UnrestrictedAccountUnlocker: 0 accounts [^nr:near-2026-11-09:5ba855a7de713bf7beaba66b28dc315040052ad6] |
| intents.near | grant-roles | intents.near, intents.sputnik-dao.near / 2 | near:mainnet:intents.sputnik-dao.near: 3 of 5 [^nr:near-2026-11-09:5ba855a7de713bf7beaba66b28dc315040052ad6][^nr:near-2026-11-09:8b60a80afbf19dfa2eb084040ffed35f29eb3688] |
| ctl-intents.near | upgrade | — / 0 | Code control: role grantees, owner and full-access keys where observed [^nr:near-2026-11-09:1ac5a2208b004e4229414362a3872d03fef2cb7c] |
| ctl-intents.near | grant-roles | ctl-intents.near, intents.sputnik-dao.near / 2 | near:mainnet:intents.sputnik-dao.near: 3 of 5 [^nr:near-2026-11-09:8b60a80afbf19dfa2eb084040ffed35f29eb3688][^nr:near-2026-11-09:c94883a42c4aef4e2a7c4b52048a3d2e7275b2c7] |
| intents.sputnik-dao.near | upgrade | — / 0 | Code control: role grantees, owner and full-access keys where observed [^nr:near-2026-11-09:e98efbbcc434016c7b400cbdfedfbfa7dc0bcd0f] |
| intents.sputnik-dao.near | execution-delay | — / unknown | policy fields: bounty_bond, bounty_forgiveness_period, default_vote_policy, proposal_bond, proposal_period, roles; none is a delay, timelock or hold [^nr:near-2026-11-09:8b60a80afbf19dfa2eb084040ffed35f29eb3688] |
| sputnik-dao.near | upgrade | ed25519:2gtDEwdLuUBawzFLAnCS9gUso3Ph76bRzMpVrtb66f3J, ed25519:3z2MnvQqD3dsUPynZpV8CFtyXhFiTksjZhjDr26isEXv, ed25519:7ReZXfft58fzSLyCB6A5qQ719DCaDo8etYrat75KFXp3, sputnik-dao.near / 4 | Code control: role grantees, owner and full-access keys where observed [^nr:near-2026-11-09:3984abb1bdd39d6b4f60d2e7f2bf5cbead12a509][^nr:near-2026-11-09:8780ac66b951c47774e74e30dde228d002744392] |
| relay-key-manager.near | upgrade | ed25519:GRKMq1YLpNKnkueySxoXpSDcC5xKCULd6JAjB5PVySmd, ed25519:HxFgUyJTeaZL4hpvWcYTgGXDGo8gzhwfdXFGQYtSNcRu / 2 | Code control: role grantees, owner and full-access keys where observed [^nr:near-2026-11-09:405ec9a3f1bab217779ec9ce4215dec9d778b28d] |
| omni.bridge.near | upgrade | bridge-ops.near / 1 | Code control: role grantees, owner and full-access keys where observed [^nr:near-2026-11-09:9a111386962c4178bdd94d7aaf7da03cecbe6eca][^nr:near-2026-11-09:fe51c763553bb1227820659912e7e4a312c51095] |
| omni.bridge.near | pause | bridge-ops.near, rainbowbridge.sputnik-dao.near / 2 | PauseManager 2; paused false, update_transfer_fee; UnpauseManager 0 [^nr:near-2026-11-09:72db96504580714ef8f76382e39cc7a6f5310116][^nr:near-2026-11-09:753026b14a824cc2315491abf1506dab7486a420][^nr:near-2026-11-09:9a111386962c4178bdd94d7aaf7da03cecbe6eca] |
| omni.bridge.near | grant-roles | rainbowbridge.sputnik-dao.near / 1 | near:mainnet:rainbowbridge.sputnik-dao.near: 3 of 5 [^nr:near-2026-11-09:30e901a23b9fa6a3d6d84364ac7baa3e90b51a3c][^nr:near-2026-11-09:9a111386962c4178bdd94d7aaf7da03cecbe6eca] |
| rainbowbridge.sputnik-dao.near | upgrade | — / 0 | Code control: role grantees, owner and full-access keys where observed [^nr:near-2026-11-09:0fd4f360b7ccfc67df56b8fda82df07488a85b00] |
| rainbowbridge.sputnik-dao.near | execution-delay | — / unknown | policy fields: bounty_bond, bounty_forgiveness_period, default_vote_policy, proposal_bond, proposal_period, roles; none is a delay, timelock or hold [^nr:near-2026-11-09:30e901a23b9fa6a3d6d84364ac7baa3e90b51a3c] |
| bridge-ops.near | upgrade | ed25519:9dgapftKa4JFvVwKb1u8mVZMYP7dkzPJHQQSUxidt7Eq, ed25519:DCJ5iNy3j6hQM21WvUGQAWNmTGz32LW7P5XbXtpWRz2x, ed25519:DUJwSzYbFgYdkCNPoPvSwcywz4whQbdxjkRtusF6QgJy, ed25519:GQV12iogS5FUvpk9YTNYnzqjLZQFGtRfpikdzWPtqtwp, ed25519:GtVHcVFpCwh2WW5egqfEURRVgxeFEjS24ECFJSqrbsZ7 / 5 | Code control: role grantees, owner and full-access keys where observed [^nr:near-2026-11-09:b2acb4740cbc14c6d4ddc0d8536548f928810102] |
| v1.signer | upgrade | — / 0 | Code control: role grantees, owner and full-access keys where observed [^nr:near-2026-11-09:06ede66ee7945d937fb667f7ee6156f6450b80e2] |
| v1.signer | sign-withdrawals | astrostakers-mainnet.near, bitwise-mpc01.near, everstake-mpc-1.near, greenfield-mpc01.near, hashkeympc.near, klever-nearmpc-01.near, mpc-lgns.near, mpch-01.near, multichain-mainnet-aurora.near, n1-multichain.near, nansen-ai-mpc.near, natsai-mpc.near, near-mpc-staking4all-01.near, nodemonster.near, stakin-mpc.near, svrn-01.near / 16 | threshold 11; 16 participants [^nr:near-2026-11-09:584a0261614247044637a1a0814182625df7cc22] |

## What changed

No live snapshot pair is available. The dated on-chain history follows.

Controller versions:
- initial@2024-11-05T08:20:58.000Z [^nr:near-2026-11-09:48d4361e413d776c69e1bf7d631e737dedf62130]
- 0.1.1@2024-11-06T12:28:27.734Z [^nr:near-2026-11-09:48d4361e413d776c69e1bf7d631e737dedf62130]
- 0.1.2@2024-11-22T18:37:25.062Z [^nr:near-2026-11-09:48d4361e413d776c69e1bf7d631e737dedf62130]
- 0.2.0@2024-12-10T12:31:20.742Z [^nr:near-2026-11-09:48d4361e413d776c69e1bf7d631e737dedf62130]
- 0.2.1@2025-01-22T09:08:20.001Z [^nr:near-2026-11-09:48d4361e413d776c69e1bf7d631e737dedf62130]
- 0.2.2@2025-02-03T15:38:21.766Z [^nr:near-2026-11-09:48d4361e413d776c69e1bf7d631e737dedf62130]
- 0.2.2@2025-02-18T21:24:40.609Z [^nr:near-2026-11-09:48d4361e413d776c69e1bf7d631e737dedf62130]
- 0.2.3@2025-02-18T22:06:33.467Z [^nr:near-2026-11-09:48d4361e413d776c69e1bf7d631e737dedf62130]
- 0.2.5@2025-05-26T20:17:24.282Z [^nr:near-2026-11-09:48d4361e413d776c69e1bf7d631e737dedf62130]
- 0.2.6@2025-06-09T10:17:13.784Z [^nr:near-2026-11-09:48d4361e413d776c69e1bf7d631e737dedf62130]
- 0.2.7@2025-06-09T20:21:57.952Z [^nr:near-2026-11-09:48d4361e413d776c69e1bf7d631e737dedf62130]
- 0.2.5@2025-06-10T19:24:56.059Z [^nr:near-2026-11-09:48d4361e413d776c69e1bf7d631e737dedf62130]
- 0.2.8@2025-06-10T19:58:52.020Z [^nr:near-2026-11-09:48d4361e413d776c69e1bf7d631e737dedf62130]
- 0.2.9@2025-06-25T13:49:31.498Z [^nr:near-2026-11-09:48d4361e413d776c69e1bf7d631e737dedf62130]
- 0.2.10@2025-09-11T08:16:20.034Z [^nr:near-2026-11-09:48d4361e413d776c69e1bf7d631e737dedf62130]
- 0.3.0@2025-10-29T08:09:23.806Z [^nr:near-2026-11-09:48d4361e413d776c69e1bf7d631e737dedf62130]
- 0.4.0@2025-12-03T10:58:03.074Z [^nr:near-2026-11-09:48d4361e413d776c69e1bf7d631e737dedf62130]
- 0.4.1@2025-12-03T21:12:48.361Z [^nr:near-2026-11-09:48d4361e413d776c69e1bf7d631e737dedf62130]
- 0.4.2@2026-01-15T18:12:00.176Z [^nr:near-2026-11-09:48d4361e413d776c69e1bf7d631e737dedf62130]
- 0.4.4@2026-10-02T20:31:42.189Z [^nr:near-2026-11-09:48d4361e413d776c69e1bf7d631e737dedf62130]
- 0.4.5@2026-10-07T19:53:17.418Z [^nr:near-2026-11-09:48d4361e413d776c69e1bf7d631e737dedf62130]

MPC observation: 16 participants; threshold 11. [^nr:near-2026-11-09:584a0261614247044637a1a0814182625df7cc22]

History · intents.near
- 2024-11-05T08:20:58.000Z · code-deployed · nf:near-2026-11-09:a959cbb6e9893da3e35ae43277fd13b119c3ea08 [^nr:near-2026-11-09:48d4361e413d776c69e1bf7d631e737dedf62130]
- 2024-11-06T12:28:27.734Z · code-upgrade · nf:near-2026-11-09:b1bf11944302fae5d3bf63c865c374d870061910 [^nr:near-2026-11-09:48d4361e413d776c69e1bf7d631e737dedf62130]
- 2024-11-06T14:23:23.931Z · acl · nf:near-2026-11-09:b67e38616f2c915bccce38b36b9ca467aea9714b [^nr:near-2026-11-09:f2a91025dfac21d06fbd11ac5d39f1b76720c1b0]
- 2024-11-06T14:52:41.928Z · membership · nf:near-2026-11-09:ec0573e33e267229ef21070f661fd9ca8deb4516 [^nr:near-2026-11-09:f2a91025dfac21d06fbd11ac5d39f1b76720c1b0]
- 2024-11-07T17:02:10.377Z · policy · nf:near-2026-11-09:6a562b1da5e24008246697cbcdb6add45995c09b [^nr:near-2026-11-09:f2a91025dfac21d06fbd11ac5d39f1b76720c1b0]
- 2024-11-12T10:55:33.591Z · membership · nf:near-2026-11-09:473aeb775a5c85b8226ebd9372f4cc81664b4168 [^nr:near-2026-11-09:f2a91025dfac21d06fbd11ac5d39f1b76720c1b0]
- 2024-11-12T11:03:21.988Z · membership · nf:near-2026-11-09:1656cdc63027cc90ab5dc712eff4b782cdc53307 [^nr:near-2026-11-09:f2a91025dfac21d06fbd11ac5d39f1b76720c1b0]
- 2024-11-22T18:37:25.062Z · code-upgrade · nf:near-2026-11-09:c6a108bc3606c9ba9526118cb9294fe77d9caeed [^nr:near-2026-11-09:48d4361e413d776c69e1bf7d631e737dedf62130]
- 2024-12-10T12:31:20.742Z · code-upgrade · nf:near-2026-11-09:62d4720e0b7df98599a4d40997c06319382632c9 [^nr:near-2026-11-09:48d4361e413d776c69e1bf7d631e737dedf62130]
- 2024-12-17T13:25:04.614Z · acl · nf:near-2026-11-09:fccd370f6807ea473601eea67e9b3f1e6e1d1c09 [^nr:near-2026-11-09:f2a91025dfac21d06fbd11ac5d39f1b76720c1b0]
- 2024-12-18T07:45:43.059Z · acl · nf:near-2026-11-09:ebec15e558891ee307cfa665f08aed441c9deeef [^nr:near-2026-11-09:f2a91025dfac21d06fbd11ac5d39f1b76720c1b0]
- 2024-12-18T07:46:40.526Z · acl · nf:near-2026-11-09:473caf8e7f56306bbd9a9bfa45682df016288f06 [^nr:near-2026-11-09:f2a91025dfac21d06fbd11ac5d39f1b76720c1b0]
- 2024-12-18T07:47:32.067Z · acl · nf:near-2026-11-09:ff18a1f393e3da6bd523654bb46acbc97a2eb4bf [^nr:near-2026-11-09:f2a91025dfac21d06fbd11ac5d39f1b76720c1b0]
- 2024-12-18T07:48:22.723Z · acl · nf:near-2026-11-09:b0a5b1fab6984ecffe7d440c99012874f6320ae1 [^nr:near-2026-11-09:f2a91025dfac21d06fbd11ac5d39f1b76720c1b0]
- 2025-01-17T14:26:29.954Z · acl · nf:near-2026-11-09:f705915dc8f340410c3f138dc9c428b1d3fd5ac4 [^nr:near-2026-11-09:f2a91025dfac21d06fbd11ac5d39f1b76720c1b0]
- 2025-01-22T09:08:20.001Z · code-upgrade · nf:near-2026-11-09:f9f308419828e297b0681b562f8130191332eec2 [^nr:near-2026-11-09:48d4361e413d776c69e1bf7d631e737dedf62130]
- 2025-02-03T15:38:21.766Z · code-upgrade · nf:near-2026-11-09:acd549f583af712fa38ba16ad425115a2582dab0 [^nr:near-2026-11-09:48d4361e413d776c69e1bf7d631e737dedf62130]
- 2025-02-18T21:24:40.609Z · code-upgrade · nf:near-2026-11-09:abed08b0c534e6e92f5aec47ac32cf94255e4e26 [^nr:near-2026-11-09:48d4361e413d776c69e1bf7d631e737dedf62130]
- 2025-02-18T22:06:33.467Z · code-upgrade · nf:near-2026-11-09:60de8972faf5b7d1e3fde7316c422c0fa9196823 [^nr:near-2026-11-09:48d4361e413d776c69e1bf7d631e737dedf62130]
- 2025-04-11T20:58:30.417Z · policy · nf:near-2026-11-09:d534f9e57a06d34b92d76a90a34bcd274d19d5e2 [^nr:near-2026-11-09:f2a91025dfac21d06fbd11ac5d39f1b76720c1b0]
- 2025-04-13T17:15:17.409Z · policy · nf:near-2026-11-09:6e0f28739f91f16dbfe87c89cbcbb9e872daa167 [^nr:near-2026-11-09:f2a91025dfac21d06fbd11ac5d39f1b76720c1b0]
- 2025-05-26T20:17:24.282Z · code-upgrade · nf:near-2026-11-09:d27c7b2021afd8951d971a5244e6b78d5c386da6 [^nr:near-2026-11-09:48d4361e413d776c69e1bf7d631e737dedf62130]
- 2025-06-09T10:17:13.784Z · code-upgrade · nf:near-2026-11-09:aad41864d5a3629387069149652c3db633036b8f [^nr:near-2026-11-09:48d4361e413d776c69e1bf7d631e737dedf62130]
- 2025-06-09T20:21:57.952Z · code-upgrade · nf:near-2026-11-09:de2b3c78e17583fc44cae09d42c80e7d9c9e4b7a [^nr:near-2026-11-09:48d4361e413d776c69e1bf7d631e737dedf62130]
- 2025-06-10T19:24:56.059Z · code-upgrade · nf:near-2026-11-09:d4a7c38ab52cfcc3f7ddb7a79b8189ad60749b33 [^nr:near-2026-11-09:48d4361e413d776c69e1bf7d631e737dedf62130]
- 2025-06-10T19:58:52.020Z · code-upgrade · nf:near-2026-11-09:030fa41eed705817cddbc4186e1572eee3546a68 [^nr:near-2026-11-09:48d4361e413d776c69e1bf7d631e737dedf62130]
- 2025-06-25T13:49:31.498Z · code-upgrade · nf:near-2026-11-09:60f4b2ff8c9ccbfb6f44e34d2923eb59724a4160 [^nr:near-2026-11-09:48d4361e413d776c69e1bf7d631e737dedf62130]
- 2025-09-11T08:16:20.034Z · code-upgrade · nf:near-2026-11-09:8e54d8bc71cf19db649b802a4bd2f02117b84093 [^nr:near-2026-11-09:48d4361e413d776c69e1bf7d631e737dedf62130]
- 2025-10-29T08:09:23.806Z · code-upgrade · nf:near-2026-11-09:9d32733723ed9071d50f062b825364a494b9db0d [^nr:near-2026-11-09:48d4361e413d776c69e1bf7d631e737dedf62130]
- 2025-11-03T13:39:19.153Z · acl · nf:near-2026-11-09:17f62ca2bdf21a1aadbc3191c7b4ab93903ca135 [^nr:near-2026-11-09:f2a91025dfac21d06fbd11ac5d39f1b76720c1b0]
- 2025-12-03T10:58:03.074Z · code-upgrade · nf:near-2026-11-09:c5e66f12e8ebeb9514fbdd1cc2541337b3cc35e9 [^nr:near-2026-11-09:48d4361e413d776c69e1bf7d631e737dedf62130]
- 2025-12-03T21:12:48.361Z · code-upgrade · nf:near-2026-11-09:700c9cddf39633ba19f3ff0c755666365d89bf66 [^nr:near-2026-11-09:48d4361e413d776c69e1bf7d631e737dedf62130]
- 2026-01-15T17:36:29.867Z · pause · nf:near-2026-11-09:99a76aeceaddd3f56d78570a83f2bb0cfdd04cef [^nr:near-2026-11-09:f2a91025dfac21d06fbd11ac5d39f1b76720c1b0]
- 2026-01-15T18:12:00.176Z · code-upgrade · nf:near-2026-11-09:ae3f8e4da456cd473c81253c4f9a1eb2783a43d7 [^nr:near-2026-11-09:48d4361e413d776c69e1bf7d631e737dedf62130]
- 2026-04-16T17:52:49.732Z · pause · nf:near-2026-11-09:44a9c3afa251d880bbc2a8ebf6ce8b535f679bef [^nr:near-2026-11-09:f2a91025dfac21d06fbd11ac5d39f1b76720c1b0]
- 2026-04-16T17:59:02.374Z · acl · nf:near-2026-11-09:15072b683363cb17acd56b6d98acd680b6ebd2fb [^nr:near-2026-11-09:f2a91025dfac21d06fbd11ac5d39f1b76720c1b0]
- 2026-06-08T08:30:18.961Z · acl · nf:near-2026-11-09:6b4dbf5dbce1a2ee011a824578ca92fdfab77bc9 [^nr:near-2026-11-09:f2a91025dfac21d06fbd11ac5d39f1b76720c1b0]
- 2026-06-23T07:52:28.659Z · acl · nf:near-2026-11-09:d963b6fb7b8e3bfc45c584cd686629d77871b06a [^nr:near-2026-11-09:f2a91025dfac21d06fbd11ac5d39f1b76720c1b0]
- 2026-09-01T21:00:52.983Z · pause · nf:near-2026-11-09:729d8263245b8abd2dcfc8283e7714fbf6c40d89 [^nr:near-2026-11-09:f2a91025dfac21d06fbd11ac5d39f1b76720c1b0]
- 2026-10-01T10:13:04.462Z · pause · nf:near-2026-11-09:f9f52ed6469b387aba146de86d30e338e7f0cad8 [^nr:near-2026-11-09:f2a91025dfac21d06fbd11ac5d39f1b76720c1b0]
- 2026-10-01T21:51:39.488Z · pause · nf:near-2026-11-09:f4c9b5a55ba90b151eb705942e8be615a55be844 [^nr:near-2026-11-09:db5c2d6badb44133490cf92d80e6586666591534]
- 2026-10-02T20:31:42.189Z · code-upgrade · nf:near-2026-11-09:2df80fee1ef839ed9821c39f2c2a9f3d4d39cdeb [^nr:near-2026-11-09:48d4361e413d776c69e1bf7d631e737dedf62130]
- 2026-10-07T14:42:04.371Z · policy · nf:near-2026-11-09:96d8fd683860443fea6e4d6b6accc301b1d06178 [^nr:near-2026-11-09:db5c2d6badb44133490cf92d80e6586666591534]
- 2026-10-07T18:45:26.162Z · pause · nf:near-2026-11-09:d8decb8e6c11c77e6ee975d1088eb87e554a1665 [^nr:near-2026-11-09:db5c2d6badb44133490cf92d80e6586666591534]
- 2026-10-07T19:53:17.418Z · code-upgrade · nf:near-2026-11-09:1dc53723e4c909a828d06bfa87a204b62d912d7d [^nr:near-2026-11-09:48d4361e413d776c69e1bf7d631e737dedf62130]
- 2026-10-12T08:58:53.286Z · membership · nf:near-2026-11-09:2ea7b08249cb6686b3e29bb841adee45d9cf98f4 [^nr:near-2026-11-09:db5c2d6badb44133490cf92d80e6586666591534]
- 2026-10-12T09:01:22.466Z · membership · nf:near-2026-11-09:abc4aa28f176c3e23ca6a9fc9aad4c0254bac28a [^nr:near-2026-11-09:db5c2d6badb44133490cf92d80e6586666591534]
- 2026-10-16T13:18:21.374Z · acl · nf:near-2026-11-09:20acac38d216c9ded2fe2a1e12c4c17bb564d9a2 [^nr:near-2026-11-09:db5c2d6badb44133490cf92d80e6586666591534]
- 2026-10-30T11:22:33.854Z · acl · nf:near-2026-11-09:8b175c5934c64c1c775eb485ac97d95873be4d3e [^nr:near-2026-11-09:db5c2d6badb44133490cf92d80e6586666591534]

History · ctl-intents.near
- 2024-11-06T13:39:31.717Z · acl · nf:near-2026-11-09:bac1cc5698bdc31fbed394d196166be1dd6c3187 [^nr:near-2026-11-09:f2a91025dfac21d06fbd11ac5d39f1b76720c1b0]
- 2024-11-06T14:52:41.928Z · membership · nf:near-2026-11-09:ec0573e33e267229ef21070f661fd9ca8deb4516 [^nr:near-2026-11-09:f2a91025dfac21d06fbd11ac5d39f1b76720c1b0]
- 2024-11-07T17:02:10.377Z · policy · nf:near-2026-11-09:6a562b1da5e24008246697cbcdb6add45995c09b [^nr:near-2026-11-09:f2a91025dfac21d06fbd11ac5d39f1b76720c1b0]
- 2024-11-12T10:55:33.591Z · membership · nf:near-2026-11-09:473aeb775a5c85b8226ebd9372f4cc81664b4168 [^nr:near-2026-11-09:f2a91025dfac21d06fbd11ac5d39f1b76720c1b0]
- 2024-11-12T11:03:21.988Z · membership · nf:near-2026-11-09:1656cdc63027cc90ab5dc712eff4b782cdc53307 [^nr:near-2026-11-09:f2a91025dfac21d06fbd11ac5d39f1b76720c1b0]
- 2024-11-22T10:08:27.374Z · remote-upgrade · nf:near-2026-11-09:8c4ae22d2704a9bd80984001e1273f51b5c731c9 [^nr:near-2026-11-09:f2a91025dfac21d06fbd11ac5d39f1b76720c1b0]
- 2024-12-10T10:09:04.018Z · remote-upgrade · nf:near-2026-11-09:603f6a9088c900443571ca1e0d79486a37260bf3 [^nr:near-2026-11-09:f2a91025dfac21d06fbd11ac5d39f1b76720c1b0]
- 2025-01-22T08:53:09.180Z · remote-upgrade · nf:near-2026-11-09:7a9bbb955d86d192fa448d1d6605268c0689f3c3 [^nr:near-2026-11-09:f2a91025dfac21d06fbd11ac5d39f1b76720c1b0]
- 2025-02-03T14:47:28.115Z · remote-upgrade · nf:near-2026-11-09:4a8b63f39fc758b39b86c67b047b3c06af974af0 [^nr:near-2026-11-09:f2a91025dfac21d06fbd11ac5d39f1b76720c1b0]
- 2025-02-18T22:01:03.792Z · acl · nf:near-2026-11-09:170e75ec23a16f78c052289a74518dec92437025 [^nr:near-2026-11-09:f2a91025dfac21d06fbd11ac5d39f1b76720c1b0]
- 2025-04-11T20:58:30.417Z · policy · nf:near-2026-11-09:d534f9e57a06d34b92d76a90a34bcd274d19d5e2 [^nr:near-2026-11-09:f2a91025dfac21d06fbd11ac5d39f1b76720c1b0]
- 2025-04-13T17:15:17.409Z · policy · nf:near-2026-11-09:6e0f28739f91f16dbfe87c89cbcbb9e872daa167 [^nr:near-2026-11-09:f2a91025dfac21d06fbd11ac5d39f1b76720c1b0]
- 2025-06-09T18:58:09.989Z · acl · nf:near-2026-11-09:06a0c947b585282b163bc59d441f2e9869073483 [^nr:near-2026-11-09:f2a91025dfac21d06fbd11ac5d39f1b76720c1b0]
- 2025-06-10T20:15:57.065Z · acl · nf:near-2026-11-09:e66856a484b679a000cc5ee84177c93118cd0d12 [^nr:near-2026-11-09:f2a91025dfac21d06fbd11ac5d39f1b76720c1b0]
- 2026-10-07T14:42:04.371Z · policy · nf:near-2026-11-09:96d8fd683860443fea6e4d6b6accc301b1d06178 [^nr:near-2026-11-09:db5c2d6badb44133490cf92d80e6586666591534]
- 2026-10-12T08:58:53.286Z · membership · nf:near-2026-11-09:2ea7b08249cb6686b3e29bb841adee45d9cf98f4 [^nr:near-2026-11-09:db5c2d6badb44133490cf92d80e6586666591534]
- 2026-10-12T09:01:22.466Z · membership · nf:near-2026-11-09:abc4aa28f176c3e23ca6a9fc9aad4c0254bac28a [^nr:near-2026-11-09:db5c2d6badb44133490cf92d80e6586666591534]

History · intents.sputnik-dao.near
- 2024-11-06T14:52:41.928Z · membership · nf:near-2026-11-09:ec0573e33e267229ef21070f661fd9ca8deb4516 [^nr:near-2026-11-09:f2a91025dfac21d06fbd11ac5d39f1b76720c1b0]
- 2024-11-07T17:02:10.377Z · policy · nf:near-2026-11-09:6a562b1da5e24008246697cbcdb6add45995c09b [^nr:near-2026-11-09:f2a91025dfac21d06fbd11ac5d39f1b76720c1b0]
- 2024-11-12T10:55:33.591Z · membership · nf:near-2026-11-09:473aeb775a5c85b8226ebd9372f4cc81664b4168 [^nr:near-2026-11-09:f2a91025dfac21d06fbd11ac5d39f1b76720c1b0]
- 2024-11-12T11:03:21.988Z · membership · nf:near-2026-11-09:1656cdc63027cc90ab5dc712eff4b782cdc53307 [^nr:near-2026-11-09:f2a91025dfac21d06fbd11ac5d39f1b76720c1b0]
- 2025-04-11T20:58:30.417Z · policy · nf:near-2026-11-09:d534f9e57a06d34b92d76a90a34bcd274d19d5e2 [^nr:near-2026-11-09:f2a91025dfac21d06fbd11ac5d39f1b76720c1b0]
- 2025-04-13T17:15:17.409Z · policy · nf:near-2026-11-09:6e0f28739f91f16dbfe87c89cbcbb9e872daa167 [^nr:near-2026-11-09:f2a91025dfac21d06fbd11ac5d39f1b76720c1b0]
- 2026-10-07T14:42:04.371Z · policy · nf:near-2026-11-09:96d8fd683860443fea6e4d6b6accc301b1d06178 [^nr:near-2026-11-09:db5c2d6badb44133490cf92d80e6586666591534]
- 2026-10-12T08:58:53.286Z · membership · nf:near-2026-11-09:2ea7b08249cb6686b3e29bb841adee45d9cf98f4 [^nr:near-2026-11-09:db5c2d6badb44133490cf92d80e6586666591534]
- 2026-10-12T09:01:22.466Z · membership · nf:near-2026-11-09:abc4aa28f176c3e23ca6a9fc9aad4c0254bac28a [^nr:near-2026-11-09:db5c2d6badb44133490cf92d80e6586666591534]

History · omni.bridge.near
- 2025-10-02T16:56:15.255Z · acl · nf:near-2026-11-09:1ee6980c995df4e7360099b21f85d36397daa346 [^nr:near-2026-11-09:b4f58005794b63e8196edb652d55168d78b1a889]
- 2026-03-06T15:02:02.854Z · acl · nf:near-2026-11-09:393041708034afc3508ff06bde3acde074945b45 [^nr:near-2026-11-09:b4f58005794b63e8196edb652d55168d78b1a889]
- 2026-03-17T13:15:19.294Z · pause · nf:near-2026-11-09:ec41d9d323545a37de8e6fc1b93601f02d93b49a [^nr:near-2026-11-09:b4f58005794b63e8196edb652d55168d78b1a889]
- 2026-03-17T13:30:22.292Z · acl · nf:near-2026-11-09:7c7f42da88e1f8de1c25edd1b0afec1175c1f08c [^nr:near-2026-11-09:b4f58005794b63e8196edb652d55168d78b1a889]
- 2026-03-17T13:31:01.342Z · acl · nf:near-2026-11-09:493e3dead68b70cb283671599adb37ea5349d7ff [^nr:near-2026-11-09:b4f58005794b63e8196edb652d55168d78b1a889]
- 2026-03-30T15:10:03.734Z · acl · nf:near-2026-11-09:46afaebdb1ad5d7898eafcda15d624bed3f59bfe [^nr:near-2026-11-09:b4f58005794b63e8196edb652d55168d78b1a889]
- 2026-04-21T11:14:17.438Z · acl · nf:near-2026-11-09:094f6b64629cd83972cb282a610eee3de8bce1b3 [^nr:near-2026-11-09:b4f58005794b63e8196edb652d55168d78b1a889]
- 2026-05-07T13:41:02.848Z · acl · nf:near-2026-11-09:6370cab54f0d22807cd9ca15d0171084281b6b38 [^nr:near-2026-11-09:dc4f2aa936b73abe716823521f73a81d53a10ebb]
- 2026-06-03T14:32:34.673Z · acl · nf:near-2026-11-09:84387de1dab193c59f7ef7c1f5859ea989f98dca [^nr:near-2026-11-09:dc4f2aa936b73abe716823521f73a81d53a10ebb]
- 2026-06-30T16:12:31.577Z · acl · nf:near-2026-11-09:5acdfc6a06909f49a30663fac0d28db9b2858411 [^nr:near-2026-11-09:dc4f2aa936b73abe716823521f73a81d53a10ebb]
- 2026-09-30T15:25:01.057Z · acl · nf:near-2026-11-09:1571ac10e60b5722cb535cb33819f9ed364fa520 [^nr:near-2026-11-09:dc4f2aa936b73abe716823521f73a81d53a10ebb]
- 2026-10-27T21:26:18.393Z · acl · nf:near-2026-11-09:a5c8eac7916155901db9e9842c05e5921e114790 [^nr:near-2026-11-09:dc4f2aa936b73abe716823521f73a81d53a10ebb]

## Origin is not backing

Token origin is a label, not a claim. That this token was issued for an asset on another chain does not show that it can be exchanged for that asset, nor that it carries that chain's security. The facts below are the custody facts this review has; the reasons below are the ones it lacks.

Custody facts:
- near:mainnet:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near owned-by unknown [^nr:near-2026-11-09.intents:538f5f672b21b47fa698a323c51ad620465c6a68]
- near:mainnet:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near has-full-access-key none [^nr:near-2026-11-09:b1d681db66847fd9cec3d2530588cfee7b87ff46]
- near:mainnet:v1.signer mpc-threshold 11 [^nr:near-2026-11-09:584a0261614247044637a1a0814182625df7cc22]
- near:mainnet:omni.bridge.near#solana:dahPEoZGXfyV58JqqH85okdHmpN8U2q8owgPUXSCPxe UPGRADE_AUTHORITY solana:5kx8AapW8tPkiFbuHiuEBcmN3ddwpBWZfCrZgxXgWeb6 [^rep:2a4009978a14d78452602542098379f7a5213f59]

Missing custody evidence:
- missing-coverage · — · origin-chain-balance-not-read
- conflict · near:mainnet:omni.bridge.near#solana:dahPEoZGXfyV58JqqH85okdHmpN8U2q8owgPUXSCPxe · report:solana-class-2026-10-22

## Off-chain, permissioned

- **Solver Terms of Use** — claimed by document: Solvers are a permissioned class: admission checks, API keys, suspension at the operator's discretion. [^doc:083e5f1206597c664535a3f05cf8e107aed52415]
  Source: https://docs.near-intents.org/integration/market-makers/solver-terms-of-use.md · retrieved 2026-11-09T21:40:42.591Z · sha256 083e5f1206597c664535a3f05cf8e107aed524153d3ccbaf3936b0e558ff43ba
- **Message Bus** — claimed by document: Quotes and intents pass through an operator-run relay. [^doc:710bba2b805b294424743b252c0fabc5864a0f8c]
  Source: https://docs.near-intents.org/integration/market-makers/message-bus/introduction.md · retrieved 2026-11-09T21:40:42.675Z · sha256 710bba2b805b294424743b252c0fabc5864a0f8c919a8d8dd03fc6c4d9ba3b3c
- **Terms of service** — claimed by document: Terms set by the operating company. [^doc:c7bbe4d7e16f33226ae80e8201db21a3ea0242d4]
  Source: https://docs.near-intents.org/security-compliance/terms-of-service · retrieved 2026-11-09T21:40:43.110Z · sha256 c7bbe4d7e16f33226ae80e8201db21a3ea0242d4b79237eb1b6b5d4a59e4e909

## Unknowns

Implicit-account holders (not inferred): council 10, Downgrader 2, PauseManager 6, UnrestrictedAccountLocker 2, UnrestrictedRelayer 1, Updater 1.

- missing-coverage · near:mainnet:burrow.sputnik-dao.near · near:mainnet:burrow.sputnik-dao.near#proposals:1549-1748
- missing-coverage · near:mainnet:omni.bridge.near · omni-solana-derivation-path
- missing-coverage · near:mainnet:omni.bridge.near#solana:dahPEoZGXfyV58JqqH85okdHmpN8U2q8owgPUXSCPxe · nf:near-2026-11-09.intents:fe4d639c57233310d26161190131fb218e5d9290
- missing-coverage · near:mainnet:rainbowbridge.sputnik-dao.near · near:mainnet:rainbowbridge.sputnik-dao.near#proposals:135-334
- missing-coverage · near:mainnet:ref-finance.sputnik-dao.near · near:mainnet:ref-finance.sputnik-dao.near#proposals:860-1059
- missing-evidence · — · document:incident-2026-09-29
- missing-evidence · — · document:shield
- missing-history · — · live-snapshot-pair
- missing-subject · near:mainnet:400d1c029b9575ab98af5fae579046d8c5d0bc9341263b6b797839815532dbe7 · near-2026-11-09.intents
- missing-subject · near:mainnet:5024319f62e6f45f1b2364e6b92c58413d5279d20730cb2e616a613967cb692c · near-2026-11-09.intents
- missing-subject · near:mainnet:8043294d1468f766cba17a7cb6ee9e5355afa791e0640d6ede036c48e49ec312 · near-2026-11-09.intents
- missing-subject · near:mainnet:8e69c33b572dad1f2da6f744c834705e651d3784af2471b58949f2fefd5b55d3 · near-2026-11-09.intents
- missing-subject · near:mainnet:9600c0ec4de7a77f828965528c8c6028ba3aa430e4537cd25b7865d9430f63ae · near-2026-11-09.intents
- missing-subject · near:mainnet:ac39364aae9f15438b575f677768c2cf4a7cc74b7dcd198980e8618f003ff538 · near-2026-11-09.intents
- missing-subject · near:mainnet:b35bca448dbd81f5f4db70f46d7f99ee04e1e66900c05a908ba61e0e16bc0efe · near-2026-11-09.intents
- missing-subject · near:mainnet:b530f2243673f233b2e12e526c500101b76139c032b1b8f1c6f0ef88fcd4dc25 · near-2026-11-09.intents
- missing-subject · near:mainnet:b6be09281567fc42ee6a453c6156445deeb8f09723d769a751646216c5ea00fc · near-2026-11-09.intents
- missing-subject · near:mainnet:b94b3558971e4dedf18c3c187534f3929c8c62b1cb92d59245537224dcb477b6 · near-2026-11-09.intents
- missing-subject · near:mainnet:c98fb45fe2941904f763ff4c2fa2b621b5eb9a57f8daf420679957c08c1a1c34 · near-2026-11-09.intents
- missing-subject · near:mainnet:e33d30ea7c7b271a580bd609100d4f21a07c83f4eb643a1d151c2639471368d0 · near-2026-11-09.intents
- missing-subject · near:mainnet:e4e352a1ed9f5de5af31423068fe1d61f95db3fea32af597b719dc7e8cdf51c7 · near-2026-11-09.intents
- missing-subject · near:mainnet:ec0fe8a0e723f121997d4ceea4b1abdbb07fcca3d18d9f9e7b62e441deb9966e · near-2026-11-09.intents
- missing-subject · near:mainnet:int-dpl-dao.sputnik-dao.near · near-2026-11-09.intents
- missing-subject · near:mainnet:intents-relayer.near · near-2026-11-09.intents
- missing-subject · near:mainnet:omni-relayer.bridge.near · near-2026-11-09.intents
- missing-subject · near:mainnet:relay.aurora · near-2026-11-09.intents
- no-facts · near:mainnet:v1.signer · —
- truncated · near:mainnet:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near · —
- unknown-controller · near:mainnet:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near · nf:near-2026-11-09.intents:330d33e2d03292d24c520811e9e42229068fa9cd

## Receipts

[^doc:083e5f1206597c664535a3f05cf8e107aed52415]: doc:083e5f1206597c664535a3f05cf8e107aed52415 · document:docs.near-intents.org · — · 083e5f120659
[^doc:710bba2b805b294424743b252c0fabc5864a0f8c]: doc:710bba2b805b294424743b252c0fabc5864a0f8c · document:docs.near-intents.org · — · 710bba2b805b
[^doc:c7bbe4d7e16f33226ae80e8201db21a3ea0242d4]: doc:c7bbe4d7e16f33226ae80e8201db21a3ea0242d4 · document:docs.near-intents.org · — · c7bbe4d7e16f
[^nr:near-2026-11-09:06ede66ee7945d937fb667f7ee6156f6450b80e2]: nr:near-2026-11-09:06ede66ee7945d937fb667f7ee6156f6450b80e2 · near-rpc:archival-rpc.mainnet.fastnear.com · 223810699 · f0f02da06511
[^nr:near-2026-11-09:0fd4f360b7ccfc67df56b8fda82df07488a85b00]: nr:near-2026-11-09:0fd4f360b7ccfc67df56b8fda82df07488a85b00 · near-rpc:archival-rpc.mainnet.fastnear.com · 223810650 · 778ddbd33709
[^nr:near-2026-11-09:1ac5a2208b004e4229414362a3872d03fef2cb7c]: nr:near-2026-11-09:1ac5a2208b004e4229414362a3872d03fef2cb7c · near-rpc:archival-rpc.mainnet.fastnear.com · 223810522 · 79d2ec7033ee
[^nr:near-2026-11-09:1f4a1a65bd2224dc5289dfa165bbedb06c81063a]: nr:near-2026-11-09:1f4a1a65bd2224dc5289dfa165bbedb06c81063a · near-rpc:archival-rpc.mainnet.fastnear.com · 223810599 · 04379c6ad319
[^nr:near-2026-11-09:30e901a23b9fa6a3d6d84364ac7baa3e90b51a3c]: nr:near-2026-11-09:30e901a23b9fa6a3d6d84364ac7baa3e90b51a3c · near-rpc:archival-rpc.mainnet.fastnear.com · 223810654 · 4658eea8046d
[^nr:near-2026-11-09:31415f8b44435f5a1f11223a9967dfb349c5d963]: nr:near-2026-11-09:31415f8b44435f5a1f11223a9967dfb349c5d963 · near-rpc:archival-rpc.mainnet.fastnear.com · 223810506 · bbe6400a35e2
[^nr:near-2026-11-09:3984abb1bdd39d6b4f60d2e7f2bf5cbead12a509]: nr:near-2026-11-09:3984abb1bdd39d6b4f60d2e7f2bf5cbead12a509 · near-rpc:archival-rpc.mainnet.fastnear.com · 223810488 · edc65d6bcbc9
[^nr:near-2026-11-09:405ec9a3f1bab217779ec9ce4215dec9d778b28d]: nr:near-2026-11-09:405ec9a3f1bab217779ec9ce4215dec9d778b28d · near-rpc:archival-rpc.mainnet.fastnear.com · 223810558 · 0bdd2440251a
[^nr:near-2026-11-09:48d4361e413d776c69e1bf7d631e737dedf62130]: nr:near-2026-11-09:48d4361e413d776c69e1bf7d631e737dedf62130 · near-rpc:archival-rpc.mainnet.fastnear.com · 223810529 · 120004f31da3
[^nr:near-2026-11-09:584a0261614247044637a1a0814182625df7cc22]: nr:near-2026-11-09:584a0261614247044637a1a0814182625df7cc22 · near-rpc:archival-rpc.mainnet.fastnear.com · 223810703 · da3631f5684e
[^nr:near-2026-11-09:5ba855a7de713bf7beaba66b28dc315040052ad6]: nr:near-2026-11-09:5ba855a7de713bf7beaba66b28dc315040052ad6 · near-rpc:archival-rpc.mainnet.fastnear.com · 223810509 · dadecc7e3eba
[^nr:near-2026-11-09:6180a2d40d6b1098dae64d7fcfbf07ef1eca5747]: nr:near-2026-11-09:6180a2d40d6b1098dae64d7fcfbf07ef1eca5747 · near-rpc:archival-rpc.mainnet.fastnear.com · 223810533 · 2e94603eab1f
[^nr:near-2026-11-09:70eb394d459197d59ee4aaf5269b5b2019f793a4]: nr:near-2026-11-09:70eb394d459197d59ee4aaf5269b5b2019f793a4 · near-rpc:archival-rpc.mainnet.fastnear.com · 223810646 · 8ab131674303
[^nr:near-2026-11-09:72db96504580714ef8f76382e39cc7a6f5310116]: nr:near-2026-11-09:72db96504580714ef8f76382e39cc7a6f5310116 · near-rpc:archival-rpc.mainnet.fastnear.com · 223810639 · b20d4652b891
[^nr:near-2026-11-09:753026b14a824cc2315491abf1506dab7486a420]: nr:near-2026-11-09:753026b14a824cc2315491abf1506dab7486a420 · near-rpc:archival-rpc.mainnet.fastnear.com · 223810642 · bc2cf2e3d518
[^nr:near-2026-11-09:8780ac66b951c47774e74e30dde228d002744392]: nr:near-2026-11-09:8780ac66b951c47774e74e30dde228d002744392 · near-rpc:archival-rpc.mainnet.fastnear.com · 223810484 · df5d5fda6163
[^nr:near-2026-11-09:8b60a80afbf19dfa2eb084040ffed35f29eb3688]: nr:near-2026-11-09:8b60a80afbf19dfa2eb084040ffed35f29eb3688 · near-rpc:archival-rpc.mainnet.fastnear.com · 223810540 · 74713151b10e
[^nr:near-2026-11-09:9a111386962c4178bdd94d7aaf7da03cecbe6eca]: nr:near-2026-11-09:9a111386962c4178bdd94d7aaf7da03cecbe6eca · near-rpc:archival-rpc.mainnet.fastnear.com · 223810635 · 452fc3b93311
[^nr:near-2026-11-09:a8b82476cb56d6742a050251c40e2ce142494263]: nr:near-2026-11-09:a8b82476cb56d6742a050251c40e2ce142494263 · near-rpc:archival-rpc.mainnet.fastnear.com · 223810480 · 7d3dd2c57581
[^nr:near-2026-11-09:b1d681db66847fd9cec3d2530588cfee7b87ff46]: nr:near-2026-11-09:b1d681db66847fd9cec3d2530588cfee7b87ff46 · near-rpc:archival-rpc.mainnet.fastnear.com · 223810606 · d2dadfecdf3e
[^nr:near-2026-11-09:b2acb4740cbc14c6d4ddc0d8536548f928810102]: nr:near-2026-11-09:b2acb4740cbc14c6d4ddc0d8536548f928810102 · near-rpc:archival-rpc.mainnet.fastnear.com · 223810579 · c2033b1ede53
[^nr:near-2026-11-09:b4f58005794b63e8196edb652d55168d78b1a889]: nr:near-2026-11-09:b4f58005794b63e8196edb652d55168d78b1a889 · near-rpc:archival-rpc.mainnet.fastnear.com · 223810660 · fdf441c1950e
[^nr:near-2026-11-09:c213a4a6ca2c8b818fc955f131d38dc84d0a0f54]: nr:near-2026-11-09:c213a4a6ca2c8b818fc955f131d38dc84d0a0f54 · near-rpc:archival-rpc.mainnet.fastnear.com · 223810706 · 51a9d0be5656
[^nr:near-2026-11-09:c5d106d093a012e8b2a1e4aef2e35f2c7901614d]: nr:near-2026-11-09:c5d106d093a012e8b2a1e4aef2e35f2c7901614d · near-rpc:archival-rpc.mainnet.fastnear.com · 223810512 · c0e3830f6897
[^nr:near-2026-11-09:c94883a42c4aef4e2a7c4b52048a3d2e7275b2c7]: nr:near-2026-11-09:c94883a42c4aef4e2a7c4b52048a3d2e7275b2c7 · near-rpc:archival-rpc.mainnet.fastnear.com · 223810526 · 465e7692bbb8
[^nr:near-2026-11-09:cb40d7ec300af5144bca2b1f908be5447c814b08]: nr:near-2026-11-09:cb40d7ec300af5144bca2b1f908be5447c814b08 · near-rpc:archival-rpc.mainnet.fastnear.com · 223810592 · 47801092ab2b
[^nr:near-2026-11-09:db5c2d6badb44133490cf92d80e6586666591534]: nr:near-2026-11-09:db5c2d6badb44133490cf92d80e6586666591534 · near-rpc:archival-rpc.mainnet.fastnear.com · 223810551 · 19260f345709
[^nr:near-2026-11-09:dc4f2aa936b73abe716823521f73a81d53a10ebb]: nr:near-2026-11-09:dc4f2aa936b73abe716823521f73a81d53a10ebb · near-rpc:archival-rpc.mainnet.fastnear.com · 223810664 · 0e2b5764bf79
[^nr:near-2026-11-09:e98efbbcc434016c7b400cbdfedfbfa7dc0bcd0f]: nr:near-2026-11-09:e98efbbcc434016c7b400cbdfedfbfa7dc0bcd0f · near-rpc:archival-rpc.mainnet.fastnear.com · 223810536 · 67038340bb7c
[^nr:near-2026-11-09:f2a91025dfac21d06fbd11ac5d39f1b76720c1b0]: nr:near-2026-11-09:f2a91025dfac21d06fbd11ac5d39f1b76720c1b0 · near-rpc:archival-rpc.mainnet.fastnear.com · 223810547 · ce4795907725
[^nr:near-2026-11-09:f4b9cf3abe314ba42979fb2364e4a40cfb767eae]: nr:near-2026-11-09:f4b9cf3abe314ba42979fb2364e4a40cfb767eae · near-rpc:archival-rpc.mainnet.fastnear.com · 223810602 · 440522911d2f
[^nr:near-2026-11-09:fe51c763553bb1227820659912e7e4a312c51095]: nr:near-2026-11-09:fe51c763553bb1227820659912e7e4a312c51095 · near-rpc:archival-rpc.mainnet.fastnear.com · 223810632 · 8c76e3df5042
[^nr:near-2026-11-09.intents:538f5f672b21b47fa698a323c51ad620465c6a68]: nr:near-2026-11-09.intents:538f5f672b21b47fa698a323c51ad620465c6a68 · near-rpc:archival-rpc.mainnet.fastnear.com · 223823978 · 254b99f2caca
[^rep:2a4009978a14d78452602542098379f7a5213f59]: rep:2a4009978a14d78452602542098379f7a5213f59 · report:near-intents-research-2026-10-22 · — · 2a4009978a14
[^route:02d11af264ff0cf0a67511f8ad2b683e036c0612]: route:02d11af264ff0cf0a67511f8ad2b683e036c0612 · near-rpc:archival-rpc.mainnet.fastnear.com · 223824227 · cf5967c6876d
[^route:11f1e5549db27564cbf39a5ff57dd9a527375082]: route:11f1e5549db27564cbf39a5ff57dd9a527375082 · near-rpc:archival-rpc.mainnet.fastnear.com · — · 61237278c935
[^route:2000c8418fe58249794faed69e2b1a24b1d77e8b]: route:2000c8418fe58249794faed69e2b1a24b1d77e8b · near-rpc:archival-rpc.mainnet.fastnear.com · 223824231 · 74d72810225c
[^route:3369c9dfc861e903a9f0a0f3fc088b2597499ea0]: route:3369c9dfc861e903a9f0a0f3fc088b2597499ea0 · near-rpc:archival-rpc.mainnet.fastnear.com · — · 61237278c935
[^route:3a2b8d6ed8cde5cfd9016fccf444ed0ad95cb6f8]: route:3a2b8d6ed8cde5cfd9016fccf444ed0ad95cb6f8 · near-rpc:archival-rpc.mainnet.fastnear.com · 223824233 · b885d71a4682
[^route:5c6bff21cd9199faf9d844665805e62cbd47afe3]: route:5c6bff21cd9199faf9d844665805e62cbd47afe3 · near-rpc:archival-rpc.mainnet.fastnear.com · — · 61237278c935
[^route:6bd131d0c15a206d7644219b502ccc6c185e4599]: route:6bd131d0c15a206d7644219b502ccc6c185e4599 · near-rpc:archival-rpc.mainnet.fastnear.com · — · 61237278c935
[^route:75b6b4c091d2ef8005c4264423d5f79b5ae00809]: route:75b6b4c091d2ef8005c4264423d5f79b5ae00809 · near-rpc:archival-rpc.mainnet.fastnear.com · 223824229 · 594b70dcd3b6
[^route:7ec56fbc599977ed2c53a0aae035fc73fd7bb12f]: route:7ec56fbc599977ed2c53a0aae035fc73fd7bb12f · near-rpc:rpc.mainnet.fastnear.com · 223823983 · b4b0f0c31668
[^route:8a93b7a76b2732d76dc14f81ee0db94fdc4b7af7]: route:8a93b7a76b2732d76dc14f81ee0db94fdc4b7af7 · near-rpc:archival-rpc.mainnet.fastnear.com · — · 61237278c935
[^route:b2190736c42efc0af2f61520832a6249f03ec2a1]: route:b2190736c42efc0af2f61520832a6249f03ec2a1 · near-rpc:rpc.mainnet.fastnear.com · 223823984 · 778bcbdaed75
[^route:f66ff37f2d8de8e689bc7ef98478939d6cb556c1]: route:f66ff37f2d8de8e689bc7ef98478939d6cb556c1 · near-rpc:archival-rpc.mainnet.fastnear.com · 223824235 · f332bb5c47aa
