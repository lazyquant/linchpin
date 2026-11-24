/**
 * The bundle backend: retrieval over the recorded tokenomics bundles, in memory. Every section and every graph
 * query of a protocol is one template. A row keeps the provenance of the bundle row or of the relationships it
 * walks; a section that is not ready is returned as not mapped with its recorded notes, never as zero rows.
 */
import { join, resolve } from "node:path";
import { canonical, sha256 } from "../chain/evidence";
import { RecordingRpc } from "../chain/rpc";
import { runOptions } from "../config";
import { buildTokenomicsGraph, runTokenomicsLocal, tokenomicsQueries, type TGRelationship, type TokenomicsGraph } from "../graph/tokenomics-neo4j";
import { buildPack, type DocsCapture, type PackFile, type PackRegistry } from "../pack/build";
import type { BundleResponse, EvidenceRecord, Provenance, SectionId } from "../tokenomics/api";
import type { TokenomicsBuild } from "../tokenomics/build";
import { TOKENOMICS_REGISTRY, type ProtocolEntry } from "../tokenomics/registry";
import type { Cell } from "../ui/types";
import {
  MECHANICS, RetrievalError, paramsMatch,
  type ColumnRole, type Coverage, type CoverageStatus, type Mechanic, type ParamSchema, type ResultRow, type RetrievalBackend,
  type RetrievalResult, type RowKind, type TemplateDescriptor,
} from "./retrieval";

type CannedQuery = ReturnType<typeof tokenomicsQueries>[number];

export type BundleSource = {
  /** The registry entry's id, title and coverage statement. */
  id: string;
  title: string;
  coverage: string | null;
  bundle: BundleResponse;
  evidence: { lookup(ids: string[]): { items: EvidenceRecord[]; missing: string[] } };
  graph: TokenomicsGraph;
  queries: CannedQuery[];
};

export const BACKEND_ID = "bundle-local";
export const BACKEND_VERSION = "1";
export const DOCUMENTATION_NOTE = "Documentation is not indexed in this capture";
export const BACKEND_GAP_NOTE = "Not mapped by this backend";
export const GRAPH_GAP_NOTE = "Not mapped in the recorded graph";
/** Every fixed sentence this backend writes into a result or a coverage list. */
export const BACKEND_NOTES: readonly string[] = Object.freeze([DOCUMENTATION_NOTE, BACKEND_GAP_NOTE, GRAPH_GAP_NOTE]);

const SUBJECT_MAX = 120;
const SUBJECT_PARAMS: ParamSchema = { type: "object", additionalProperties: false, required: [], properties: { subject: { type: "string", maxLength: SUBJECT_MAX } } };
const NO_PARAMS: ParamSchema = { type: "object", additionalProperties: false, required: [], properties: {} };

type SectionName = Exclude<SectionId, "answer" | "graph">;
/** The section templates, in the order of the bundle. */
const SECTION_ORDER: readonly SectionName[] = ["path", "control", "offsets", "parameters", "programs", "participation", "holders", "flows", "claims"];

type Column = { name: string; role: ColumnRole };
const columns = (...pairs: [string, ColumnRole][]): Column[] => pairs.map(([name, role]) => ({ name, role }));

interface SectionSpec {
  mechanic: Mechanic;
  shape: TemplateDescriptor["shape"];
  title: string;
  question: string;
  cannotTell: string;
  columns: Column[];
  /** The columns the `subject` param is matched against. */
  match: string[];
}

