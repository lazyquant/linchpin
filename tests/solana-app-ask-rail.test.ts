// Independent regression tests for the Ask rail/focus completion of the Solana app.
// Every expected value comes from the approved contracts (solana-app.md S10 and AC12,
// agent-answers-v2.md W5/W7 and the approved prototype's section 5.3 rail layout), never
// from what the implementation prints.
//
// The whole file runs offline: every fetch, WebSocket, Bun.connect and node:net/http(s)
// attempt is trapped and fails the file. The page under test receives its requests through
// an in-memory fetch injected as AppEnv.fetch, so nothing ever leaves the process.
import { describe, test, expect, beforeAll, afterAll, spyOn } from "bun:test";

/** bun:test of this checkout takes the timeout as the third argument; the long tests say it inline. */
const testT = (name: string, options: { timeout: number }, fn: () => unknown): void => {
  test(name, fn as () => void, options.timeout);
};
import * as netNamespace from "node:net";
import netDefault from "node:net";
import * as httpModule from "node:http";
import * as httpsModule from "node:https";

import { loadApp } from "../src/apps/solana/load";
import { startApp } from "../src/apps/solana/app";
import { IDS } from "../src/apps/solana/chrome";
import type { AppData, PreparedAnswers } from "../src/apps/solana/model";
import type { ResultRow } from "../src/ui/types";
import { instantiateV2 } from "../src/ui/templates-v2";

const LONG = 300_000;

// ---- literals from the approved contracts ----
/** agent-answers-v2.md W7/O-W3: the one honest label a prepared-answer document carries. */
const PREPARED_LABEL = "Composed by a fixed script over recorded evidence, not by a model";
/** agent-answers-v2.md W7: the heading the prepared list stands under. */
const PREPARED_HEADING = "Prepared answers";
/** The two origins an answer can have (approved wording; the entry's own label joins the prepared one). */
const PREPARED_ORIGIN = "Prepared answer";
const TYPED_ORIGIN = "Typed question";
/** solana-app.md S10: the absent-handler view retains exactly this absence. */
const ASK_NOT_BUILT = "Ask is not in this build";
/** The answer region's accessible name. */
const ANSWER_LABEL = "Answer";
const UNSETTLED_RECEIPT = "receipt-no-such-test-view-holds";

// ---- offline trap for the whole file: any attempt is a failure ----
const hits = { fetch: 0, websocket: 0, connect: 0, net: 0 };
const trapped: string[] = [];
let restores: (() => void)[] = [];

beforeAll(() => {
  const spy = spyOn(globalThis, "fetch").mockImplementation(((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    hits.fetch++;
    trapped.push(url);
    throw new Error(`offline: fetch trapped (${url})`);
  }) as unknown as typeof fetch);
  restores.push(() => spy.mockRestore());
  const realWebSocket = globalThis.WebSocket;
  (globalThis as { WebSocket: unknown }).WebSocket = class {
    constructor() {
      hits.websocket++;
      throw new Error("offline: WebSocket trapped");
    }
  };
  restores.push(() => {
    (globalThis as { WebSocket: unknown }).WebSocket = realWebSocket;
  });
  const box = Bun as unknown as { connect: unknown };
  const realConnect = box.connect;
  box.connect = (): never => {
    hits.connect++;
    throw new Error("offline: Bun.connect trapped");
  };
  restores.push(() => {
    box.connect = realConnect;
  });
  for (const mod of [netNamespace, netDefault, httpModule, httpsModule] as unknown as Record<string, unknown>[]) {
    for (const name of ["connect", "createConnection", "request", "get"]) {
      if (typeof mod[name] !== "function") continue;
      const trap = (): never => {
        hits.net++;
        throw new Error("offline: node:net/http(s) trapped");
      };
      try {
        const s = spyOn(mod as Record<string, () => unknown>, name as string).mockImplementation(trap as never);
        restores.push(() => s.mockRestore());
      } catch {
        const real = mod[name];
        try {
          mod[name] = trap;
          restores.push(() => {
            mod[name] = real;
          });
        } catch {
          /* read-only export */
        }
      }
    }
  }
});

