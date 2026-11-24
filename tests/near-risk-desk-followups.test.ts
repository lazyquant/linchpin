/**
 * Regression tests of two follow-ups to the risk desk v2 (run 055).
 * 1. The page drops a follow-up id the server refuses, so one refusal does not fail every later question.
 *    The rule is the pure function the page script calls; the second block plays it against the desk server
 *    across a restart and across the server's limit of kept ids.
 * 2. The marks legend keeps a mark word whole: the desk stylesheet holds the rule, for the column the legend has.
 * Offline: the agent is a function of this file, and the only connection opened is to the desk server this file
 * starts on the loopback.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import { nextPreviousResponseId } from "../src/desk/followup";
import { MAX_ISSUED_RESPONSE_IDS, startDesk, type DeskServer } from "../src/desk/server";
import type { DeskDeps, DeskState } from "../src/desk/state";
import { DESK_STRINGS } from "../src/desk/strings";

const source = (name: string): Promise<string> => Bun.file(fileURLToPath(new URL(`../src/desk/${name}`, import.meta.url))).text();

describe("the id the next question carries", () => {
  test("an answer with an id is followed", () => {
    expect(nextPreviousResponseId(null, 200, "resp_a")).toBe("resp_a");
    expect(nextPreviousResponseId("resp_a", 200, "resp_b")).toBe("resp_b");
  });

  test("an answer without an id keeps the id that was sent", () => {
    for (const returned of [null, undefined, 7, ["resp_b"]]) {
      expect(nextPreviousResponseId("resp_a", 200, returned)).toBe("resp_a");
      expect(nextPreviousResponseId(null, 200, returned)).toBeNull();
    }
  });

  test("400 on a question that carried an id drops the id", () => {
    expect(nextPreviousResponseId("resp_a", 400, null)).toBeNull();
    expect(nextPreviousResponseId("resp_a", 400, undefined)).toBeNull();
  });

  test("400 on a question that carried no id leaves none", () => {
    expect(nextPreviousResponseId(null, 400, null)).toBeNull();
  });

  test("every other failure keeps the id: the conversation is still there", () => {
    for (const status of [0, 403, 409, 422, 500, 502, 503, 504]) {
      expect([status, nextPreviousResponseId("resp_a", status, null)]).toEqual([status, "resp_a"]);
      expect([status, nextPreviousResponseId(null, status, null)]).toEqual([status, null]);
    }
  });

  test("an id in the body of a failure is not taken", () => {
    expect(nextPreviousResponseId("resp_a", 502, "resp_b")).toBe("resp_a");
    expect(nextPreviousResponseId("resp_a", 400, "resp_b")).toBeNull();
  });

  test("the page script sets its id by this rule and nowhere else, and sends the id it held", async () => {
    const client = await source("client.ts");
    expect(client).toContain('import { nextPreviousResponseId } from "./followup";');
    const assignments = client.match(/\bpreviousResponseId = [^\n]*/g) ?? [];
    expect(assignments).toHaveLength(1);
    expect(assignments[0]).toStartWith("previousResponseId = nextPreviousResponseId(sent, answer.status, ");
    expect(client).toContain("const sent = previousResponseId;");
    expect(client).toContain("sent === null ? request : { ...request, previousResponseId: sent }");
  });
});

