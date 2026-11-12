import { VOCABULARY } from "../../engine/queries/vocabulary";
import { CORE_TYPES, KIND_LABELS } from "../evidence/schema";

/**
 * The term registry: one entry for every predicate, every core relationship type and every kind.
 * A model drafted the definitions; a person marks an entry `reviewed`. Nothing here changes a term.
 * Fourteen names are both a predicate and a core type, so an entry is keyed by its type and its name.
 */
export type TermType = "predicate" | "coreType" | "kind";
export type TermStatus = "draft" | "reviewed";
export type Asserts = "current-state" | "proposed-effect" | "designed-route";
export type EstablishedBy = "decoded-type" | "own-state" | "identity-grammar" | "relation-to-other";
export interface TermBase { type: TermType; name: string; definition: string; status: TermStatus }
export interface PredicateTerm extends TermBase { type: "predicate"; asserts: Asserts }
export interface CoreTypeTerm extends TermBase { type: "coreType" }
export interface KindTerm extends TermBase { type: "kind"; establishedBy: EstablishedBy }
export type Term = PredicateTerm | CoreTypeTerm | KindTerm;
export interface TermRef { type: TermType; name: string }
export interface RegistrySources { vocabulary: Record<string, unknown>; coreTypes: Record<string, unknown>; kinds: readonly string[] }

const PROPOSED_EFFECT = new Set(["touches-control-of", "touches-code-of", "changes-parameter-of", "moves-funds-from", "moves-funds-to"]);
const DESIGNED_ROUTE = new Set(["routes-through"]);

