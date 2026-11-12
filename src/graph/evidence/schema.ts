import { EVIDENCE_TEMPLATES } from './templates';
import { VOCABULARY } from '../../engine/queries/vocabulary';

export const SCHEMA_VERSION = 1 as const;
export const KIND_LABELS = ['Program','Token','TokenAccount','Vault','Reserve','Market','Pool','Oracle','Multisig','Governance','Timelock','Treasury','Role','Parameter','Proposal','Key','HolderGroup','ProgramData'] as const;
export const INFRA_LABELS = ['Entity','Fact','Receipt','Snapshot','Protocol','Coverage'] as const;
export type InfraLabel = typeof INFRA_LABELS[number];
export const EVIDENCE_TYPES = ['ABOUT','OBJECT','EVIDENCED_BY','HAS_FACT','PART_OF','COVERS','HAS_COVERAGE'] as const;
export const MECHANICS = ['control','code-upgrade','supply','dependencies','parameters','fees','treasury','governance','holders','flows','claims'] as const;
export type Mechanic = typeof MECHANICS[number];
export interface Mapping { predicate: string; role?: string; reversed: false }
export interface CoreType { class: string; direction: string; endpoints: { from: string[]; to: string[] }; mappedFrom: Mapping[] }
const definitions: Record<string, string[]> = {
  UPGRADE_AUTHORITY: ['UPGRADE_AUTHORITY','upgraded-by'], MINT_AUTHORITY: ['MINT_AUTHORITY'], FREEZE_AUTHORITY: ['FREEZE_AUTHORITY'], PAUSE_AUTHORITY: ['pause-operator','EMERGENCY_AUTHORITY'],
  ADMIN: ['VAULT_ADMIN:vault-admin','ALLOCATION_ADMIN:allocation-admin','MARKET_OWNER:market-owner','CONFIG_AUTHORITY:config-authority','super-admin-of:super-admin','token-depositer:token-depositer','RESERVE_PROPOSER:reserve-proposer','GLOBAL_ADMIN:global-admin'],
  OWNED_BY: ['owned-by'], CONTROLLED_BY: ['CONTROLLED_BY'], HAS_MEMBER: ['MULTISIG_MEMBER','council-member','mpc-participant:mpc-participant','holds-role'], HAS_ROLE: [],
  HAS_KEY: ['has-full-access-key:full-access','has-function-call-key:function-call'],
  OWNER_PROGRAM: ['OWNER_PROGRAM'], PROGRAM_DATA: ['PROGRAM_DATA'], ISSUED_BY_PROGRAM: ['ISSUED_BY_PROGRAM'], ASSET: ['ASSET_MINT'], ALLOCATES_TO: ['ALLOCATES_TO'], IN_MARKET: ['IN_MARKET'], PRICED_BY: ['PRICED_BY','priced-by','legacy-oracle:legacy'], ROUTES_THROUGH: ['routes-through'], DEPLOYED_BY: ['deployed-by'], FUNDED_BY: ['FUNDED_BY'], DEPENDS_ON: ['DEPENDS_ON'], BACKED_BY: ['BACKED_BY'], ORIGINATES_FROM: ['ORIGINATES_FROM'],
};
export const CORE_TYPES: Record<string, CoreType> = Object.fromEntries(Object.entries(definitions).map(([type, sources]) => {
  const mappedFrom = sources.map(source => { const [predicate, role] = source.split(':'); return { predicate: predicate!, ...(role ? {role} : {}), reversed: false as const }; });
  const kind = type === 'HAS_ROLE' ? 'control' : VOCABULARY[mappedFrom[0]!.predicate as keyof typeof VOCABULARY].class;
  return [type, {class: kind, direction: 'From the subject entity to its object entity; control points from the controlled entity to its controller.', endpoints: {from: ['Entity'], to: ['Entity']}, mappedFrom}];
}));
const AAVE_NOT_PROJECTED = ["supply-token", "debt-token", "interest-rate-strategy", "ltv", "liquidation-threshold", "liquidation-bonus", "reserve-factor", "supply-cap", "borrow-cap", "reserve-active", "reserve-frozen", "borrowing-enabled", "flash-loan-enabled", "holds-component", "oracle-fallback"];
export const NOT_PROJECTED_REASONS = Object.fromEntries([...AAVE_NOT_PROJECTED.map(predicate => [predicate, 'Aave reader predicate; its projection waits for a vocabulary review'] as const), ...['touches-control-of','touches-code-of','changes-parameter-of'].map(predicate => [predicate, 'proposed effect, not current control; its class is a later vocabulary decision'] as const),
  ...['account-kind','proxy-implementation','proxy-admin','proxy-beacon','proxy-scheme','pending-owner','role-admin','role-members-unknown','safe-owner','safe-threshold','timelock-delay','deprecated','upgraded-address','freeze-operator','minter-admin'].map(predicate => [predicate, 'EVM reader (run 031) predicate; its projection is Peter\'s pending vocabulary decision (run 038 vocabulary review, Q12), so it is not projected yet'] as const)]);