describe("a page that follows the rule recovers from a refused follow-up id", () => {
  const state = { policy: { rules: [] }, snapshotIds: [], store: { receipt: () => undefined }, addresses: [], positions: [] } as unknown as DeskState;
  const sent: Array<Record<string, unknown>> = [];
  let issued = 0;
  const agent = (async (_url: unknown, init?: { body?: unknown }) => {
    sent.push(JSON.parse(String(init?.body)));
    return Response.json({ id: `resp_n${issued++}`, output_text: "an answer" });
  }) as unknown as typeof fetch;
  const deps: DeskDeps = {
    readPositions: async () => { throw new Error("no reader in this test"); },
    env: { LINCHPIN_IRONCLAW_URL: "http://127.0.0.1:9", LINCHPIN_IRONCLAW_TOKEN: "followup-test-agent-token" },
    fetch: agent,
    now: () => 0,
  };
  const servers: DeskServer[] = [];
  const launch = async (): Promise<DeskServer> => {
    const server = await startDesk({ state, deps, port: 0, log: () => undefined });
    servers.push(server);
    return server;
  };

  /** What the page script does with one question: send the id it holds, then set the id by the rule. */
  function page() {
    let previousResponseId: string | null = null;
    return {
      held: () => previousResponseId,
      async ask(server: DeskServer, question: string): Promise<number> {
        const carried = previousResponseId;
        const response = await fetch(`${server.origin}/api/desk/ask`, {
          method: "POST",
          headers: { "x-desk-token": server.token, origin: server.origin, "content-type": "application/json" },
          body: JSON.stringify(carried === null ? { question } : { question, previousResponseId: carried }),
        });
        const body = (await response.json().catch(() => null)) as { responseId?: unknown } | null;
        previousResponseId = nextPreviousResponseId(carried, response.status, response.status === 200 ? body?.responseId : null);
        return response.status;
      },
    };
  }

  afterAll(async () => {
    await Promise.all(servers.map((server) => server.stop()));
  });

  test("after a desk restart: one question fails with 400, nothing is resent, and the next starts a new conversation", async () => {
    const tab = page();
    const before = await launch();
    expect(await tab.ask(before, "a first question")).toBe(200);
    const stale = tab.held();
    expect(stale).toMatch(/^resp_n\d+$/);
    expect(await tab.ask(before, "a follow-up")).toBe(200);
    expect(sent.at(-1)).toEqual({ model: "default", input: "a follow-up", stream: false, previous_response_id: stale });
    const held = tab.held();
    await before.stop();

    // A new server process issued none of the ids the page holds.
    const after = await launch();
    sent.length = 0;
    expect(await tab.ask(after, "a question after the restart")).toBe(400);
    expect(sent).toHaveLength(0);
    expect(held).not.toBeNull();
    expect(tab.held()).toBeNull();

    expect(await tab.ask(after, "the next question")).toBe(200);
    expect(sent).toEqual([{ model: "default", input: "the next question", stream: false }]);
    const fresh = tab.held();
    expect(fresh).not.toBeNull();
    expect(fresh).not.toBe(held);
    expect(await tab.ask(after, "and its follow-up")).toBe(200);
    expect(sent.at(-1)).toEqual({ model: "default", input: "and its follow-up", stream: false, previous_response_id: fresh });
  }, 60_000);

  test("without the rule the refusal repeats: the same stale id answers 400 every time", async () => {
    const server = await launch();
    sent.length = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await fetch(`${server.origin}/api/desk/ask`, {
        method: "POST",
        headers: { "x-desk-token": server.token, origin: server.origin, "content-type": "application/json" },
        body: JSON.stringify({ question: "a follow-up", previousResponseId: "resp_n0" }),
      });
      expect(response.status).toBe(400);
    }
    expect(sent).toHaveLength(0);
  }, 60_000);

  test("after the id fell out of the server's kept ids: one 400, then a new conversation", async () => {
    const server = await launch();
    const tab = page();
    const other = page();
    expect(await tab.ask(server, "a first question")).toBe(200);
    // Another tab of the same desk asks until the first tab's id is no longer kept.
    for (let at = 0; at < MAX_ISSUED_RESPONSE_IDS; at++) {
      expect(await other.ask(server, "another question")).toBe(200);
    }
    sent.length = 0;
    expect(await tab.ask(server, "a late follow-up")).toBe(400);
    expect(sent).toHaveLength(0);
    expect(tab.held()).toBeNull();
    expect(await tab.ask(server, "the next question")).toBe(200);
    expect(sent).toEqual([{ model: "default", input: "the next question", stream: false }]);
    expect(tab.held()).not.toBeNull();
  }, 60_000);

  test("a question the guard stops keeps the id, and the follow-up after it still carries it", async () => {
    const guarded = { ...(state as unknown as Record<string, unknown>), positions: [{ position: { id: "p-held", subject: "near:token:example", quantity: "1250.5" } }] } as unknown as DeskState;
    const server = await startDesk({ state: guarded, deps, port: 0, log: () => undefined });
    servers.push(server);
    const tab = page();
    expect(await tab.ask(server, "a first question")).toBe(200);
    const id = tab.held();
    sent.length = 0;
    expect(await tab.ask(server, "is 1250.5 held?")).toBe(422);
    expect(tab.held()).toBe(id);
    expect(await tab.ask(server, "a follow-up")).toBe(200);
    expect(sent).toEqual([{ model: "default", input: "a follow-up", stream: false, previous_response_id: id }]);
  }, 60_000);
});

describe("the marks legend keeps a mark word whole", () => {
  /** The declarations of the first rule of the stylesheet whose selector list holds `selector`. */
  function declarationsOf(css: string, selector: string): string | null {
    for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selectors = match[1].replace(/\/\*[\s\S]*?\*\//g, "").split(",").map((item) => item.trim().replace(/\s+/g, " "));
      if (selectors.includes(selector)) return match[2];
    }
    return null;
  }

  const markCell = `.desk-view .lk-table td[data-label="${DESK_STRINGS.colMark}"] .lk-value`;

  test("the legend's mark column is the column the rule names", async () => {
    const surfaces = await source("surfaces.ts");
    expect(surfaces).toContain('table("legend", [[S.colMark, "label"], [S.colStandsFor, "note"]]');
    expect(DESK_STRINGS.colMark).toMatch(/^[a-z ]+$/);
  });

  test("desk.css breaks a mark between words only, and outranks the rule that lets a value break anywhere", async () => {
    const css = await source("desk.css");
    const anywhere = declarationsOf(css, ".desk-view .lk-table .lk-value");
    expect(anywhere).toMatch(/overflow-wrap:\s*anywhere/);
    const mark = declarationsOf(css, markCell);
    expect(mark).not.toBeNull();
    expect(mark).toMatch(/overflow-wrap:\s*normal/);
    // A mark of several words may still wrap between them, so the rule does not forbid wrapping.
    expect(mark).not.toMatch(/white-space|word-break/);
    // The selector is the general rule's plus a cell and an attribute, so it wins wherever it stands in the file.
    expect(markCell.startsWith(".desk-view .lk-table ")).toBe(true);
    expect(markCell.endsWith(" .lk-value")).toBe(true);
  });

  test("the served stylesheet holds the rule after the kit's rules", async () => {
    const state = { policy: { rules: [] }, snapshotIds: [], store: { receipt: () => undefined }, addresses: [], positions: [] } as unknown as DeskState;
    const server = await startDesk({ state, deps: { readPositions: async () => { throw new Error("no reader in this test"); }, env: {}, now: () => 0 }, port: 0, log: () => undefined });
    try {
      const served = await (await fetch(`${server.origin}/desk.css`)).text();
      expect(declarationsOf(served, markCell)).toMatch(/overflow-wrap:\s*normal/);
      expect(served.indexOf(markCell)).toBeGreaterThan(served.indexOf(".lk-table td {"));
    } finally {
      await server.stop();
    }
  }, 60_000);
});