const PREDICATE_DEFINITIONS: Record<string, string> = {
  UPGRADE_AUTHORITY: "The account that can replace the executable code of a program, so whoever holds it can change what the program does.",
  MINT_AUTHORITY: "The account that can create new units of a token, or none when minting has been closed for good.",
  FREEZE_AUTHORITY: "The account that can freeze a holder's balance of a token, or none when freezing is disabled.",
  CONFIG_AUTHORITY: "The account that can change the configuration of a multisig, or none when the configuration cannot be changed.",
  PROGRAM_DATA: "The account that holds the executable bytes of an upgradeable program and that the program account points to.",
  ISSUED_BY_PROGRAM: "The program that issued a token or a token account and whose rules govern how it behaves.",
  DEPENDS_ON: "An entity the subject relies on to work, recorded when no more specific dependency relation applies.",
  BACKED_BY: "An asset or position that stands behind the value of the subject, such as collateral behind a loan.",
  ORIGINATES_FROM: "The source the subject was created from, such as the original asset of a bridged token.",
  SUPPLY_RAW: "The total supply of a token as a raw integer in its smallest unit at the time of observation.",
  ALLOCATES_TO: "A reserve or strategy to which a vault sends part of its funds.",
  IN_MARKET: "The lending market that a reserve belongs to.",
  PRICED_BY: "The price source, such as an oracle feed, that the subject's valuation reads from.",
  OWNER_PROGRAM: "The program that owns an account on chain and is therefore the only program able to change its data.",
  VAULT_ADMIN: "The account that administers a vault and can change its settings.",
  ALLOCATION_ADMIN: "The account that decides how a vault spreads its funds across reserves.",
  MARKET_OWNER: "The account that owns a lending market and can change its settings.",
  CONTROLLED_BY: "The entity that controls the subject, or unknown when the controller could not be identified.",
  MULTISIG_MEMBER: "An account that is one of the signers of a multisig and may approve its transactions.",
  MULTISIG_THRESHOLD: "The number of multisig members that must sign before a transaction takes effect.",
  IDLE_RAW: "The amount of a vault's funds that is not allocated to any reserve, as a raw integer in the smallest unit.",
  AVAILABLE_LIQUIDITY_RAW: "The amount of a reserve that can be withdrawn or borrowed at the time of observation, as a raw integer.",
  BORROWED_RAW: "The amount of a reserve that is lent out to borrowers at the time of observation, as a raw integer.",
  "owned-by": "The account that owns a contract and can call its owner-only methods.",
  "upgraded-by": "An account that can deploy new code to a contract and so change what the contract does.",
  "super-admin-of": "An account with the super-admin right over an access-controlled contract, which includes granting every role.",
  "holds-role": "An account that holds a named role of a contract's access control, or none when nobody holds it.",
  "priced-by": "The oracle account whose price feed the subject currently reads.",
  "legacy-oracle": "An older oracle account that the subject still lists as a price source next to the current one.",
  "routes-through": "A contract through which the subject is configured to send trades or transfers.",
  "deployed-by": "The account that created the subject account and deployed its code.",
  "has-code-hash": "The hash of the code deployed on an account at the time of observation.",
  "proposal": "A governance proposal recorded for a DAO, kept with the fields it was submitted with.",
  "ft-metadata": "The metadata a fungible token publishes about itself: its name, symbol, decimals and reference.",
  "deployed-version": "A version of a contract's code that was deployed, with the time or label at which it was seen.",
  "claimed-document": "A document that a party claims describes the subject, with its address, hash and retrieval time; claimed, not verified.",
  "has-full-access-key": "A key that holds full access to an account, or none when the account has no such key.",
  "has-function-call-key": "A key that may only call named methods of one contract on behalf of an account.",
  "council-member": "An account that sits on the council of a DAO and takes part in its votes.",
  "vote-threshold": "The share or number of votes a DAO policy requires before a proposal passes.",
  "paused": "Whether a contract, or a named part of it, is paused at the time of observation.",
  "mpc-participant": "A node that takes part in the signing set of a multi-party-computation contract.",
  "mpc-allowed-image": "A software image hash that a multi-party-computation contract allows its nodes to run, with its expiry.",
  "token-depositer": "An account that is allowed to deposit tokens through a bridge or issuer contract.",
  "proposal-period": "The length of time a DAO proposal stays open for voting.",
  "bond": "The deposit a DAO requires from whoever submits a proposal.",
  "pause-operator": "The account that is allowed to pause a contract, or none when no such account is set.",
  "contract-mode": "The operating mode a contract reports about itself, such as running or paused.",
  "mpc-threshold": "The number of participants that must cooperate before a multi-party-computation contract produces a signature.",
  "fee-collector": "The account that is entitled to collect the fees a contract earns.",
  ASSET_MINT: "The token mint that a token account holds or that a valuation refers to.",
  DECIMALS: "The number of decimal places of a token's whole unit, so one whole token equals 10 to that power of its smallest unit.",
  FUNDED_BY: "The vault or source that supplied the funds of a loan.",
  "touches-control-of": "A proposed action that would change who controls the target; it states an intended effect, not a current state.",
  "touches-code-of": "A proposed action that would change the code of the target; it states an intended effect, not a current state.",
  "changes-parameter-of": "A proposed action that would change a setting of the target; it states an intended effect, not a current state.",
  "moves-funds-from": "A proposed action that would take funds out of the target; it states an intended effect, not a current state.",
  "moves-funds-to": "A proposed action that would send funds to the target; it states an intended effect, not a current state.",
  "account-kind": "The kind of an account as read from chain, such as an externally owned account or a contract.",
  "proxy-implementation": "The address a proxy contract delegates its calls to, which holds the logic behind the proxy.",
  "proxy-admin": "The account that can change the implementation behind a proxy.",
  "proxy-beacon": "The beacon contract that a proxy asks for the address of its implementation.",
  "proxy-scheme": "The proxy pattern a contract follows, such as transparent, beacon or minimal clone.",
  "pending-owner": "The account nominated to become the owner that has not yet accepted the role.",
  "role-admin": "The role or account that may grant and revoke a given role.",
  "role-members-unknown": "A marker that the holders of a role could not be listed, so its membership is not known.",
  "safe-owner": "An account that is one of the owners of a Safe multisig wallet.",
  "safe-threshold": "The number of owners of a Safe multisig wallet whose signatures a transaction needs.",
  "timelock-delay": "The minimum delay between queuing an operation at a timelock and executing it.",
  "deprecated": "Whether the subject is marked as deprecated by its own code or by its owner.",
  "upgraded-address": "The address that replaced the subject through an upgrade or a migration.",
  "freeze-operator": "The account that can freeze balances or transfers of a token.",
  "minter-admin": "The account that can appoint or remove the minters of a token.",
  "supply-token": "The token that a lending reserve gives to those who supply its asset, as a receipt for their claim on the supplied funds.",
  "debt-token": "The token that a lending reserve uses to record how much a borrower owes of its asset.",
  "interest-rate-strategy": "The contract that computes the interest rates a lending reserve charges borrowers and pays suppliers.",
  "ltv": "The loan-to-value ratio of a lending reserve: the highest share of the value of this asset as collateral that a borrower may borrow against, as the protocol stores it.",
  "liquidation-threshold": "The share of a collateral asset's value at which a borrower's position becomes open to liquidation, as the protocol stores it.",
  "liquidation-bonus": "The extra collateral a liquidator may take as a reward for repaying part of a borrower's debt, as the protocol stores it.",
  "reserve-factor": "The share of the interest paid by the borrowers of a lending reserve that goes to the protocol instead of to the suppliers.",
  "supply-cap": "The largest total amount of its asset that a lending reserve accepts from suppliers.",
  "borrow-cap": "The largest total amount of its asset that can be borrowed from a lending reserve.",
  "reserve-active": "Whether a lending reserve is switched on and usable at the time of observation.",
  "reserve-frozen": "Whether a lending reserve is frozen at the time of observation, so that it accepts no new deposits and no new borrowing.",
  "borrowing-enabled": "Whether borrowing the asset of a lending reserve is allowed at the time of observation.",
  "flash-loan-enabled": "Whether the asset of a lending reserve can be taken in a flash loan, a loan that is borrowed and repaid within one transaction.",
  "holds-component": "A component, such as a pool, an oracle or an access-control contract, that a registry contract names as one part of a protocol's deployment.",
  "oracle-fallback": "The oracle that a price-oracle contract consults when its primary source gives no usable price.",
  EMERGENCY_AUTHORITY: "The account that may tighten the emergency settings of a lending market, or none when no such account is set.",
  RESERVE_PROPOSER: "The account that may create the reserves of a lending market and configure them while they are being set up, or none when no such account is set.",
  GLOBAL_ADMIN: "The account that sets protocol-wide fee modes across the lending markets of a protocol, or none when no such account is set.",
};

