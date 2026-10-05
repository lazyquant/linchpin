import { expect, test } from "bun:test";
import { voteOutcome } from "../src/review/checks";
import type { Effect } from "../src/governance/effects";
import { offlineMip14 } from "./helpers";

const movement: Effect = { id: "fx-3-0-move", type: "treasuryMovement", basis: "decoded", detail: {}, flags: [], evidenceIds: [] };
async function bonkVote() {
  // In-memory vote inputs only; never reads BonkDAO RPC fixtures.
  const { bundle } = await offlineMip14();
  const mint = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
  bundle.mints[mint] = { ...bundle.mints[bundle.proposal.governingTokenMint], decimals: 5 };
  Object.assign(bundle.proposal, {
    governingTokenMint: mint, maxVoteWeightRaw: "8799471339760304184", denyVoteWeightRaw: "71084828877388",
    voteThreshold: { type: 0, value: 1 }, executionDelaySeconds: 1783326377 - 1783326339,
    options: [{ label: "Approve", voteWeightRaw: "88238338728379189", voteResult: 1, instructionsCount: 4, instructionsExecutedCount: 4 }],
  });
  bundle.transactions[0].holdUpTime = 0;
  return bundle;
}

test("BONK vote clears 1% by 0.0028 pp and flags no hold-up", async () => {
  const b = await bonkVote();
  const row = voteOutcome(b, [movement]);
  expect(row.result).toContain("approve share 1.0028%; threshold 1 %; margin 0.0028 pp");
  const margin = row.result.match(/margin [^()]+\(([\d,.]+) DezXAZ…/)![1];
  expect(Math.abs(Number(margin.replaceAll(",", "")) / 2438674316.63 - 1)).toBeLessThan(0.01);
  expect(margin).toBe("2,436,253,307.76147");
  expect(row.flags).toEqual(["thin-margin", "no-hold-up"]);
  expect(row.needsReview).toBe(true);
  expect(row.result).toContain("deny 710,848,288.77388 DezXAZ…");
  expect(row.result).toContain("execution delay 38 s; hold-up 0 s");
  expect(row.result).toEndWith("voter count and concentration not analysed (vote records not read)");
});

test("vote checks handle unsupported thresholds and missing mint data without guessing units", async () => {
  const b = await bonkVote();
  b.proposal.voteThreshold = { type: 1, value: null };
  b.mints = {};
  let row = voteOutcome(b, []);
  expect(row.result).toContain("threshold type not supported");
  expect(row.result).toContain("88238338728379189");
  expect(row.result).toContain("8799471339760304184 raw");
  expect(row.flags).toEqual([]);
  b.proposal.voteThreshold = { type: 0, value: 1 };
  row = voteOutcome(b, []);
  expect(row.result).toContain("243625330776147 raw");
  expect(row.flags).toEqual(["thin-margin"]);
  b.proposal.maxVoteWeightRaw = "0";
  expect(voteOutcome(b, []).result).toContain("vote outcome unavailable");
});

test("thin margin boundary is strictly below half a percentage point", async () => {
  const b = await bonkVote();
  b.proposal.maxVoteWeightRaw = "10000";
  b.proposal.options[0].voteWeightRaw = "150";
  b.transactions[0].holdUpTime = 1;
  expect(voteOutcome(b, [movement])).toMatchObject({ flags: [], needsReview: false });
  b.proposal.options[0].voteWeightRaw = "149";
  expect(voteOutcome(b, []).flags).toEqual(["thin-margin"]);
});

test("execution window uses earliest and latest executed transactions and omits unknown times", async () => {
  const b = await bonkVote();
  b.proposal.votingCompletedAt = 100;
  b.transactions = [49, null, 38].map((offset) => ({ ...b.transactions[0], executedAt: offset == null ? null : 100 + offset }));
  expect(voteOutcome(b, []).result).toContain("execution began 38 s after voting completed, last transaction at 49 s");
  b.transactions.forEach((t) => { t.executedAt = null; });
  expect(voteOutcome(b, []).result).not.toContain("execution began");
  b.transactions[0].executedAt = 138;
  b.proposal.votingCompletedAt = null;
  expect(voteOutcome(b, []).result).not.toContain("execution began");
});