afterAll(() => {
  for (const restore of restores) restore();
  restores = [];
  expect(hits).toEqual({ fetch: 0, websocket: 0, connect: 0, net: 0 });
  expect(trapped).toEqual([]);
});

// ---- shared data, loaded once; the replayed positions are not needed here ----
let data: AppData;
let realReceiptId: string;

beforeAll(async () => {
  const loaded = await loadApp(undefined, { positions: false });
  data = loaded.data;
  realReceiptId = Object.keys(data.receipts)[0];
}, LONG);

// ---- one valid, self-contained answer surface as NDJSON, over receipts the app holds ----
const answerRow = (evidenceIds: string[]): ResultRow => ({
  rowKind: "fact", key: "row-1",
  values: { subject: "A recorded subject", predicate: "CONTROL", object: "A recorded authority", finding: "a recorded finding", status: "verified" },
  factIds: [], bases: ["decoded"], evidenceIds, blockOrSlot: "453866515", asOf: null as string | null,
  snapshotIds: ["a-recorded-snapshot"], scopeSource: "a recorded source",
});
const answerTable = (rows: ResultRow[]) => ({
  resultId: "t1", shape: "table" as const, coverage: "mapped" as const, coverageNotes: [] as string[],
  rows, truncated: false, columns: [{ name: "subject", role: "subject" as const }],
});
const ndjsonOf = (evidenceIds: string[]): string =>
  instantiateV2("answer-panel", {
    surfaceId: "asked",
    meta: { title: "A recorded answer", snapshotIds: [] },
    results: [answerTable([answerRow(evidenceIds)])],
    receipts: {},
  })
    .map((message) => JSON.stringify(message))
    .join("\n") + "\n";

const VALID_NDJSON = (): string => ndjsonOf([realReceiptId]);
const UNRESOLVED_NDJSON = ndjsonOf([UNSETTLED_RECEIPT]);
const MALFORMED_NDJSON = "{ this line is not json\n";

// ---- the prepared-answer document the handler serves ----
const QUESTION_M1 = "Who can change the Marinade program?";
const QUESTION_M2 = "What does the mSOL mint rest on?";
const QUESTION_K1 = "Who controls the vault admin of the PYUSD vault?";
const LABEL_M1 = "Fixed script, first Marinade entry";
const LABEL_M2 = "Fixed script, second Marinade entry";
const LABEL_K1 = "Fixed script, Kamino entry";
type PreparedEntry = PreparedAnswers["answers"][number];
const preparedEntry = (id: string, question: string, protocol: string, label: string, ndjson: string): PreparedEntry => ({
  id, question, protocol, label, ndjson,
});
const preparedDocument = (answers: PreparedEntry[] = [
  preparedEntry("prep-m1", QUESTION_M1, "marinade", LABEL_M1, VALID_NDJSON()),
  preparedEntry("prep-m2", QUESTION_M2, "marinade", LABEL_M2, VALID_NDJSON()),
  preparedEntry("prep-k1", QUESTION_K1, "kamino", LABEL_K1, VALID_NDJSON()),
]): PreparedAnswers => ({
  label: PREPARED_LABEL,
  protocols: [
    { id: "marinade", title: "Marinade" },
    { id: "kamino", title: "Kamino" },
  ],
  answers,
});