export const NOT_PROJECTED = [...AAVE_NOT_PROJECTED,'touches-control-of','touches-code-of','changes-parameter-of','SUPPLY_RAW','MULTISIG_THRESHOLD','IDLE_RAW','AVAILABLE_LIQUIDITY_RAW','BORROWED_RAW','DECIMALS','has-code-hash','proposal','ft-metadata','deployed-version','claimed-document','vote-threshold','paused','mpc-allowed-image','proposal-period','bond','contract-mode','mpc-threshold','fee-collector','moves-funds-from','moves-funds-to',
  // EVM reader (run 031), merged before run 038: not projected until Peter decides the vocabulary.
  'account-kind','proxy-implementation','proxy-admin','proxy-beacon','proxy-scheme','pending-owner','role-admin','role-members-unknown','safe-owner','safe-threshold','timelock-delay','deprecated','upgraded-address','freeze-operator','minter-admin'];
export const PREDICATE_MECHANIC: Record<string, Mechanic> = {};
for (const [mechanic, predicates] of Object.entries({
  'code-upgrade': ['UPGRADE_AUTHORITY','upgraded-by','PROGRAM_DATA','has-code-hash','deployed-version'],
  supply: ['MINT_AUTHORITY','SUPPLY_RAW','DECIMALS','ft-metadata'],
  governance: ['vote-threshold','proposal','proposal-period','bond','touches-control-of','touches-code-of','changes-parameter-of'],
  fees: ['fee-collector'], flows: ['moves-funds-from','moves-funds-to'], claims: ['claimed-document'],
  control: ['MULTISIG_THRESHOLD','paused','contract-mode','mpc-allowed-image','mpc-threshold'],
})) for (const predicate of predicates) PREDICATE_MECHANIC[predicate] = mechanic as Mechanic;
for (const [predicate, entry] of Object.entries(VOCABULARY)) {
  if (PREDICATE_MECHANIC[predicate]) continue;
  if (entry.class === 'control') PREDICATE_MECHANIC[predicate] = 'control';
  else if (['dependency','backing','origin'].includes(entry.class)) PREDICATE_MECHANIC[predicate] = 'dependencies';
}
export const ROW_KINDS = ['fact','path','unknown','scope','coverage','receipt'] as const;
export const IDENTITY_GRAMMAR = {
  solana: '^solana:(mainnet-beta|devnet|testnet):[1-9A-HJ-NP-Za-km-z]{32,44}(#.+)?$',
  near: '^near:(mainnet|testnet):[^:#]+(#.+)?$',
  derivedSuffix: '#(role|role-admin|proposal|deployment|param):.+$',
};
export class SchemaRejected extends Error {
  constructor(detail: string) { super(`Schema rejected: ${detail}`); this.name = 'SchemaRejected'; }
}
export function checkVocabulary(vocabulary: Record<string, {class: string}> = VOCABULARY): void {
  const mapped = Object.values(CORE_TYPES).flatMap(type => type.mappedFrom);
  for (const mapping of mapped) if (mapping.reversed !== false) throw new SchemaRejected(`${mapping.predicate}: reversed mapping`);
  const all = [...mapped.map(m => m.predicate), ...NOT_PROJECTED];
  for (const predicate of new Set([...Object.keys(vocabulary), ...all])) {
    if (!Object.hasOwn(vocabulary, predicate) || all.filter(p => p === predicate).length !== 1) throw new SchemaRejected(`${predicate}: must occur exactly once`);
    if (vocabulary[predicate]?.class === 'state' && !NOT_PROJECTED.includes(predicate)) throw new SchemaRejected(`${predicate}: state must not project`);
  }
}