const SECTIONS: Record<SectionName, SectionSpec> = {
  path: {
    mechanic: "fees", shape: "path", title: "Value path links",
    question: "Which links carry value between the recorded accounts, by which mechanism, and what was observed on each?",
    cannotTell: "A link's status is as recorded at capture; it does not show that value moves today.",
    columns: columns(["from", "label"], ["to", "label"], ["mechanism", "note"], ["status", "status"], ["amount", "amount"], ["unit", "unit"], ["window", "time"], ["note", "note"]),
    match: ["from", "to", "mechanism", "note"],
  },
  control: {
    mechanic: "control", shape: "chain", title: "Control rows",
    question: "Which role and authority can change each target, through which instruction, and who controls that authority?",
    cannotTell: "It does not show whether an authority has used its power, or will.",
    columns: columns(["target", "label"], ["instruction", "instruction"], ["role", "role"], ["authority", "address"], ["controller", "label"], ["controllerType", "status"], ["threshold", "value"], ["what", "note"]),
    match: ["target"],
  },
  offsets: {
    mechanic: "flows", shape: "table", title: "Offsets",
    question: "Which recorded amounts work against value reaching holders, and over which window?",
    cannotTell: "Amounts cover the stated window only; they are not a forecast.",
    columns: columns(["label", "label"], ["amount", "amount"], ["unit", "unit"], ["window", "time"], ["note", "note"]),
    match: ["label"],
  },
  parameters: {
    mechanic: "parameters", shape: "chain", title: "Parameters",
    question: "What is each recorded parameter's value, and which instruction, role and authority can set it?",
    cannotTell: "A setter is linked to its parameter by name matching and is marked inferred; the value is as decoded at the slot shown.",
    columns: columns(["target", "label"], ["value", "value"], ["raw", "value"], ["unit", "unit"], ["field", "label"], ["program", "address"], ["instruction", "instruction"], ["role", "role"], ["authority", "address"], ["controller", "label"]),
    match: ["target", "field", "program"],
  },
  programs: {
    mechanic: "code-upgrade", shape: "chain", title: "Programs",
    question: "Which programs are in scope, is each upgradeable, and which authority can upgrade it?",
    cannotTell: "It does not show what a program's code does, or whether an upgrade is planned.",
    columns: columns(["target", "address"], ["name", "label"], ["upgradeable", "status"], ["authority", "address"], ["controller", "label"], ["lastDeploySlot", "value"]),
    match: ["target", "name"],
  },
  participation: {
    mechanic: "governance", shape: "table", title: "Participation",
    question: "How is the governance token locked and used for voting, and by which programs?",
    cannotTell: "Voting weight is derived from recorded configuration; it is not a record of votes cast.",
    columns: columns(["group", "label"], ["label", "label"], ["value", "value"], ["amount", "amount"], ["unit", "unit"], ["program", "label"], ["rank", "value"], ["note", "note"]),
    match: ["label", "program"],
  },
  holders: {
    mechanic: "holders", shape: "table", title: "Holders and float",
    question: "Which accounts and groups hold each token, and what defines the float?",
    cannotTell: "Holder lists are bounded samples at the recorded slot; an owner label is a reported label, not an identity proof.",
    columns: columns(["group", "label"], ["label", "label"], ["value", "value"], ["amount", "amount"], ["unit", "unit"], ["share", "value"], ["rank", "value"], ["note", "note"]),
    match: ["label", "group"],
  },
  flows: {
    mechanic: "flows", shape: "table", title: "Flows",
    question: "Which routes are declared, and which treasury flows and buybacks were observed, in which window?",
    cannotTell: "Observed flows cover bounded samples and stated windows; a flow that was not observed is not shown to be absent.",
    columns: columns(["group", "label"], ["program", "label"], ["instruction", "instruction"], ["account", "label"], ["address", "address"], ["time", "time"], ["amount", "amount"], ["unit", "unit"], ["sent", "amount"], ["credited", "amount"], ["transactions", "value"], ["note", "note"]),
    match: ["group", "program", "instruction", "account"],
  },
  claims: {
    mechanic: "claims", shape: "table", title: "Claims against the chain",
    question: "What does each documentation claim say, and what does the recorded chain evidence establish for it?",
    cannotTell: "A claim marked claimed or unresolved was not checked against the chain in this capture.",
    columns: columns(["claim", "label"], ["source", "label"], ["status", "status"], ["chainResult", "value"], ["note", "note"]),
    match: ["claim", "source"],
  },
};

const UNKNOWNS_COLUMNS = columns(["text", "label"], ["origin", "label"], ["detail", "note"]);

/** Mechanic, shape and what the template cannot tell, per graph query. */
const GRAPH_TEMPLATES: Record<string, { mechanic: Mechanic; shape: TemplateDescriptor["shape"]; cannotTell: string }> = {
  "path-to-holders": { mechanic: "fees", shape: "path", cannotTell: "A link's status is as recorded at capture; it does not show that value moves today." },
  "who-can-change": { mechanic: "control", shape: "chain", cannotTell: "It does not show whether a controller has used its power, or will." },
  "parameter-control": { mechanic: "parameters", shape: "chain", cannotTell: "The link from a parameter to its setter is inferred by name matching." },
  "supply-control": { mechanic: "supply", shape: "chain", cannotTell: "It shows who holds the mint and freeze authorities, not how many tokens will exist." },
  "upgrade-control": { mechanic: "code-upgrade", shape: "chain", cannotTell: "It does not show what a program's code does, or whether an upgrade is planned." },
  "who-votes-where": { mechanic: "governance", shape: "chain", cannotTell: "It shows which body can vote in a governance, not how any vote went." },
  "claims-vs-chain": { mechanic: "claims", shape: "table", cannotTell: "A claim marked claimed or unresolved was not checked against the chain in this capture." },
  "holders-and-float": { mechanic: "holders", shape: "table", cannotTell: "Holder groups come from bounded samples and can overlap." },
  "vault-dependencies": { mechanic: "dependencies", shape: "table", cannotTell: "It lists recorded allocations, markets and price sources, not how each behaves under stress." },
};