const CORE_TYPE_DEFINITIONS: Record<string, string> = {
  UPGRADE_AUTHORITY: "Relation from a program or contract to the account that can upgrade its code; a control relation.",
  MINT_AUTHORITY: "Relation from a token to the account that can mint more of it; a control relation.",
  FREEZE_AUTHORITY: "Relation from a token to the account that can freeze balances of it; a control relation.",
  PAUSE_AUTHORITY: "Relation from a contract to the account that is allowed to pause it; a control relation.",
  ADMIN: "Relation from an entity to an account that administers it in a named role; a control relation.",
  OWNED_BY: "Relation from a contract to the account that owns it; a control relation.",
  CONTROLLED_BY: "Relation from an entity to the entity that controls it, where no more specific control relation is known.",
  HAS_MEMBER: "Relation from a group, multisig or role to an account that is a member of it; a control relation.",
  HAS_ROLE: "Relation from an account to a role it holds in a contract's access control; a control relation.",
  HAS_KEY: "Relation from an account to a key that can act for it, with the kind of access the key has; a control relation.",
  OWNER_PROGRAM: "Relation from an account to the program that owns it; a dependency relation.",
  PROGRAM_DATA: "Relation from a program to the account that holds its executable bytes; a dependency relation.",
  ISSUED_BY_PROGRAM: "Relation from a token or token account to the program that issued it; a dependency relation.",
  ASSET: "Relation from a token account or valuation to the token mint it refers to; a dependency relation.",
  ALLOCATES_TO: "Relation from a vault to a reserve or strategy that receives part of its funds; a dependency relation.",
  IN_MARKET: "Relation from a reserve to the market it belongs to; a dependency relation.",
  PRICED_BY: "Relation from an entity to the price source its valuation reads from; a dependency relation.",
  ROUTES_THROUGH: "Relation from a contract to another contract through which it is configured to route trades or transfers, a designed route and not an observed execution; a dependency relation.",
  DEPLOYED_BY: "Relation from a contract account to the account that deployed it; a dependency relation.",
  FUNDED_BY: "Relation from a loan to the vault or source that supplied its funds; a dependency relation.",
  DEPENDS_ON: "Relation from an entity to another entity it relies on, where no more specific dependency relation is known.",
  BACKED_BY: "Relation from an asset or loan to the asset or position that backs its value; a backing relation.",
  ORIGINATES_FROM: "Relation from an asset to the source it originates from; an origin relation.",
};

