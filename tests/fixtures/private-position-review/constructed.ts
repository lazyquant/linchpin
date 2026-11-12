import type { EvidenceSnapshot } from "../../../src/engine/queries/index";
import { canonical, sha256 } from "../../../src/chain/evidence";

export const CONSTRUCTED_ID = "constructed.kamino.vault-admin-changed";
export const VAULT_ADMIN_SUBJECT = "solana:mainnet-beta:A2wsxhA7pF4B2UKVfXocb6TAAP9ipfPJam6oMKgDE5BK";
export const OLD_ADMIN = "solana:mainnet-beta:7fLxEftpppneavpueYgP2s7HhSGbWpj2jTCmAEwwqonY";
export const NEW_ADMIN = "solana:mainnet-beta:24LjDBukaUSHgPowcF2wY1XscnhChcBUDETN2UhBZMMT";

/**
 * A constructed snapshot derived from a recorded one: exactly one control object changes
 * (the vault admin). Receipt ids are re-derived from a constructed preimage, fact ids are
 * recomputed over the fact without its id, every receipt is labelled constructed and every
 * fact gets a validFrom, so no identifier is shared with the recorded captures. Times and
 * slots stay those of the base snapshot: this is a hypothetical, not a historical claim.
 */
export function constructedVaultAdminChange(base: EvidenceSnapshot): EvidenceSnapshot {
  const reidentified = new Map(base.receipts.map((r) => [r.id, sha256(canonical({ constructed: "vault-admin-changed", from: r.id }))]));
  const receipts = base.receipts.map((r) => ({
    ...structuredClone(r),
    id: reidentified.get(r.id)!,
    observation: { ...structuredClone(r.observation), historicalState: "constructed" as const },
  }));
  const facts = base.facts.map((single) => {
    const { id: _oldId, ...rest } = structuredClone(single);
    const next = {
      ...rest,
      object: single.subject === VAULT_ADMIN_SUBJECT && single.predicate === "VAULT_ADMIN" ? NEW_ADMIN : rest.object,
      evidenceIds: rest.evidenceIds.map((id) => reidentified.get(id)!),
      validFrom: base.observedFrom,
    };
    return { ...next, id: sha256(canonical(next)) };
  });
  return {
    ...structuredClone(base),
    id: CONSTRUCTED_ID,
    constructed: true,
    receipts,
    facts,
  };
}