const GRAPH_ROLES: Record<string, ColumnRole> = {
  holder: "address", authority: "address", from: "address", to: "address",
  amount: "amount", unit: "unit", status: "status", role: "role", instruction: "instruction",
  windowStart: "time", windowEnd: "time",
  value: "value", threshold: "value", thresholds: "value", share: "value", amountRaw: "value",
  what: "note", note: "note", mechanism: "note", chainResult: "note",
};

export function templatesSha256(descriptors: Record<string, TemplateDescriptor[]>): string {
  return sha256(canonical(descriptors));
}

/**
 * The snapshot id of a bundle: the sha256 of its canonical JSON, with the four fields that follow the machine's
 * graph database settings set to their unconfigured values, so the id is the same on every machine.
 */
export function snapshotId(bundle: BundleResponse): string {
  const graph = bundle.graph;
  const neutral = graph && graph.data
    ? { ...bundle, graph: { ...graph, data: { ...graph.data, configured: false, reason: "Neo4j is not configured", source: "local", host: null } } }
    : bundle;
  return sha256(canonical(neutral));
}

const bases = (provenance: Provenance): string[] => (Array.isArray(provenance.basis) ? [...provenance.basis] : [provenance.basis]);
const windowText = (window: [string, string] | null | undefined): string | null => (window ? `${window[0]} to ${window[1]}` : null);
const joined = (values: (string | null | undefined)[]): string | null => {
  const distinct = [...new Set(values.filter((value): value is string => typeof value === "string" && value !== ""))];
  return distinct.length > 0 ? distinct.join(", ") : null;
};
const cell = (value: unknown): Cell => (typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : null);

type Draft = { rowKind: RowKind; key: string; values: Record<string, unknown>; provenance: Provenance; extraBasis?: string };

