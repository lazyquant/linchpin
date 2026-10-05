# Linchpin: three-minute demo

Before the timer, run from the repository root with dependencies already installed:

```sh
LINCHPIN_RPC_URL=http://127.0.0.1:1 bun run demo
open out/mip-14/packet.html out/mip-14-opinion/packet.html
```

Keep both packets ready. The header should say **offline replay**. Here, “today's state” means the state captured in the committed fixtures, not a fresh read during the presentation.

## 0:00–0:20 — Problem

“Governance proposals move treasuries and change token supply. Intent, payload, simulation and execution are often judged separately, or not at all. Linchpin is the dependency engine for protocol economics and tokenomics. Its first application brings those four views into one review packet while keeping their evidence distinct.”

## 0:20–0:50 — Claim and decoded payload

Show `out/mip-14/packet.html`, pointing from **Claimed** to **Decoded**.

“MIP-14 claims a 30% MNDE burn. The actual payload decodes to a burn of 300 million MNDE from the governance's own treasury account. That is 30% only under the forum's claimed one-billion-token pre-burn supply. We have not captured on-chain pre-burn supply, so the packet says covered with assumptions. The other forum figures remain claims.”

## 0:50–1:20 — Control path

Point to **Control path** and follow its four entries.

“Who can pull this lever? Start at the treasury token account, follow its owner to the native treasury PDA, then governance, then Marinade DAO. That treasury PDA is the burn authority. The path connects the account being depleted to the governance that controls it. The checks below separate treasury movement, supply change and control change.”

## 1:20–1:50 — Conditional previews

Show **Simulated** and expand the historical preview's assumptions and logs.

“The historical payload fails against the captured current state: insufficient funds. The source balance is now below the 300 million burn. We show that failure. The separately labelled fixture burns just one MNDE and succeeds. Signature verification is disabled and the blockhash is replaced. These are conditional previews; success does not prove authorization or safety.”

## 1:50–2:20 — Observed execution

Show **Observed**, its balance change and reconciliation notes.

“The historical receipt answers a different question: what actually happened? The source account fell by exactly 300 million MNDE, matching the decoded effect. The receipt is from 5 September 2025. The unrelated assertion-guard program is kept visible in the notes as another program in the same transaction. A failed preview against later state does not erase this observed execution.”

## 2:20–2:40 — Signaling control

Switch to `out/mip-14-opinion/packet.html`.

“This is the MIP-14 opinion vote. Its five options have no instructions. Linchpin says ‘no executable payload: signaling only.’ Execution eligibility is not applicable, and there is no simulation. A governance vote can express intent without carrying an executable action.”

## 2:40–3:00 — Next steps

“Next is the MIP-21 treasury exchange, then a dependency map to mSOL and protocol fees, and a pilot with one DAO. The direction is to make economic dependencies reviewable while keeping claims, decoded mechanisms, conditional previews and observed outcomes distinct.”

## Rehearsal

Rehearse offline twice with the two generated packets. The third run is the recording for Colosseum later. Keep the flow to three minutes; the planned final dry-run window is for fixing what breaks the script, with no new features.