export const RELATIONSHIP_CONTRACTS = Object.fromEntries([
 ...Object.entries(CORE_TYPES).map(([type, contract])=>[type,{...contract,required:{key:'string',class:'string',predicate:'string',factIds:'string[]',factUids:'string[]',snapshotIds:'string[]',bases:'string[]',statuses:'string[]',conflict:'boolean',firstObservedAt:'datetime',lastObservedAt:'datetime',latest:'boolean'},optional:{role:'string'}}]),
 ...Object.entries({ABOUT:['Fact','Entity'],OBJECT:['Fact','Entity'],EVIDENCED_BY:['Fact','Receipt'],HAS_FACT:['Snapshot','Fact'],PART_OF:['Entity','Protocol'],COVERS:['Snapshot','Entity'],HAS_COVERAGE:['Protocol','Coverage']}).map(([type,[from,to]])=>[type,{class:'evidence',direction:`From ${from} to ${to}.`,endpoints:{from:[from],to:[to]},mappedFrom:[],required:{key:'string',...(type==='PART_OF'?{source:'string',scope:'string'}:type==='COVERS'?{readers:'string[]',readerStatuses:'string[]',status:'string'}:{})},optional:{}}])
]) as Record<string,{endpoints:{from:string[];to:string[]};required:Record<string,string>;optional:Record<string,string>}>;

export function generateSchema(vocabulary = VOCABULARY) {
  checkVocabulary(vocabulary);
  const properties: Record<string, Record<string,string>> = {
    Entity:{id:'string',chain:'string',network:'string',address:'string',schemaVersion:'integer',kinds:'string[]',kindBasis:'string',kindFactIds:'string[]',kindEvidenceIds:'string[]'},
    Fact:{uid:'string',id:'string',snapshotId:'string',subjectId:'string',predicate:'string',class:'string',cardinality:'string',field:'string',key:'string',basis:'string',status:'string',privacy:'string',evidenceIds:'string[]',path:'string[]',validFrom:'datetime|null',validTo:'datetime|null',blockOrSlot:'int64-string|null',asOf:'datetime'},
    Receipt:{id:'string',source:'string',responseSha256:'string',privacy:'string',chain:'string',network:'string',blockOrSlot:'int64-string|null',blockHash:'string|null',observedAt:'datetime',retrievedAt:'datetime',historicalState:'string'},
    Snapshot:{id:'string',chain:'string',network:'string',constructed:'boolean',observedFrom:'datetime',observedTo:'datetime',fromBlockOrSlot:'int64-string|null',toBlockOrSlot:'int64-string|null',freshUntil:'datetime',series:'string'},
    Protocol:{id:'string',title:'string',series:'string',source:'string'},Coverage:{id:'string',protocolId:'string',series:'string',mechanic:'string',status:'string',note:'string'},
  };
  return {schemaVersion:SCHEMA_VERSION,templates:EVIDENCE_TEMPLATES,labels:Object.fromEntries([...INFRA_LABELS,...KIND_LABELS].map(label=>[label,{meaning:KIND_LABELS.includes(label as typeof KIND_LABELS[number])?`An entity classified as ${label} by recorded evidence.`:`A recorded ${label.toLowerCase()} in the evidence graph.`,required:properties[label]??{},optional:label==='Entity'?{parentId:'string',name:'string',nameSource:'string',subkind:'string'}:label==='Fact'?{objectId:'string',objectValue:'string',coreType:'string'}:{}}])),relationships:RELATIONSHIP_CONTRACTS,coreTypes:CORE_TYPES,evidenceTypes:EVIDENCE_TYPES,notProjected:NOT_PROJECTED,notProjectedReasons:NOT_PROJECTED_REASONS,mechanics:MECHANICS,predicateMechanic:PREDICATE_MECHANIC,rowKinds:ROW_KINDS,identityGrammar:IDENTITY_GRAMMAR,shapeRules:{holdsRole:'A holds-role object that is the subject’s own #role: or #role-admin: identity projects as HAS_ROLE; otherwise HAS_MEMBER.'}};
}