function sectionDrafts(section: SectionName, bundle: BundleResponse): Draft[] {
  const drafts: Draft[] = [];
  const add = (rowKind: RowKind, list: string, id: string | number, provenance: Provenance, values: Record<string, unknown>, extraBasis?: string): void => {
    drafts.push({ rowKind, key: `${section}:${list}:${id}`, values, provenance, extraBasis });
  };
  if (section === "path") {
    const data = bundle.path.data!;
    const label = (id: string): string => data.nodes.find((node) => node.id === id)?.label ?? id;
    for (const link of data.links) {
      add("path", "links", link.id, link, {
        from: label(link.from), to: label(link.to), mechanism: link.mechanism, status: link.status,
        amount: link.observed?.amount.display, unit: link.observed?.amount.unit, window: windowText(link.observed?.window), note: link.note,
      });
    }
  } else if (section === "control") {
    const data = bundle.control.data!;
    for (const row of data.rows) {
      const controller = data.controllers.find((candidate) => candidate.id === row.controllerId);
      add("fact", "rows", row.id, row, {
        target: row.target, instruction: row.instructions.length > 0 ? row.instructions.join(", ") : null, role: row.role, authority: row.holder.address,
        controller: controller?.label ?? row.controllerId, controllerType: controller?.type, threshold: controller?.threshold, what: row.canChange,
      });
    }
  } else if (section === "offsets") {
    for (const row of bundle.offsets.data!.rows) {
      add("fact", "rows", row.id, row, { label: row.label, amount: row.amount?.display, unit: row.amount?.unit, window: windowText(row.window), note: row.note });
    }
  } else if (section === "parameters") {
    for (const row of bundle.parameters.data!.rows) {
      add("fact", "rows", row.id, row, {
        target: row.label, value: row.display, raw: row.value, unit: row.unit, field: row.field, program: row.program,
        instruction: joined(row.setBy.map((setter) => setter.instruction)), role: joined(row.setBy.map((setter) => setter.role)),
        authority: joined(row.setBy.map((setter) => setter.holder.address)), controller: joined(row.setBy.map((setter) => setter.controllerId)),
      }, row.setBy.length > 0 ? "inferred" : undefined);
    }
  } else if (section === "programs") {
    for (const row of bundle.programs.data!.rows) {
      add("fact", "rows", row.id, row, {
        target: row.address, name: row.idl?.name, upgradeable: row.upgradeable, authority: row.upgradeAuthority?.address,
        controller: row.upgradeAuthority?.controllerId, lastDeploySlot: row.lastDeploySlot,
      });
    }
  } else if (section === "participation") {
    const data = bundle.participation.data!;
    for (const [list, metrics] of [["locking", data.locking], ["votingPower", data.votingPower]] as const) {
      for (const metric of metrics) add("fact", list, metric.id, metric, { group: list, label: metric.label, value: metric.value, amount: metric.amount?.display, unit: metric.amount?.unit, note: metric.note });
    }
    for (const metric of data.programs) {
      add("fact", "programs", metric.id, metric, { group: "programs", label: metric.label, value: metric.value, amount: metric.amount?.display, unit: metric.amount?.unit, program: metric.program, note: metric.note });
    }
    for (const locker of data.topLockers) {
      add("fact", "topLockers", locker.rank, locker, { group: "topLockers", label: locker.authority.address, amount: locker.amount.display, unit: locker.amount.unit, rank: locker.rank });
    }
  } else if (section === "holders") {
    const data = bundle.holders.data!;
    for (const [list, metrics] of [["mnde.metrics", data.mnde.metrics], ["mnde.float", data.mnde.float], ["msol.metrics", data.msol.metrics]] as const) {
      for (const metric of metrics) {
        add("fact", list, metric.id, metric, { group: list, label: metric.label, value: metric.value, amount: metric.amount?.display, unit: metric.amount?.unit, share: metric.amount?.shareOfSupply, note: metric.note });
      }
    }
    for (const top of data.mnde.top) {
      add("fact", "mnde.top", top.rank, top, { group: "mnde.top", label: top.owner.address, amount: top.amount.display, unit: top.amount.unit, share: top.amount.shareOfSupply, rank: top.rank, note: top.role });
    }
    for (const top of data.msol.top) {
      add("fact", "msol.top", top.rank, top, { group: "msol.top", label: top.owner.address, amount: top.amount.display, unit: top.amount.unit, share: top.amount.shareOfSupply, rank: top.rank, note: top.label });
    }
    for (const group of data.msol.downstream) {
      add("fact", "msol.downstream", group.entity, group, { group: "msol.downstream", label: group.label ?? group.entity, amount: group.amount.display, unit: group.amount.unit, share: group.amount.shareOfSupply });
    }
  } else if (section === "flows") {
    const data = bundle.flows.data!;
    for (const route of data.declaredRoutes) {
      add("fact", "declaredRoutes", route.id, route, { group: "declaredRoutes", program: route.program, instruction: route.instruction, account: route.account, address: route.address, note: route.note });
    }
    const inflows = data.treasury.inflows;
    if (inflows) {
      add("fact", "treasury.inflows", 0, inflows, { group: "treasury.inflows", time: windowText(inflows.window), amount: inflows.amount.display, unit: inflows.amount.unit, transactions: inflows.transactions });
    }
    data.treasury.outflows.forEach((outflow, index) => {
      add("fact", "treasury.outflows", index, outflow, { group: "treasury.outflows", address: outflow.to.address, time: outflow.time, amount: outflow.amount.display, unit: outflow.amount.unit, note: outflow.signature });
    });
    for (const month of data.buybacks.months) {
      add("fact", "buybacks.months", month.month, month, {
        group: "buybacks.months", time: month.month, amount: month.mndeBought.display, unit: month.mndeBought.unit, sent: month.mndeSent.display,
        credited: month.mndeCreditedWithoutPayment?.display, transactions: month.creditTransactions,
      });
    }
  } else {
    for (const row of bundle.claims.data!.rows) {
      add("fact", "rows", row.id, row, { claim: row.text, source: row.source, status: row.status, chainResult: row.chainResult, note: row.note });
    }
  }
  return drafts;
}