// ---- a hand-made document for the page (no DOM library; only the members the page uses) ----
type Ev = { preventDefault: () => void; key?: string; currentTarget?: unknown };
class FakeElement {
  tag: string;
  attrs = new Map<string, string>();
  kids: FakeElement[] = [];
  ownText: string | null = null;
  parent: FakeElement | null = null;
  listeners = new Map<string, ((e: Ev) => void)[]>();
  doc: FakeDocument;
  value = "";
  constructor(tag: string, doc: FakeDocument) {
    this.tag = tag;
    this.doc = doc;
    (this as unknown as { ownerDocument: FakeDocument }).ownerDocument = doc;
  }
  setAttribute(name: string, attrValue: string): void {
    this.attrs.set(name, attrValue);
    if (name === "id") this.doc.register(attrValue, this);
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  append(...kids: FakeElement[]): void {
    for (const kid of kids) {
      kid.parent = this;
      this.kids.push(kid);
    }
  }
  replaceChildren(...kids: FakeElement[]): void {
    for (const kid of this.kids) kid.parent = null;
    this.kids = [];
    this.append(...kids);
  }
  get textContent(): string {
    return (this.ownText ?? "") + this.kids.map((kid) => kid.textContent).join("");
  }
  set textContent(setValue: string) {
    this.ownText = setValue;
    for (const kid of this.kids) kid.parent = null;
    this.kids = [];
  }
  addEventListener(type: string, fn: (e: Ev) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  dispatch(type: string, event: Ev = { preventDefault() {} }): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn({ ...event, currentTarget: this });
  }
  focus(): void {
    this.doc.active = this;
  }
  walk(): FakeElement[] {
    return [this, ...this.kids.flatMap((kid) => kid.walk())];
  }
  attr(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  classed(cls: string): FakeElement[] {
    return this.walk().filter((el) => (el.attr("class") ?? "").split(/\s+/).includes(cls));
  }
}
class FakeDocument {
  registry = new Map<string, FakeElement>();
  active: FakeElement | null = null;
  keydown: ((e: Ev) => void)[] = [];
  createElement(tag: string): FakeElement {
    return new FakeElement(tag, this);
  }
  createElementNS(ns: string, tag: string): FakeElement {
    if (ns !== "http://www.w3.org/2000/svg") throw new Error(`unexpected namespace ${ns}`);
    return new FakeElement(tag, this);
  }
  getElementById(id: string): FakeElement {
    let el = this.registry.get(id);
    if (!el) {
      el = new FakeElement("div", this);
      this.register(id, el);
    }
    return el;
  }
  register(id: string, el: FakeElement): void {
    this.registry.set(id, el);
  }
  addEventListener(type: string, fn: (e: Ev) => void): void {
    if (type === "keydown") this.keydown.push(fn);
  }
}

// ---- the page environment: an in-memory fetch for the page's own origin ----
interface AskCall { question: string; protocol: string }
interface AskHarness {
  doc: FakeDocument;
  asks: AskCall[];
  pinnedGets: number;
  gatePinned(): { resolve: (response: Response) => void };
  gateAsk(): { resolve: (response: Response) => void };
  setAskReply(value: { status: number; body: string } | null): void;
  setHash(hash: string): void;
  env(record: Record<string, unknown>): Record<string, unknown>;
}
function makeHarness(pinnedDocument: PreparedAnswers = preparedDocument()): AskHarness {
  const doc = new FakeDocument();
  const location = { hash: "#/protocols" };
  const handlers: (() => void)[] = [];
  const pinned = pinnedDocument;
  let askReply: { status: number; body: string } | null = null;
  let pinnedGate: { resolve: (response: Response) => void } | null = null;
  let askGate: { resolve: (response: Response) => void } | null = null;
  const asks: AskCall[] = [];
  let pinnedGets = 0;
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    if (input.endsWith("/api/answers/pinned")) {
      pinnedGets++;
      if (pinnedGate) {
        const gate = pinnedGate;
        pinnedGate = null;
        return new Promise<Response>((resolve) => {
          gate.resolve = resolve;
        });
      }
      return Response.json(pinned);
    }
    if (input.endsWith("/api/answers/ask")) {
      asks.push(JSON.parse(String(init?.body)) as AskCall);
      if (askGate) {
        const gate = askGate;
        askGate = null;
        return new Promise<Response>((resolve) => {
          gate.resolve = resolve;
        });
      }
      const reply = askReply ?? { status: 200, body: VALID_NDJSON() };
      return new Response(reply.body, { status: reply.status, headers: { "content-type": "application/x-ndjson" } });
    }
    throw new Error(`unexpected page request: ${input}`);
  };
  const base = {
    document: doc,
    location,
    addEventListener: (type: string, handler: () => void) => {
      if (type === "hashchange") handlers.push(handler);
    },
    sessionStorage: { getItem: () => null, setItem: () => {} },
    fetch: fetchImpl,
  };
  return {
    doc,
    asks,
    get pinnedGets() {
      return pinnedGets;
    },
    gatePinned() {
      pinnedGate = { resolve: () => {} };
      return pinnedGate;
    },
    gateAsk() {
      askGate = { resolve: () => {} };
      return askGate;
    },
    setAskReply(value) {
      askReply = value;
    },
    setHash(hash: string) {
      location.hash = hash;
      for (const fn of [...handlers]) fn();
    },
    env(record: Record<string, unknown>) {
      return { ...base, ...record };
    },
  };
}

const askData = (): AppData => ({ ...data, mode: "served", positions: null, replayAddress: null, ask: { enabled: true } });
const openAsk = async (harness: AskHarness, askAppData: AppData): Promise<void> => {
  const app = startApp(harness.env({ data: askAppData }) as never);
  harness.setHash("#/ask");
  await app.settled();
};
const mainOf = (harness: AskHarness): FakeElement => harness.doc.getElementById(IDS.main) as FakeElement;
const questionField = (main: FakeElement): FakeElement => main.walk().find((el) => el.attr("data-field") === "question")!;
const protocolField = (main: FakeElement): FakeElement => main.walk().find((el) => el.attr("data-field") === "protocol")!;
const preparedEntries = (main: FakeElement): FakeElement[] => main.walk().filter((el) => el.attr("data-act") === "prepared-answer");
const entryOf = (main: FakeElement, id: string): FakeElement => preparedEntries(main).find((el) => el.attr("data-arg") === id)!;
const currentEntries = (main: FakeElement): FakeElement[] => main.walk().filter((el) => el.attr("aria-current") === "true");
const answerRegion = (main: FakeElement): FakeElement => main.walk().find((el) => el.attr("aria-label") === ANSWER_LABEL)!;
const refused = (main: FakeElement): FakeElement[] => main.classed("sx-refused");
const originBlock = (main: FakeElement): FakeElement | undefined => main.classed("sx-ask-origin")[0];

/* ------------------------------------------------------------------ */
/* The rail and its answer region                                       */
/* ------------------------------------------------------------------ */
describe("the Ask rail beside its answer region", () => {
  testT("rail and answer are sibling regions, and the rail holds the question, protocol and prepared groups", { timeout: LONG }, async () => {
    const harness = makeHarness();
    await openAsk(harness, askData());
    const main = mainOf(harness);
    const grid = main.classed("sx-ask");
    expect(grid).toHaveLength(1);
    const children = grid[0].kids;
    const rail = children.filter((el) => (el.attr("class") ?? "").split(/\s+/).includes("sx-ask-rail"));
    expect(rail).toHaveLength(1);
    const region = children.filter((el) => el.attr("aria-label") === ANSWER_LABEL);
    expect(region).toHaveLength(1);
    expect(region[0].attr("tabindex")).toBe("-1");
    // The answer region stands beside the rail, not inside it.
    expect(rail[0].walk().includes(region[0])).toBe(false);
    // The rail holds the question field, the protocol field and the prepared list.
    expect(questionField(main)).toBeDefined();
    expect(protocolField(main)).toBeDefined();
    const list = rail[0].classed("sx-ask-list");
    expect(list).toHaveLength(1);
    const listText = list[0].textContent;
    expect(listText).toContain(PREPARED_HEADING);
    expect(listText).toContain(PREPARED_LABEL);
    expect(answerRegion(main)).toBeDefined();
  });

  testT("each prepared entry is listed under the group of its declared protocol", { timeout: LONG }, async () => {
    const harness = makeHarness();
    await openAsk(harness, askData());
    const main = mainOf(harness);
    const groups = main.classed("sx-ask-group");
    expect(groups).toHaveLength(2);
    const held = new Map<string, string[]>();
    for (const group of groups) {
      const title = group.walk().find((el) => el.tag === "h3")!.textContent;
      held.set(
        title,
        group
          .walk()
          .filter((el) => el.attr("data-act") === "prepared-answer")
          .map((el) => el.textContent),
      );
    }
    expect(held.get("Marinade")).toEqual([QUESTION_M1, QUESTION_M2]);
    expect(held.get("Kamino")).toEqual([QUESTION_K1]);
  });

  testT("before any answer is chosen the region waits and holds neither rows nor a refusal nor a selection", { timeout: LONG }, async () => {
    const harness = makeHarness();
    await openAsk(harness, askData());
    const main = mainOf(harness);
    expect(main.textContent).toContain("Choose a prepared question, or type one");
    expect(main.classed("lk-row")).toHaveLength(0);
    expect(refused(main)).toHaveLength(0);
    expect(originBlock(main)).toBeUndefined();
    expect(currentEntries(main)).toHaveLength(0);
    expect(harness.doc.active).toBeNull();
  });

  testT("without a handler the view retains its absence and offers no interactive control", { timeout: LONG }, () => {
    const harness = makeHarness();
    startApp(harness.env({ data: { ...data, mode: "served", positions: null, ask: { enabled: false } } }) as never);
    harness.setHash("#/ask");
    const main = mainOf(harness);
    expect(main.textContent).toContain(ASK_NOT_BUILT);
    expect(main.textContent).not.toContain(PREPARED_HEADING);
    expect(main.walk().filter((el) => el.tag === "button" || el.tag === "input")).toHaveLength(0);
    expect(harness.pinnedGets).toBe(0);
    expect(harness.asks).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* Choosing a prepared answer                                           */
/* ------------------------------------------------------------------ */
describe("activating a prepared entry", () => {
  testT("activating one entry answers from it alone: selected, protocol and question follow, the region is focused and revealed", { timeout: LONG }, async () => {
    const harness = makeHarness();
    await openAsk(harness, askData());
    const main = mainOf(harness);
    const target = entryOf(main, "prep-m2");
    expect(target).toBeDefined();
    // A native button: the browser supplies its Enter and Space activation, and the test
    // fires the click event that activation produces.
    expect(target.tag).toBe("button");
    expect(target.attr("type")).toBe("button");
    target.dispatch("click");
    const after = mainOf(harness);
    // Exactly the chosen entry is the current one.
    const current = currentEntries(after);
    expect(current).toHaveLength(1);
    expect(current[0].attr("data-arg")).toBe("prep-m2");
    expect(current[0].textContent).toBe(QUESTION_M2);
    // Protocol and question follow the entry.
    const selected = protocolField(after)
      .walk()
      .filter((el) => el.tag === "option" && el.attr("selected") !== null)
      .map((el) => el.attr("value"));
    expect(selected).toEqual(["marinade"]);
    expect(questionField(after).attr("value")).toBe(QUESTION_M2);
    // A validated answer is drawn.
    expect(after.classed("lk-row").length).toBeGreaterThan(0);
    expect(refused(after)).toHaveLength(0);
    // Prepared origin, carrying the entry's own label.
    const origin = originBlock(after);
    expect(origin).toBeDefined();
    expect(origin!.classed("sx-label").map((el) => el.textContent)).toEqual([PREPARED_ORIGIN]);
    expect(origin!.textContent).toContain(LABEL_M2);
    expect(origin!.textContent).not.toContain(TYPED_ORIGIN);
    // The region is focused: a keyboard reader lands on the answer.
    expect(harness.doc.active).toBe(answerRegion(after));
    // No request was made for a prepared entry.
    expect(harness.asks).toHaveLength(0);
  });

  testT("entries the receipt gate or the parser refuse draw none of themselves; the valid entry beside them draws", { timeout: LONG }, async () => {
    const harness = makeHarness(
      preparedDocument([
        preparedEntry("prep-bad", "Which receipt is missing?", "marinade", "Fixed script, unresolved", UNRESOLVED_NDJSON),
        preparedEntry("prep-malformed", "Which line breaks the format?", "marinade", "Fixed script, malformed", MALFORMED_NDJSON),
        preparedEntry("prep-good", QUESTION_K1, "kamino", LABEL_K1, VALID_NDJSON()),
      ]),
    );
    await openAsk(harness, askData());
    let main = mainOf(harness);
    // Changing the view's state by selecting entries never bypasses receipt validation.
    entryOf(main, "prep-bad").dispatch("click");
    main = mainOf(harness);
    const unresolvedText = refused(main).map((el) => el.textContent ?? "").join(" ");
    expect(unresolvedText).toContain("view refused:");
    expect(unresolvedText).toContain("unresolved-evidence");
    expect(main.classed("lk-row")).toHaveLength(0);
    // A malformed surface refuses with its own code instead of drawing.
    entryOf(main, "prep-malformed").dispatch("click");
    main = mainOf(harness);
    const malformedText = refused(main).map((el) => el.textContent ?? "").join(" ");
    expect(malformedText).toContain("view refused:");
    expect(malformedText).toContain("schema");
    expect(main.classed("lk-row")).toHaveLength(0);
    // Accepted control: the valid entry beside them draws its rows.
    entryOf(main, "prep-good").dispatch("click");
    main = mainOf(harness);
    expect(refused(main)).toHaveLength(0);
    expect(main.classed("lk-row").length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */
/* Typing a question                                                    */
/* ------------------------------------------------------------------ */
describe("typing a question", () => {
  testT("a typed question keeps the selected protocol, clears the prepared selection and marks the typed origin", { timeout: LONG }, async () => {
    const harness = makeHarness();
    await openAsk(harness, askData());
    let main = mainOf(harness);
    entryOf(main, "prep-m1").dispatch("click");
    main = mainOf(harness);
    expect(currentEntries(main)).toHaveLength(1);
    const field = questionField(main);
    field.value = "What holds the reserve?";
    field.dispatch("keydown", { key: "Enter", preventDefault() {} });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    main = mainOf(harness);
    // One ask, carrying the protocol the prepared selection had chosen.
    expect(harness.asks).toEqual([{ question: "What holds the reserve?", protocol: "marinade" }]);
    // The prepared selection is cleared.
    expect(currentEntries(main)).toHaveLength(0);
    // The typed origin is marked, not the prepared one.
    const origin = originBlock(main)!;
    expect(origin.classed("sx-label").map((el) => el.textContent)).toEqual([TYPED_ORIGIN]);
    expect(origin.textContent).not.toContain(LABEL_M1);
    // The settled answer is drawn and the region is focused and revealed.
    expect(main.classed("lk-row").length).toBeGreaterThan(0);
    expect(refused(main)).toHaveLength(0);
    expect(harness.doc.active).toBe(answerRegion(main));
  });

  testT("a typed reply is drawn only through validation: a refused reply draws none of itself, a benign one draws", { timeout: LONG }, async () => {
    const harness = makeHarness();
    harness.setAskReply({ status: 200, body: UNRESOLVED_NDJSON });
    await openAsk(harness, askData());
    let main = mainOf(harness);
    questionField(main).value = "Who holds this?";
    questionField(main).dispatch("keydown", { key: "Enter", preventDefault() {} });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    main = mainOf(harness);
    expect(refused(main).map((el) => el.textContent ?? "").join(" ")).toContain("unresolved-evidence");
    expect(main.classed("lk-row")).toHaveLength(0);
    expect(harness.doc.active).toBe(answerRegion(main));
    // Accepted control: the same question against a reply the gate accepts draws its rows.
    harness.setAskReply({ status: 200, body: VALID_NDJSON() });
    harness.setHash("#/preflight");
    harness.setHash("#/ask");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    main = mainOf(harness);
    questionField(main).value = "Who holds this?";
    questionField(main).dispatch("keydown", { key: "Enter", preventDefault() {} });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    main = mainOf(harness);
    expect(refused(main)).toHaveLength(0);
    expect(main.classed("lk-row").length).toBeGreaterThan(0);
  });

  testT("initial prepared loading never takes focus, and a late reply after leaving Ask never pulls it back", { timeout: LONG }, async () => {
    const harness = makeHarness();
    const gate = harness.gatePinned();
    const app = startApp(harness.env({ data: askData() }) as never);
    harness.setHash("#/ask");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(answerRegion(mainOf(harness))).toBeDefined();
    expect(harness.doc.active).toBeNull();
    gate.resolve(Response.json(preparedDocument()));
    await app.settled();
    expect(harness.doc.active).toBeNull();
    expect(mainOf(harness).classed("sx-ask-group").length).toBeGreaterThan(0);
    // A typed ask whose reply arrives after the reader has left the view.
    const askGate = harness.gateAsk();
    const field = questionField(mainOf(harness));
    field.value = "What holds the reserve?";
    field.dispatch("keydown", { key: "Enter", preventDefault() {} });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(harness.asks).toHaveLength(1);
    harness.setHash("#/preflight");
    expect(mainOf(harness).textContent).toContain("claimed intent");
    askGate.resolve(new Response(VALID_NDJSON(), { status: 200, headers: { "content-type": "application/x-ndjson" } }));
    await app.settled();
    const main = mainOf(harness);
    expect(harness.doc.active).toBeNull();
    expect(main.textContent).toContain("claimed intent");
    expect(main.classed("lk-row")).toHaveLength(0);
  });

  testT("loading and readiness boundaries stop accidental asks; readiness lets exactly one through", { timeout: LONG }, async () => {
    const harness = makeHarness();
    const gate = harness.gatePinned();
    const app = startApp(harness.env({ data: askData() }) as never);
    harness.setHash("#/ask");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    let main = mainOf(harness);
    // While the prepared document loads, neither the field nor the button sends anything.
    expect(questionField(main).attr("disabled")).toBe("");
    expect(main.walk().find((el) => el.attr("data-act") === "ask")!.attr("disabled")).toBe("");
    questionField(main).value = "What holds the reserve?";
    questionField(main).dispatch("keydown", { key: "Enter", preventDefault() {} });
    main.walk().find((el) => el.attr("data-act") === "ask")!.dispatch("click");
    expect(harness.asks).toHaveLength(0);
    gate.resolve(Response.json(preparedDocument()));
    await app.settled();
    main = mainOf(harness);
    // An empty question sends nothing even when ready.
    questionField(main).value = "";
    questionField(main).dispatch("keydown", { key: "Enter", preventDefault() {} });
    expect(harness.asks).toHaveLength(0);
    expect(questionField(main).attr("disabled")).toBeNull();
    // Accepted control: a ready view with a question sends exactly one ask.
    questionField(main).value = "What holds the reserve?";
    questionField(main).dispatch("keydown", { key: "Enter", preventDefault() {} });
    await app.settled();
    expect(harness.asks).toEqual([{ question: "What holds the reserve?", protocol: "marinade" }]);
  });
});

/* Draft controls across redraws */
describe("Ask drafts survive a redraw", () => {
  const selectedProtocol = (main: FakeElement): (string | null)[] => protocolField(main).walk()
    .filter((el) => el.tag === "option" && el.attr("selected") !== null)
    .map((el) => el.attr("value"));

  testT("unsubmitted protocol and question drafts survive redraw and a route round-trip", { timeout: LONG }, async () => {
    const harness = makeHarness();
    const app = startApp(harness.env({ data: askData() }) as never);
    harness.setHash("#/ask");
    await app.settled();
    const protocol = protocolField(mainOf(harness));
    protocol.value = "kamino";
    protocol.dispatch("change");
    const question = questionField(mainOf(harness));
    question.value = "What holds the reserve?";
    question.dispatch("input");
    app.draw();
    expect(selectedProtocol(mainOf(harness))).toEqual(["kamino"]);
    expect(questionField(mainOf(harness)).attr("value")).toBe("What holds the reserve?");
    harness.setHash("#/preflight");
    harness.setHash("#/ask");
    expect(selectedProtocol(mainOf(harness))).toEqual(["kamino"]);
    expect(questionField(mainOf(harness)).attr("value")).toBe("What holds the reserve?");
    expect(harness.asks).toEqual([]);
  });

  testT("a protocol chosen during an answer survives completion and is used by the next ask", { timeout: LONG }, async () => {
    const harness = makeHarness();
    const app = startApp(harness.env({ data: askData() }) as never);
    harness.setHash("#/ask");
    await app.settled();
    const gate = harness.gateAsk();
    questionField(mainOf(harness)).value = "Who controls the reward fee?";
    questionField(mainOf(harness)).dispatch("keydown", { key: "Enter", preventDefault() {} });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const protocol = protocolField(mainOf(harness));
    protocol.value = "kamino";
    protocol.dispatch("change");
    gate.resolve(new Response(VALID_NDJSON(), { headers: { "content-type": "application/x-ndjson" } }));
    await app.settled();
    expect(selectedProtocol(mainOf(harness))).toEqual(["kamino"]);
    questionField(mainOf(harness)).value = "What holds the reserve?";
    questionField(mainOf(harness)).dispatch("keydown", { key: "Enter", preventDefault() {} });
    await app.settled();
    expect(harness.asks.map((call) => call.protocol)).toEqual(["marinade", "kamino"]);
  });
});
