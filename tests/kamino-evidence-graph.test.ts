// Kamino Lend main market and five kVaults in the shared evidence graph.
// Independent of the implementation: every expected value is a literal from the approved
// contract or is recomputed here from the committed captures. The whole file runs offline:
// fetch, WebSocket, Bun.connect, node:net and node:http(s) are trapped and any call fails.
import { describe, test, expect, beforeAll, afterAll, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as netNamespace from "node:net";
import netDefault from "node:net";
import * as httpModule from "node:http";
import * as httpsModule from "node:https";

import {
  seriesOf, collectSlice1Inputs, collectEvidenceInputs, SLICE1_SNAPSHOT_IDS, KAMINO_VAULT_SLUGS,
  BuildRejected, PROTOCOLS,
} from "../src/graph/evidence/protocols";
import {
  buildEvidenceRecords, recordsSha256, recordCounts,
} from "../src/graph/evidence/build";
import { validateEvidenceRecords } from "../src/graph/evidence/validate";
import { runEvidenceLocal, EVIDENCE_TEMPLATES } from "../src/graph/evidence/templates";
import { loadMain } from "../src/graph/evidence/cli";
import { MECHANICS } from "../src/graph/evidence/schema";
import { VAULT_TARGETS, identity } from "../src/adapters/kamino/index";
import type { EvidenceInput } from "../src/graph/evidence/protocols";
import type { EvidenceRecords } from "../src/graph/evidence/build";
import { SnapshotRejected } from "../src/engine/queries/snapshot";

// ---- repository-relative paths (resolved here, never absolute) ----
const ROOT = join(import.meta.dir, "..");
const PIN = "tests/fixtures/kamino-evidence-graph/records.sha256";
const SLICE1_PIN = "tests/fixtures/evidence-graph-model/records.sha256";
const readPin = (rel: string) => readFileSync(join(ROOT, rel), "utf8").trim();

// ---- literals from the approved contract ----
const LEND_SERIES = "kamino-lend.main-market";
const LEND_PROTOCOL = "protocol:kamino-lend";
const LEND_TITLE = "Kamino Lend main market";
const MARKET = "solana:mainnet-beta:7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF";
const PYUSD_RESERVE = "solana:mainnet-beta:2gc9Dm1eB6UgVYFBUN9bWks6Kes9PbWSaPaa9DqyvEiN";
const LEND_SNAPSHOT_ID = "solana-mainnet-beta.kamino-lend.main-market-20261111T195059Z";
const CONTROL_ROWS: { coreType: string; predicate: string; objectId: string }[] = [
  { coreType: "ADMIN", predicate: "MARKET_OWNER", objectId: "24LjDBukaUSHgPowcF2wY1XscnhChcBUDETN2UhBZMMT" },
  { coreType: "PAUSE_AUTHORITY", predicate: "EMERGENCY_AUTHORITY", objectId: "4VtJ1yCCyU2YGgPTZGHZRwzwaZ3hmzgqMtRQo8RqMa57" },
  { coreType: "ADMIN", predicate: "RESERVE_PROPOSER", objectId: "BN73b8HCQUsqdrBTqFuzqk9o1SH7fUTEcXxYmv43agJH" },
];
const MAPPED_MECHANICS = ["control", "code-upgrade", "dependencies"] as const;
const TEMPLATE_IDS = ["entity-resolve", "control", "dependencies", "changes", "evidence", "shared-controllers", "exposure", "coverage"] as const;
const SLICE1_SERIES: Record<string, string> = {
  "solana-mainnet-beta.kamino.sentora-pyusd-20261109T163416Z": "kamino.sentora-pyusd",
  "solana-mainnet-beta.kamino.sentora-pyusd-20261109T170418Z": "kamino.sentora-pyusd",
  "near-2026-11-09": "near.control-surface",
  "near-constructed-intents-locker-added": "near.control-surface",
  "near-constructed-governance-expired": "near.control-surface",
  "near-constructed-governance-kinds": "near.control-surface",
  "near-constructed-governance-policy-changed": "near.control-surface",
};

// ---- offline trap for the whole file ----
const hits = { fetch: 0, websocket: 0, connect: 0, net: 0 };
const trapError = (kind: string) => new Error(`network is trapped in this test file (${kind})`);
const trapFetch = (): Response => { hits.fetch++; throw trapError("fetch"); };
let restores: (() => void)[] = [];
let fetchSpy: any;

beforeAll(() => {
  process.chdir(ROOT);
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(trapFetch as any);
  restores.push(() => fetchSpy.mockRestore());
  const realWebSocket = globalThis.WebSocket;
  (globalThis as any).WebSocket = class { constructor() { hits.websocket++; throw trapError("WebSocket"); } };
  restores.push(() => { (globalThis as any).WebSocket = realWebSocket; });
  const realConnect = (Bun as any).connect;
  (Bun as any).connect = (): never => { hits.connect++; throw trapError("Bun.connect"); };
  restores.push(() => { (Bun as any).connect = realConnect; });
  for (const mod of [netNamespace as any, netDefault as any, httpModule as any, httpsModule as any]) {
    for (const name of ["connect", "createConnection", "request", "get"]) {
      if (typeof mod[name] !== "function") continue;
      const trap = (): never => { hits.net++; throw trapError("node:net/http(s)"); };
      try {
        const spy = spyOn(mod, name).mockImplementation(trap as any);
        restores.push(() => spy.mockRestore());
      } catch {
        const real = mod[name];
        try { mod[name] = trap; restores.push(() => { mod[name] = real; }); } catch { /* read-only export */ }
      }
    }
  }
});

afterAll(() => {
  for (const restore of restores) restore();
  restores = [];
  expect(hits).toEqual({ fetch: 0, websocket: 0, connect: 0, net: 0 });
});

// ---- inputs and the full build, built once ----
let inputs: EvidenceInput[];
let records: EvidenceRecords;
let slice1Records: EvidenceRecords;
const idsOf = (list: EvidenceInput[]) => list.map(i => i.snapshot.id);
const vaultInputsOf = (slug: string) =>
  inputs.filter(i => i.snapshot.id.startsWith(`solana-mainnet-beta.kamino.${slug}-`));
const protocolIdOfSlug = (slug: string) => `protocol:kamino-vault-${slug}`;
const coverageIdOf = (protocolId: string, series: string, mechanic: string) =>
  `coverage:${protocolId.slice("protocol:".length)}:${series}:${mechanic}`;

beforeAll(() => {
  inputs = collectEvidenceInputs(".");
  records = buildEvidenceRecords(inputs);
  slice1Records = buildEvidenceRecords(collectSlice1Inputs("."));
});

const protocolNode = (id: string) => records.nodes.find(n => n.label === "Protocol" && n.id === id);
const entities = (id: string) => records.nodes.filter(n => n.label === "Entity" && n.id === id);
const partOfFrom = (from: string) => records.relationships.filter(r => r.type === "PART_OF" && r.from === from);
const coverageOf = (protocolId: string) =>
  records.nodes.filter(n => n.label === "Coverage" && n.props.protocolId === protocolId);

// ================================================================ AC1
describe("AC1 series of the new snapshots", () => {
  test("the Kamino Lend main-market snapshot is on its own series", () => {
    expect(seriesOf(LEND_SNAPSHOT_ID)).toBe(LEND_SERIES);
  });

  test("each registered vault slug maps to its own series, literal and fixture ids", () => {
    for (const slug of KAMINO_VAULT_SLUGS) {
      expect(seriesOf(`solana-mainnet-beta.kamino.${slug}-20261112T003925Z`)).toBe(`kamino.${slug}`);
      for (const input of vaultInputsOf(slug)) {
        expect(seriesOf(input.snapshot.id)).toBe(`kamino.${slug}`);
      }
    }
  });

  test("every slice-1 id keeps the series it had at the base", () => {
    expect(KAMINO_VAULT_SLUGS).not.toContain("sentora-pyusd");
    for (const id of SLICE1_SNAPSHOT_IDS) {
      expect(seriesOf(id)).toBe(SLICE1_SERIES[id]);
    }
  });

  test("an unregistered Kamino and Kamino Lend snapshot id is refused", () => {
    for (const id of [
      "solana-mainnet-beta.kamino.unregistered-20261112T000000Z",
      "solana-mainnet-beta.kamino-lend.other-market-20261112T000000Z",
    ]) {
      let error: any;
      try { seriesOf(id); } catch (e) { error = e; }
      expect(error).toBeInstanceOf(BuildRejected);
      expect(error.code).toBe("unregistered-series");
    }
  });
});

// ================================================================ AC2
describe("AC2 the full input set", () => {
  test("the full set holds the slice-1 inputs, the Kamino Lend input and ten vault inputs", () => {
    expect(inputs.length).toBe(18);
    const slice1 = collectSlice1Inputs(".");
    expect(idsOf(inputs).slice(0, SLICE1_SNAPSHOT_IDS.length)).toEqual(idsOf(slice1));
    expect(SLICE1_SNAPSHOT_IDS.length).toBe(7);
    const lend = inputs[SLICE1_SNAPSHOT_IDS.length]!;
    expect(lend.snapshot.id).toBe(LEND_SNAPSHOT_ID);
    const vaultInputs = inputs.slice(SLICE1_SNAPSHOT_IDS.length + 1);
    expect(vaultInputs.length).toBe(10);
    for (const slug of KAMINO_VAULT_SLUGS) {
      const slots = vaultInputsOf(slug);
      expect(slots.length).toBe(2);
      for (const slot of slots) {
        expect(slot.mechanics).toBeDefined();
        expect(slot.snapshot.id.startsWith(`solana-mainnet-beta.kamino.${slug}-`)).toBe(true);
      }
    }
  });

  test("the id order is deterministic across two calls", () => {
    expect(idsOf(collectEvidenceInputs("."))).toEqual(idsOf(inputs));
  });

  test("slice 1 is unchanged: its build still matches the slice-1 pin", () => {
    expect(recordsSha256(slice1Records)).toBe(readPin(SLICE1_PIN));
  });

  test("a reordered or shortened id list is distinguishable from the recorded one", () => {
    const ids = idsOf(inputs);
    expect([...ids].reverse()).not.toEqual(ids);
    expect(ids.slice(0, 17)).not.toEqual(ids);
  });
});

// ================================================================ AC3
describe("AC3 protocol and coverage nodes of the full build", () => {
  const newProtocols = () => [
    { id: LEND_PROTOCOL, series: LEND_SERIES, title: LEND_TITLE },
    ...KAMINO_VAULT_SLUGS.map(slug => ({
      id: protocolIdOfSlug(slug),
      series: `kamino.${slug}`,
      title: `Kamino kVault ${vaultInputsOf(slug)[0]!.snapshot.names[identity(VAULT_TARGETS[slug].vault)]}`,
    })),
  ];
  test("one Protocol node per new case, with its series and title from the captures", () => {
    expect(protocolNode("protocol:kamino")).toBeDefined();
    expect(protocolNode("protocol:kamino")!.props.series).toBe("kamino.sentora-pyusd");
    for (const p of newProtocols()) {
      const node = protocolNode(p.id);
      expect(node).toBeDefined();
      expect(node!.props.series).toBe(p.series);
      expect(node!.props.title).toBe(p.title);
    }
    expect(protocolNode(LEND_PROTOCOL)!.props.title).toBe(LEND_TITLE);
  });

  test("the market and all 58 reserves are members of the Kamino Lend protocol", () => {
    const lendSnapshot = inputs.find(i => i.snapshot.id === LEND_SNAPSHOT_ID)!.snapshot;
    const reserves = [...new Set(
      lendSnapshot.facts
        .filter(f => f.predicate === "IN_MARKET" && f.object === MARKET)
        .map(f => f.subject),
    )];
    expect(reserves.length).toBe(58);
    const from = partOfFrom(MARKET).map(r => r.to);
    expect(from).toContain(LEND_PROTOCOL);
    for (const reserve of [...reserves, MARKET]) {
      expect(partOfFrom(reserve).map(r => r.to)).toContain(LEND_PROTOCOL);
    }
  });

  test("each new protocol has one Coverage node per mechanic, correctly identified", () => {
    for (const p of newProtocols()) {
      const rows = coverageOf(p.id);
      expect(rows.length).toBe(MECHANICS.length);
      const byId = new Map(rows.map(n => [n.id, n]));
      for (const mechanic of MECHANICS) {
        const row = byId.get(coverageIdOf(p.id, p.series, mechanic));
        expect(row).toBeDefined();
        expect(row!.props.mechanic).toBe(mechanic);
        expect(row!.props.series).toBe(p.series);
      }
    }
  });

  test("mapped and not-mapped statuses follow the contract, and absence stays unknown", () => {
    for (const p of newProtocols()) {
      for (const row of coverageOf(p.id)) {
        const mapped = (MAPPED_MECHANICS as readonly string[]).includes(row.props.mechanic as string);
        expect(row.props.status).toBe(mapped ? "mapped" : "not-mapped");
        if (!mapped) {
          expect(String(row.props.note)).toContain("absence is not evidence of absence");
        }
      }
    }
  });

  test("a changed title or note changes the records", () => {
    const forged = structuredClone(PROTOCOLS);
    const entry = forged.find(p => p.id === LEND_PROTOCOL)!;
    entry.title = "forged title";
    expect(recordsSha256(buildEvidenceRecords(inputs, { protocols: forged })))
      .not.toBe(recordsSha256(records));
});
});

// ================================================================ AC4
describe("AC4 shared entities and the new control facts", () => {
  test("the PYUSD reserve is one entity shared by both Kamino protocols", () => {
    expect(entities(PYUSD_RESERVE).length).toBe(1);
    const targets = partOfFrom(PYUSD_RESERVE).map(r => r.to);
    expect(targets).toContain("protocol:kamino");
    expect(targets).toContain(LEND_PROTOCOL);
  });

  test("entity-resolve resolves the reserve once, and once per protocol that holds it", () => {
    const plain = runEvidenceLocal(records, "entity-resolve", { text: PYUSD_RESERVE, limit: 10 });
    expect(plain.rows.length).toBe(1);
    expect(plain.rows[0].rowKind).toBe("scope");
    expect(plain.rows[0].entityId).toBe(PYUSD_RESERVE);
    for (const protocolId of ["protocol:kamino", LEND_PROTOCOL]) {
      const scoped = runEvidenceLocal(records, "entity-resolve", { text: PYUSD_RESERVE, protocolId, limit: 10 });
      expect(scoped.rows.length).toBe(1);
      expect(scoped.rows[0].entityId).toBe(PYUSD_RESERVE);
    }
  });

  test("entity-resolve under a protocol the reserve is not part of returns no scope row", () => {
    const scoped = runEvidenceLocal(records, "entity-resolve", {
      text: PYUSD_RESERVE, protocolId: protocolIdOfSlug("rwa-usdc"), limit: 10,
    });
    expect(scoped.rows.every((r: any) => r.rowKind !== "scope")).toBe(true);
  });

  test("the control answer for the market is three rows citing the Kamino Lend snapshot", () => {
    const lend = inputs.find(i => i.snapshot.id === LEND_SNAPSHOT_ID)!.snapshot;
    const result = runEvidenceLocal(records, "control", {
      subject: MARKET,
      scope: { snapshotId: lend.id, asOf: lend.observedTo, maxHops: 1, maxResults: 100 },
    });
    expect(result.outcome).toBe("complete");
    expect(result.rows.length).toBe(3);
    for (const expected of CONTROL_ROWS) {
      const row: any = result.rows.find((r: any) => r.predicate === expected.predicate);
      expect(row).toBeDefined();
      expect(row.coreType).toBe(expected.coreType);
      expect(String(row.objectId).endsWith(expected.objectId)).toBe(true);
      expect(row.snapshotId).toBe(LEND_SNAPSHOT_ID);
      expect(row.rowKind).toBe("fact");
    }
  });

  test("the roles sit on the projected ADMIN relationships of the records", () => {
    const marketOwner = records.relationships.find(r =>
      r.type === "ADMIN" && r.from === MARKET
      && r.to === `solana:mainnet-beta:${CONTROL_ROWS[0].objectId}`);
    expect(marketOwner).toBeDefined();
    expect(marketOwner!.props.role).toBe("market-owner");
    expect(marketOwner!.props.snapshotIds as string[]).toContain(LEND_SNAPSHOT_ID);
    const reserveProposer = records.relationships.find(r =>
      r.type === "ADMIN" && r.from === MARKET
      && r.to === `solana:mainnet-beta:${CONTROL_ROWS[2].objectId}`);
    expect(reserveProposer).toBeDefined();
    expect(reserveProposer!.props.role).toBe("reserve-proposer");
    expect(reserveProposer!.props.snapshotIds as string[]).toContain(LEND_SNAPSHOT_ID);
  });
});

// ================================================================ AC5
describe("AC5 determinism, validation and the pinned full-set hash", () => {
  const pinned = () => readPin(PIN);

  test("two builds and one from shuffled inputs share the pinned hash", () => {
    expect(recordsSha256(records)).toBe(pinned());
    expect(recordsSha256(buildEvidenceRecords(collectEvidenceInputs(".")))).toBe(pinned());
    const shuffled = [...inputs].sort(() => Math.random() - 0.5);
    expect(recordsSha256(buildEvidenceRecords(shuffled))).toBe(pinned());
  });

  test("the pinned file holds exactly the hash the builds produce", () => {
    expect(pinned()).toMatch(/^[0-9a-f]{64}$/);
    expect(pinned()).toBe(recordsSha256(records));
  });

  test("the validator accepts the full build", () => {
    expect(() => validateEvidenceRecords(records)).not.toThrow();
  });

  test("every template runs locally for one subject of each new protocol", () => {
    const lend = inputs.find(i => i.snapshot.id === LEND_SNAPSHOT_ID)!.snapshot;
    const cases: { protocolId: string; subject: string; first: typeof lend; last: typeof lend }[] = [
      { protocolId: LEND_PROTOCOL, subject: MARKET, first: lend, last: lend },
      ...KAMINO_VAULT_SLUGS.map(slug => {
        const slots = vaultInputsOf(slug);
        return {
          protocolId: protocolIdOfSlug(slug),
          subject: identity(VAULT_TARGETS[slug].vault),
          first: slots[0]!.snapshot,
          last: slots.at(-1)!.snapshot,
        };
      }),
    ];
    expect(new Set(EVIDENCE_TEMPLATES.map(t => t.id))).toEqual(new Set(TEMPLATE_IDS));
    let calls = 0;
    for (const c of cases) {
      const run = (id: string, params: Record<string, unknown>) => {
        calls++;
        expect(() => runEvidenceLocal(records, id, params)).not.toThrow();
      };
      run("entity-resolve", { text: c.subject, protocolId: c.protocolId, limit: 10 });
      run("control", {
        subject: c.subject,
        scope: { snapshotId: c.last.id, asOf: c.last.observedTo, maxHops: 1, maxResults: 100 },
      });
      run("dependencies", {
        subject: c.subject,
        scope: { snapshotId: c.last.id, asOf: c.last.observedTo, maxHops: 1, maxResults: 100 },
        relations: ["IN_MARKET", "ALLOCATES_TO", "ASSET_MINT", "PRICED_BY"],
      });
      run("changes", {
        subject: c.subject,
        beforeSnapshotId: c.first.id, afterSnapshotId: c.last.id, maxResults: 100,
      });
      run("evidence", { evidenceIds: c.first.receipts.slice(0, 2).map(r => r.id), maxResults: 100 });
      run("shared-controllers", { protocolId: c.protocolId, minSubjects: 2 });
      run("exposure", { subject: c.subject, maxHops: 3 });
      run("coverage", { protocolId: c.protocolId });
    }
    expect(calls).toBe(48);
  });
});

// ================================================================ AC6
describe("AC6 the command-line entry point", () => {
  const trapDeps = () => {
    const out: string[] = [], err: string[] = [];
    let envReads = 0, forbiddenCalls = 0;
    const guardedEnv = new Proxy({}, {
      get() { envReads++; throw new Error("no configuration read in a dry run"); },
    }) as Record<string, string | undefined>;
    const deps = {
      createDriver: () => { forbiddenCalls++; throw new Error("no driver in a dry run"); },
      readText: () => { forbiddenCalls++; throw new Error("no config file read in a dry run"); },
      out: (line: string) => out.push(line),
      err: (line: string) => err.push(line),
    };
    return { deps, guardedEnv, counts: () => ({ envReads, forbiddenCalls }), out, err };
  };

  test("the default dry run still prints the slice-1 counts and slice-1 hash", async () => {
    const t = trapDeps();
    const exit = await loadMain(["--dry-run"], t.guardedEnv, t.deps);
    expect(exit).toBe(0);
    expect(t.counts()).toEqual({ envReads: 0, forbiddenCalls: 0 });
    expect(t.err).toEqual([]);
    const printed = JSON.parse(t.out.at(-1)!);
    expect(printed.recordsSha256).toBe(readPin(SLICE1_PIN));
    expect(printed.labels).toEqual(recordCounts(slice1Records).labels);
    expect(printed.types).toEqual(recordCounts(slice1Records).types);
  });

  test("with the full-set flag the dry run prints the full counts and the full-set hash", async () => {
    const t = trapDeps();
    const exit = await loadMain(["--dry-run", "--all"], t.guardedEnv, t.deps);
    expect(exit).toBe(0);
    expect(t.counts()).toEqual({ envReads: 0, forbiddenCalls: 0 });
    expect(t.err).toEqual([]);
    const printed = JSON.parse(t.out.at(-1)!);
    expect(printed.recordsSha256).toBe(readPin(PIN));
    expect(printed.labels).toEqual(recordCounts(records).labels);
    expect(printed.types).toEqual(recordCounts(records).types);
  });

  test("an unknown argument is refused", async () => {
    const t = trapDeps();
    const exit = await loadMain(["--all", "--bogus"], {}, t.deps);
    expect(exit).toBe(2);
    expect([...t.out, ...t.err].join("\n")).toContain("Unknown argument");
  });

  test("without Neo4j configuration nothing is loaded and the failure names the missing configuration", async () => {
    const out: string[] = [], err: string[] = [];
    let driverCalls = 0;
    const deps = {
      createDriver: () => { driverCalls++; throw new Error("no driver expected"); },
      readText: () => { throw new Error("no config file expected"); },
      out: (line: string) => out.push(line),
      err: (line: string) => err.push(line),
    };
    const exit = await loadMain(["--all"], {}, deps);
    expect(exit).toBe(2);
    expect(driverCalls).toBe(0);
    expect(err.join("\n")).toContain("Neo4j configuration missing");
  });
});

// ================================================================ AC7
describe("AC7 failure cases", () => {
  test("a snapshot id naming an unregistered vault slug stops the build", () => {
    const forged: EvidenceInput = structuredClone(inputs.find(i =>
      i.snapshot.id.startsWith(`solana-mainnet-beta.kamino.${KAMINO_VAULT_SLUGS[0]}-`))!);
    forged.snapshot.id = `solana-mainnet-beta.kamino.not-a-vault-20261112T003925Z`;
    let error: any;
    try { buildEvidenceRecords([forged]); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(BuildRejected);
    expect(error.code).toBe("unregistered-series");
  });

  test("a coverage row no fact backs stops the build", () => {
    const forged = structuredClone(PROTOCOLS);
    const entry = forged.find(p => p.id === protocolIdOfSlug("rwa-usdc"))!;
    entry.coverage.find(c => c.mechanic === "governance")!.status = "mapped";
    let error: any;
    try {
      buildEvidenceRecords(vaultInputsOf("rwa-usdc"), { protocols: forged });
    } catch (e) { error = e; }
    expect(error).toBeInstanceOf(BuildRejected);
    expect(error.code).toBe("unbacked-coverage");
  });

  test("a fact whose predicate is outside the vocabulary is rejected by the build, not by the record validator", () => {
    const forged: EvidenceInput = structuredClone(inputs.find(i => i.snapshot.id === LEND_SNAPSHOT_ID)!);
    forged.snapshot.facts[0]!.predicate = "not-a-predicate";
    let error: any;
    try { buildEvidenceRecords([forged]); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(SnapshotRejected);
    expect(error.name).toBe("SnapshotRejected");
    expect(error.message).toBe("Snapshot rejected: unknown predicate");
    expect("code" in error).toBe(false);
  });
});