function unknownDrafts(bundle: BundleResponse): Draft[] {
  const drafts: Draft[] = [];
  const answer = bundle.answer.data;
  for (const unknown of answer?.unknowns ?? []) {
    drafts.push({ rowKind: "unknown", key: `answer:unknowns:${unknown.id}`, values: { text: unknown.text, origin: "unknown" }, provenance: unknown });
  }
  for (const statement of answer?.statements ?? []) {
    if (statement.status === "unresolved") drafts.push({ rowKind: "unknown", key: `answer:statements:${statement.id}`, values: { text: statement.text, origin: "statement" }, provenance: statement });
  }
  for (const claim of bundle.claims.data?.rows ?? []) {
    if (claim.status === "unresolved") drafts.push({ rowKind: "unknown", key: `claims:rows:${claim.id}`, values: { text: claim.text, origin: "claim", detail: claim.chainResult }, provenance: claim });
  }
  return drafts;
}

/** The relationships each row of a graph query walks, in traversal order, in the order the graph lists them. */
function graphWalks(graph: TokenomicsGraph, query: CannedQuery): TGRelationship[][] {
  const labels = new Map(graph.nodes.map((node) => [node.id, node.labels]));
  const is = (id: string, label: string): boolean => labels.get(id)?.includes(label) ?? false;
  const out = (source: string, type: string): TGRelationship[] => graph.relationships.filter((relationship) => relationship.source === source && relationship.type === type);
  const mints = Array.isArray(query.params.mints) ? (query.params.mints as unknown[]) : [];
  const walks: TGRelationship[][] = [];
  for (const r of graph.relationships) {
    switch (query.id) {
      case "path-to-holders": if (r.type === "ROUTES_TO") walks.push([r]); break;
      case "who-can-change": if (r.type === "CAN_CHANGE" && is(r.source, "Controller")) walks.push([r]); break;
      case "claims-vs-chain": if (r.type === "CHECKS") walks.push([r]); break;
      case "holders-and-float": if (r.type === "HOLDS") walks.push([r]); break;
      case "vault-dependencies": if (r.type === "ALLOCATES_TO" || r.type === "IN_MARKET" || r.type === "PRICED_BY") walks.push([r]); break;
      case "supply-control":
        if ((r.type === "MINT_AUTHORITY" || r.type === "FREEZE_AUTHORITY") && mints.includes(r.source)) for (const controlled of out(r.target, "CONTROLLED_BY")) walks.push([r, controlled]);
        break;
      case "upgrade-control":
        if (r.type === "UPGRADE_AUTHORITY") for (const controlled of out(r.target, "CONTROLLED_BY")) walks.push([r, controlled]);
        break;
      case "who-votes-where":
        if (r.type === "CAN_CHANGE" && is(r.source, "Governance")) {
          for (const vote of graph.relationships) {
            if ((vote.type === "VOTES_IN" || vote.type === "VETOES") && vote.target === r.source && is(vote.source, "Controller")) walks.push([vote, r]);
          }
        }
        break;
      case "parameter-control":
        if (r.type === "SET_BY") for (const held of out(r.target, "HELD_BY")) for (const controlled of out(held.target, "CONTROLLED_BY")) walks.push([r, held, controlled]);
        break;
      default: break;
    }
  }
  return walks;
}

type GraphRow = { values: Record<string, Cell>; walk: TGRelationship[] };

/**
 * The rows of a graph query with the relationships behind each. The values are the local query runner's own, in
 * its order: each walk is evaluated by the runner alone, and each row of the full run takes the first walk that
 * is still free and has the same values.
 */