const KIND_DEFINITIONS: Record<string, [EstablishedBy, string]> = {
  Program: ["own-state", "An executable account that holds code which other accounts can call."],
  Token: ["decoded-type", "A fungible asset whose supply, mint and freeze rights are recorded in a token mint account."],
  TokenAccount: ["decoded-type", "An account that holds a balance of one token for an owner."],
  Vault: ["decoded-type", "An account that pools deposits and allocates them to reserves or strategies."],
  Reserve: ["decoded-type", "An account that holds one asset of a lending market and records how much is supplied and borrowed."],
  Market: ["decoded-type", "A lending market account that groups reserves under one owner and one set of rules."],
  Pool: ["decoded-type", "An account that holds paired assets for trading or lending against each other."],
  Oracle: ["decoded-type", "An account or contract that publishes a price for other contracts to read."],
  Multisig: ["decoded-type", "An account that needs several member signatures before a transaction takes effect."],
  Governance: ["own-state", "A contract that records proposals and votes and applies the outcome."],
  Timelock: ["decoded-type", "A contract that holds a queued operation for a minimum delay before it can run."],
  Treasury: ["relation-to-other", "An account that holds funds on behalf of a protocol or DAO; it is a treasury because of how another entity uses it."],
  Role: ["identity-grammar", "A named permission of a contract's access control, identified by the contract and the role name."],
  Parameter: ["identity-grammar", "A named setting of a contract, identified by the contract and the setting name."],
  Proposal: ["identity-grammar", "A governance proposal, identified by the DAO and the proposal number."],
  Key: ["identity-grammar", "A key that can act for an account, identified by the account and the key."],
  HolderGroup: ["identity-grammar", "A named group of token holders, identified by the token and the group name."],
  ProgramData: ["decoded-type", "The account that holds the executable bytes of an upgradeable program."],
};

const byTypeThenName = (a: TermRef, b: TermRef): number =>
  a.type < b.type ? -1 : a.type > b.type ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

function buildTerms(): Term[] {
  const terms: Term[] = [];
  for (const name of Object.keys(VOCABULARY)) {
    terms.push({
      type: "predicate", name, status: "draft", definition: PREDICATE_DEFINITIONS[name] ?? "",
      asserts: PROPOSED_EFFECT.has(name) ? "proposed-effect" : DESIGNED_ROUTE.has(name) ? "designed-route" : "current-state",
    });
  }
  for (const name of Object.keys(CORE_TYPES)) terms.push({ type: "coreType", name, status: "draft", definition: CORE_TYPE_DEFINITIONS[name] ?? "" });
  for (const name of KIND_LABELS) {
    const [establishedBy, definition] = KIND_DEFINITIONS[name] ?? ["decoded-type" as EstablishedBy, ""];
    terms.push({ type: "kind", name, status: "draft", definition, establishedBy });
  }
  return terms.sort(byTypeThenName);
}

/** 132 entries at the current base, sorted by type and name in byte order. */
export const TERMS: readonly Term[] = Object.freeze(buildTerms());

export function defaultSources(): RegistrySources {
  return { vocabulary: VOCABULARY, coreTypes: CORE_TYPES, kinds: KIND_LABELS };
}

/** Which terms the sources have and the registry lacks, which it has and the sources lack, and which it holds twice. */
export function registryProblems(terms: readonly Term[], sources: RegistrySources = defaultSources()):
  { missing: TermRef[]; extra: TermRef[]; duplicate: TermRef[] } {
  const expected = new Map<string, TermRef>();
  const add = (type: TermType, name: string) => expected.set(`${type}\0${name}`, { type, name });
  for (const name of Object.keys(sources.vocabulary)) add("predicate", name);
  for (const name of Object.keys(sources.coreTypes)) add("coreType", name);
  for (const name of sources.kinds) add("kind", name);
  const seen = new Map<string, number>();
  for (const term of terms) seen.set(`${term.type}\0${term.name}`, (seen.get(`${term.type}\0${term.name}`) ?? 0) + 1);
  const missing = [...expected].filter(([key]) => !seen.has(key)).map(([, ref]) => ref);
  const extra = [...seen.keys()].filter(key => !expected.has(key)).map(key => { const [type, name] = key.split("\0"); return { type: type as TermType, name: name! }; });
  const duplicate = [...seen].filter(([, count]) => count > 1).map(([key]) => { const [type, name] = key.split("\0"); return { type: type as TermType, name: name! }; });
  return { missing: missing.sort(byTypeThenName), extra: extra.sort(byTypeThenName), duplicate: duplicate.sort(byTypeThenName) };
}