function graphRows(graph: TokenomicsGraph, query: CannedQuery, queries: CannedQuery[]): GraphRow[] {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const walked = graphWalks(graph, query).map((walk) => {
    const ids = [...new Set(walk.flatMap((relationship) => [relationship.source, relationship.target]))];
    const alone = runTokenomicsLocal({ nodes: ids.map((id) => nodes.get(id)!), relationships: walk }, query.id, queries).rows;
    if (alone.length !== 1) throw new Error("graph-walk-mismatch");
    return { text: canonical(alone[0]), walk, used: false };
  });
  const rows = runTokenomicsLocal(graph, query.id, queries).rows;
  if (rows.length !== walked.length) throw new Error("graph-walk-mismatch");
  return rows.map((values) => {
    const text = canonical(values);
    const match = walked.find((candidate) => !candidate.used && candidate.text === text);
    if (!match) throw new Error("graph-walk-mismatch");
    match.used = true;
    return { values, walk: match.walk };
  });
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

interface Loaded { source: BundleSource; descriptors: TemplateDescriptor[] }

export class BundleBackend implements RetrievalBackend {
  readonly id = BACKEND_ID;
  readonly version = BACKEND_VERSION;
  private readonly loaded = new Map<string, Loaded>();
  private readonly snapshots = new Map<string, string>();
  private readonly graphs = new Map<string, GraphRow[]>();
  private addresses: Set<string> | null = null;
  private readonly hash: string;

  constructor(sources: BundleSource[]) {
    const all: Record<string, TemplateDescriptor[]> = {};
    for (const source of sources) {
      if (this.loaded.has(source.id)) throw new Error("duplicate-protocol");
      const descriptors = describe(source);
      this.loaded.set(source.id, { source, descriptors });
      all[source.id] = descriptors;
    }
    this.hash = templatesSha256(all);
  }

  /** The sha256 of every protocol's template descriptors, fixed when the backend is built. */
  get templatesSha256(): string {
    return this.hash;
  }

  protocols(): { id: string; title: string }[] {
    return [...this.loaded.values()].map(({ source }) => ({ id: source.id, title: source.title }));
  }

  templates(protocol: string): TemplateDescriptor[] {
    return structuredClone(this.entry(protocol).descriptors);
  }

  coverage(protocol: string): Coverage {
    const { source, descriptors } = this.entry(protocol);
    const pendingNotes = new Map<Mechanic, string[]>();
    const mapped = new Set<Mechanic>();
    for (const section of SECTION_ORDER) {
      const envelope = source.bundle[section];
      const mechanic = SECTIONS[section].mechanic;
      if (sectionReady(source.bundle, section)) mapped.add(mechanic);
      else pendingNotes.set(mechanic, [...(pendingNotes.get(mechanic) ?? []), strings(envelope?.notes).join(" ")]);
    }
    for (const descriptor of descriptors) {
      if (descriptor.mechanic !== null && source.queries.some((query) => query.id === descriptor.id) && this.graphRowsOf(source, descriptor.id).length > 0) mapped.add(descriptor.mechanic);
    }
    const mechanics: Coverage["mechanics"] = MECHANICS.map((mechanic) => {
      const status: CoverageStatus = mapped.has(mechanic) ? "mapped" : "not-mapped";
      const pending = pendingNotes.get(mechanic);
      const note = pending ? pending.join(" ") : source.coverage !== null ? source.coverage : status === "mapped" ? "" : BACKEND_GAP_NOTE;
      return { mechanic, status, note };
    });
    mechanics.push({ mechanic: "documentation", status: "not-mapped", note: DOCUMENTATION_NOTE });
    return { protocol: source.id, title: source.title, snapshotIds: [this.snapshotOf(source)], mechanics, subjects: [] };
  }

  async run(protocol: string, templateId: string, params: Record<string, unknown>, options: { maxRows: number; asOf?: string }): Promise<RetrievalResult> {
    const found = this.loaded.get(protocol);
    if (!found) throw new RetrievalError("invalid-params");
    const descriptor = found.descriptors.find((candidate) => candidate.id === templateId);
    if (!descriptor) throw new RetrievalError("unknown-template");
    if (!paramsMatch(descriptor.params, params)) throw new RetrievalError("invalid-params");
    if (options === null || typeof options !== "object" || !Number.isSafeInteger(options.maxRows) || options.maxRows < 0) throw new RetrievalError("invalid-params");
    if (options.asOf !== undefined) throw new RetrievalError("as-of-unsupported");

    const { source } = found;
    const snapshot = this.snapshotOf(source);
    const names = descriptor.columns.map((column) => column.name);
    const finish = (rowKind: RowKind, key: string, values: Record<string, unknown>, provenance: { bases: string[]; evidenceIds: string[]; blockOrSlot: number | null; asOf: string | null }): ResultRow => ({
      rowKind, key, values: Object.fromEntries(names.map((name) => [name, cell(values[name])])),
      factIds: [], bases: provenance.bases, evidenceIds: provenance.evidenceIds, blockOrSlot: provenance.blockOrSlot, asOf: provenance.asOf, snapshotIds: [snapshot],
    });
    const gap = (notes: string[]): { coverage: CoverageStatus; coverageNotes: string[]; rows: ResultRow[] } => ({
      coverage: "not-mapped", coverageNotes: notes,
      rows: [finish("coverage", `${templateId.startsWith("section-") ? templateId.slice("section-".length) : templateId}:coverage`, {}, { bases: [], evidenceIds: [], blockOrSlot: null, asOf: null })],
    });
    const fromDrafts = (drafts: Draft[]): ResultRow[] => drafts.map((draft) => {
      const rowBases = bases(draft.provenance);
      if (draft.extraBasis !== undefined && !rowBases.includes(draft.extraBasis)) rowBases.push(draft.extraBasis);
      return finish(draft.rowKind, draft.key, draft.values, { bases: rowBases, evidenceIds: [...draft.provenance.evidenceIds], blockOrSlot: draft.provenance.slot, asOf: draft.provenance.asOf });
    });

    let body: { coverage: CoverageStatus; coverageNotes: string[]; rows: ResultRow[] };
    if (templateId === "unknowns") {
      body = { coverage: "mapped", coverageNotes: [], rows: fromDrafts(unknownDrafts(source.bundle)) };
    } else if (templateId.startsWith("section-")) {
      const section = templateId.slice("section-".length) as SectionName;
      const envelope = source.bundle[section];
      if (!sectionReady(source.bundle, section)) body = gap([...strings(envelope?.notes)]);
      else {
        let rows = fromDrafts(sectionDrafts(section, source.bundle));
        const subject = typeof params.subject === "string" ? params.subject.toLowerCase() : "";
        if (subject !== "") {
          const match = SECTIONS[section].match;
          rows = rows.filter((row) => match.some((name) => row.values[name] !== null && String(row.values[name]).toLowerCase().includes(subject)));
        }
        body = { coverage: "mapped", coverageNotes: [...strings(envelope.notes)], rows };
      }
    } else {
      const rows = this.graphRowsOf(source, templateId);
      if (rows.length === 0) body = gap([GRAPH_GAP_NOTE]);
      else {
        body = {
          coverage: "mapped", coverageNotes: [],
          rows: rows.map(({ values, walk }) => {
            const slots = walk.map((relationship) => relationship.props.slot).filter((slot): slot is number => typeof slot === "number");
            const times = walk.map((relationship) => relationship.props.asOf).filter((time): time is string => typeof time === "string").sort();
            return finish(walk.length === 1 ? "fact" : "path", walk.length === 1 ? walk[0].key : sha256(canonical(walk.map((relationship) => relationship.key))), values, {
              bases: walk.flatMap((relationship) => strings(relationship.props.basis)),
              evidenceIds: [...new Set(walk.flatMap((relationship) => strings(relationship.props.evidenceIds)))],
              blockOrSlot: slots.length > 0 ? Math.max(...slots) : null,
              asOf: times.at(-1) ?? null,
            });
          }),
        };
      }
    }
    const truncated = body.coverage !== "not-mapped" && body.rows.length > options.maxRows;
    return {
      resultId: "r0", protocol: source.id, backend: { id: this.id, version: this.version, templatesSha256: this.hash },
      templateId, templateVersion: descriptor.version, shape: descriptor.shape, columns: descriptor.columns.map((column) => ({ ...column })),
      coverage: body.coverage, coverageNotes: body.coverageNotes, rows: truncated ? body.rows.slice(0, options.maxRows) : body.rows, truncated,
    };
  }

  async evidence(protocol: string, ids: string[]): Promise<{ items: EvidenceRecord[]; missing: string[] }> {
    return this.entry(protocol).source.evidence.lookup(ids);
  }

  /**
   * Every run of 32 to 44 base58 characters found in a string value of a loaded bundle: the addresses a question
   * may name, because the recorded evidence already holds them.
   */
  knownAddresses(): ReadonlySet<string> {
    if (this.addresses === null) {
      const found = new Set<string>();
      const visit = (value: unknown): void => {
        if (typeof value === "string") for (const run of addressRuns(value)) found.add(run);
        else if (Array.isArray(value)) value.forEach(visit);
        else if (value !== null && typeof value === "object") Object.values(value).forEach(visit);
      };
      for (const { source } of this.loaded.values()) visit(source.bundle);
      this.addresses = found;
    }
    return this.addresses;
  }

  private entry(protocol: string): Loaded {
    const found = this.loaded.get(protocol);
    if (!found) throw new RetrievalError("invalid-params");
    return found;
  }

  private snapshotOf(source: BundleSource): string {
    let id = this.snapshots.get(source.id);
    if (id === undefined) {
      id = snapshotId(source.bundle);
      this.snapshots.set(source.id, id);
    }
    return id;
  }

  private graphRowsOf(source: BundleSource, queryId: string): GraphRow[] {
    const key = `${source.id}\n${queryId}`;
    let rows = this.graphs.get(key);
    if (rows === undefined) {
      const query = source.queries.find((candidate) => candidate.id === queryId);
      if (!query) throw new RetrievalError("unknown-template");
      rows = graphRows(source.graph, query, source.queries);
      this.graphs.set(key, rows);
    }
    return rows;
  }
}

const BASE58_RUN = /[1-9A-HJ-NP-Za-km-z]+/g;

/** The runs of 32 to 44 base58 characters in a text. A longer run is not an address and is left out whole. */
export function addressRuns(text: string): string[] {
  return (text.match(BASE58_RUN) ?? []).filter((run) => run.length >= 32 && run.length <= 44);
}

function sectionReady(bundle: BundleResponse, section: SectionName): boolean {
  const envelope = bundle[section];
  return envelope !== undefined && envelope !== null && envelope.status === "ready" && envelope.data !== null && envelope.data !== undefined;
}

/** The descriptors of one source. They are read from the section list and the query list, never from a row. */
function describe(source: BundleSource): TemplateDescriptor[] {
  const descriptors: TemplateDescriptor[] = SECTION_ORDER.map((section) => {
    const spec = SECTIONS[section];
    return {
      id: `section-${section}`, version: "1", title: spec.title, question: spec.question, mechanic: spec.mechanic, shape: spec.shape,
      params: structuredClone(SUBJECT_PARAMS), columns: spec.columns.map((column) => ({ ...column })), cannotTell: spec.cannotTell,
    };
  });
  descriptors.push({
    id: "unknowns", version: "1", title: "Unresolved items",
    question: "What does the recorded snapshot leave unresolved: open unknowns, unresolved statements and unresolved claims?",
    mechanic: null, shape: "unknowns", params: structuredClone(NO_PARAMS), columns: UNKNOWNS_COLUMNS.map((column) => ({ ...column })),
    cannotTell: "It lists what the capture itself marks unresolved; a gap the capture does not report is not listed.",
  });
  for (const query of source.queries) {
    const known = GRAPH_TEMPLATES[query.id];
    if (!known) throw new Error("unknown-graph-query");
    descriptors.push({
      id: query.id, version: "1", title: query.title, question: query.question, mechanic: known.mechanic, shape: known.shape,
      params: structuredClone(NO_PARAMS), columns: query.columns.map((name) => ({ name, role: GRAPH_ROLES[name] ?? "label" })), cannotTell: known.cannotTell,
    });
  }
  return descriptors;
}

/** A registry entry and its build as a source. The build's own graph is used when it has one. */
export function bundleSource(entry: ProtocolEntry, build: TokenomicsBuild): BundleSource {
  const own = (build as TokenomicsBuild & { graph?: TokenomicsGraph }).graph;
  return {
    id: entry.id, title: entry.title, coverage: entry.coverage, bundle: build.bundle, evidence: build.evidence,
    graph: own ?? buildTokenomicsGraph(build.bundle), queries: tokenomicsQueries(entry.namespace, entry.queryIds),
  };
}

const DEFAULT_ROOT = resolve(import.meta.dir, "../..");

/**
 * Loads every protocol of the registry from the committed captures and returns the backend over them. It replays
 * recorded responses only and fails if a read reaches the network.
 */
export async function loadBundleBackend(root: string = DEFAULT_ROOT): Promise<BundleBackend> {
  const json = async <T>(file: string): Promise<T> => (await Bun.file(join(root, file)).json()) as T;
  const sources: BundleSource[] = [];
  for (const entry of TOKENOMICS_REGISTRY) {
    if (entry.id === "marinade") {
      const pack = await json<PackFile>("packs/marinade/pack.json");
      const registry = await json<PackRegistry>(pack.registry);
      const options = runOptions({ offline: true, record: false, refresh: false, rpcUrl: "http://127.0.0.1:1", fixturesDir: join(root, "fixtures"), outDir: join(root, "out/answers") });
      const rpc = new RecordingRpc(options, "marinade-pack");
      const packet = await buildPack(rpc, registry, { title: pack.title, docsCapture: await json<DocsCapture>(pack.docsCapture), burns: pack.burns, ledger: pack.ledger });
      if (rpc.counts.live !== 0) throw new Error("capture-replay-reached-the-network");
      sources.push(bundleSource(entry, await entry.load(root, { marinadePack: { packet, evidence: rpc.evidence } })));
    } else {
      sources.push(bundleSource(entry, await entry.load(root, {})));
    }
  }
  return new BundleBackend(sources);
}
