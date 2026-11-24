/**
 * Regression tests of the desk's outgoing guard: a held quantity stops a question whose number holds the
 * quantity's significant digits, in any notation and any script, and a question without those digits passes.
 * The guard fails closed, so a number of another value with the same digits is stopped too. The last block
 * starts the desk server on a hand-built state and checks which previous response id a follow-up may carry.
 * Offline: the guard is a pure function, the agent is a function of this file, and the only connection opened
 * is to the desk server this file starts on the loopback.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { guardHit, guardTerms, type GuardTerms } from "../src/desk/guard";
import { MAX_ISSUED_RESPONSE_IDS, startDesk, type DeskServer } from "../src/desk/server";
import type { DeskDeps, DeskState } from "../src/desk/state";

const held = (...quantities: string[]): GuardTerms => ({ substrings: [], quantities });

/** Each row: the held quantity, then texts that must stop. */
const STOP: Array<[title: string, quantity: string, texts: string[]]> = [
  ["a leading decimal point", "0.5", [".5", "held .5 near", "is it.5?", "(.5)", ".50", ".5e0", ".05e1", ".005E+2"]],
  ["a leading decimal comma", "0.5", [",5", "held ,5 near", ",50", ",05e1"]],
  ["a leading decimal mark with a power of ten", "1250.5", [".12505e4", ",12505e4", ".12505E+4", ".012505e5", "x.12505e4", ".12505e−4 and .12505e4"]],
  ["a leading full-width decimal mark", "0.5", ["．５", "，５"]],
  ["a trailing decimal point", "1250", ["1250. near", "1250."]],
  ["scientific notation", "1250.5", ["1.2505e3", "1.2505E3", "1.2505e+3", "1.2505e03", "12505e-1", "12505e−1", "1250.5e+0", "1250.5e0", "0.12505e4", "125050e-2"]],
  ["scientific notation of a fraction", "0.5", ["5e-1", "50e-2", "0.05e1", "0.5e0"]],
  ["scientific notation of a whole number", "1250", ["1.25e3", "125e1", "12500e-1", ".125e4"]],
  ["a sign", "1250.5", ["+1250.5", "-1250.5", "−1250.5"]],
  ["space grouping", "1250.5", ["1 250.5", "1 250.5", "1 250.5", "1 250.5", "1 250.5", "1 250.5", "1　250.5", "1 250.5", "1 250.5"]],
  ["apostrophe grouping", "1250.5", ["1'250.5", "1’250.5", "1‘250.5", "1ʼ250.5"]],
  ["comma and underscore grouping", "1250.5", ["1,250.5", "1_250.5", "0,000.5 and 1,250.5"]],
  ["grouped zeros before a fraction", "0.5", ["0,000.5", "0 000.5", "000.5"]],
  ["a decimal comma", "1250.5", ["1250,5", "1250,50"]],
  ["European grouping", "1250.5", ["1.250,5", "1 250,5", "1 250,5", "1'250,5"]],
  ["European grouping of millions", "1234567.89", ["1.234.567,89", "1,234,567.89", "1 234 567,89", "1.23456789e6"]],
  ["full-width digits", "1250.5", ["１２５０．５", "１,２５０.５", "１２５０,５"]],
  ["a zero-width character inside", "1250.5", ["12​50.5", "1250‍.5", "1250.‌5", "1⁠25﻿0.5", "​.12505e4", ".​12505e4"]],
  ["leading zeros", "1250.5", ["01250.5", "0001250.5", "00.12505e4"]],
  ["trailing zeros", "1250.5", ["1250.50", "1250.5000", "1250.50e0"]],
  ["a number beside other numbers", "1250.5", ["3 1250.5", "on 2026-11-12 it was 1250.5 near", "1250.5, 7 and 9"]],
  ["Arabic-Indic digits and the Arabic decimal mark", "1250.5", ["١٢٥٠٫٥", "١٬٢٥٠٫٥", "held ١٢٥٠.٥ near"]],
  ["Extended Arabic-Indic digits", "1250.5", ["۱۲۵۰٫۵", "۱۲۵۰.۵"]],
  ["Devanagari digits", "1250.5", ["१२५०.५", "१,२५०.५"]],
  ["digits of other scripts", "1250.5", ["১২৫০.৫", "๑๒๕๐.๕", "᠑᠒᠕᠐.᠕", "𝟏𝟐𝟓𝟎.𝟓", "①②⑤⓪.⑤"]],
  ["digits of mixed scripts", "1250.5", ["1२5٠.۵", "12５০.5"]],
  ["a stray space beside the decimal mark", "1250.5", ["1250 .5", "1250. 5", "1250 . 5", "1250\t.5", "1250.\n5"]],
  ["more than one space between groups", "1250.5", ["1  250.5", "1   250 . 5", "1 2 5 0 . 5"]],
  ["a power of ten written out", "1250.5", ["1.2505 × 10³", "1.2505 x 10^3", "1.2505 * 10^3", "1.2505×10^3", "1.2505 ⋅ 10³", "12505 × 10⁻¹"]],
  ["a space inside the power of ten", "1250.5", ["1.2505e +3", "1.2505 e3", "1.2505 e 3", "1.2505 E + 3", "12505 e -1"]],
  ["punctuation between the digits", "1250.5", ["1250·5", "1250-5", "1250/5", "(1250).5", "1250:5", "1-2-5-0-5"]],
  ["a combining mark on a digit", "1250.5", ["1̲2̲5̲0̲.5̲", "1️⃣250.5"]],
  ["a number of another value with the same digits", "1250.5", ["12505", "125.05", "1.2505e2", "0.0012505", "9125059", "1250, 5 and 7"]],
  ["one significant digit stops every number with that digit", "500", ["5", "0.5", "rule 15", "on 2026-11-05", "5e2", "half of 1000 is 5 hundred"]],
];

describe("the outgoing guard stops a held quantity", () => {
  for (const [title, quantity, texts] of STOP) {
    test(`${title} (${quantity})`, () => {
      const terms = held(quantity);
      for (const text of texts) expect([text, guardHit(text, terms)]).toEqual([text, true]);
    });
  }

  test("held with leading or trailing zeros of its own", () => {
    for (const quantity of ["01250.50", "1250.5", "0.50", "00.5"]) {
      const terms = held(quantity);
      const texts = quantity.includes("1250") ? ["1250.5", ".12505e4", "1.250,5"] : [".5", ",5", "5e-1", "0.5"];
      for (const text of texts) expect([quantity, text, guardHit(text, terms)]).toEqual([quantity, text, true]);
    }
  });

  test("held zero", () => {
    for (const text of ["0", ".0", "0.00", "0e5", "٠", "10"]) expect([text, guardHit(text, held("0"))]).toEqual([text, true]);
    for (const text of ["no number here", "1.5"]) expect([text, guardHit(text, held("0"))]).toEqual([text, false]);
  });

  test("through guardTerms, from the positions of a state", () => {
    const state = {
      addresses: [],
      positions: [
        { position: { id: "p-one", subject: "near:token:example", quantity: "1250.50" } },
        { position: { id: "p-two", subject: "near:token:example", quantity: "0.5" } },
      ],
    } as unknown as DeskState;
    const terms = guardTerms(state);
    expect(terms.quantities.sort()).toEqual(["0.5", "1250.5"]);
    for (const text of [".12505e4", ",12505e4", "held .5 near", "held ,5 near", "1250,5", "5e-1", "P-ONE"]) {
      expect([text, guardHit(text, terms)]).toEqual([text, true]);
    }
  });
});

describe("the outgoing guard passes a question without a held value", () => {
  const terms = held("1250.5");
  const PASS = [
    "what is the oracle of usdc?",
    "explain rule concentration-max-share further",
    "why does rule R3 flag usdc.e on 2026-11-12?",
    "is 1250.6 or 1251 or 2505 or 125.06 or 1.2506e3 held?",
    "1250 and 5",
    "1250 point 5",
  ];
  for (const text of PASS) {
    test(text, () => {
      expect(guardHit(text, terms)).toBe(false);
    });
  }

  test("numbers without the significant digits of a held quantity", () => {
    const both = held("1250.5", "0.75");
    for (const text of [".6", ",51", ",12506e4", ".1251", "v.7", "2 5", "١٢٥١", "2x5"]) {
      expect([text, guardHit(text, both)]).toEqual([text, false]);
    }
  });
});

describe("the outgoing guard stops by digits, not by value", () => {
  test("stopped by design: 'is 1250.6 or 12505 or 125.05 or 1.2505e2 held?' holds the digits 12505 of 1250.5, though no number in it equals 1250.5", () => {
    expect(guardHit("is 1250.6 or 12505 or 125.05 or 1.2505e2 held?", held("1250.5"))).toBe(true);
  });

  test("stopped by design: a number that starts with a decimal mark and holds the digits of a held quantity, whatever its power of ten", () => {
    const both = held("1250.5", "0.5");
    for (const text of [".12505e3", ",51", ",12506e4", ".1251"]) expect([text, guardHit(text, both)]).toEqual([text, true]);
  });
});

describe("known limits of the outgoing guard: notations of a held quantity that pass", () => {
  const terms = held("1250.5");

  test("known limit: a vulgar fraction passes ('1250½' is read as 1250 1/2)", () => {
    for (const text of ["1250½", "1250 ½", "1250 1/2", "2501/2"]) expect([text, guardHit(text, terms)]).toEqual([text, false]);
  });

  test("known limit: a number in words passes", () => {
    for (const text of ["twelve hundred and fifty point five", "1250 and a half", "one two five zero five"]) {
      expect([text, guardHit(text, terms)]).toEqual([text, false]);
    }
  });

  test("known limit: numerals that are not decimal digits pass", () => {
    for (const text of ["MCCL.V", "❶❷❺⓿.❺"]) expect([text, guardHit(text, terms)]).toEqual([text, false]);
  });
});

describe("the outgoing guard is fast on adversarial input", () => {
  const terms = held("1250.5", "0.5", "123456789012345678.123456789012345678");
  const LIMIT = 4000;
  const fill = (unit: string): string => unit.repeat(Math.ceil(LIMIT / unit.length)).slice(0, LIMIT);
  const QUESTIONS: Array<[string, string]> = [
    ["single digits joined by points", fill("1.")],
    ["leading decimal marks", fill(".1,")],
    ["zeros joined by commas", fill("0,")],
    ["digit groups joined by spaces with a power of ten", `${fill("12 ").slice(0, LIMIT - 4).trimEnd()}e9`],
    ["one long row of digits", fill("9")],
    ["digits of another script", fill("١٢")],
    ["digits of many scripts joined by signs", fill("१ × ٢^３ + ")],
    ["spaces and marks without a digit", fill(" .,'-+×e")],
    ["combining marks on every digit", fill("1̲")],
  ];
  for (const [title, question] of QUESTIONS) {
    test(`${title}, ${LIMIT} characters`, () => {
      expect(question.length).toBeLessThanOrEqual(LIMIT);
      const started = performance.now();
      const hit = guardHit(question, terms);
      const elapsed = performance.now() - started;
      expect(hit).toBe(false);
      expect(elapsed).toBeLessThan(2000);
    });
  }

  test(`a long held quantity whose digits the question almost repeats, ${LIMIT} characters`, () => {
    const almost = held(`${"1".repeat(1999)}2`, `0.${"12".repeat(900)}3`);
    for (const question of [fill("1"), fill("1."), fill("12"), fill("1 2,")]) {
      const started = performance.now();
      const hit = guardHit(question, almost);
      const elapsed = performance.now() - started;
      expect(hit).toBe(false);
      expect(elapsed).toBeLessThan(2000);
    }
  });
});

describe("a follow-up carries only a response id the agent issued to this server", () => {
  // Held quantities whose significant digits are 5 and 8: with the digit guard, most response ids hold one.
  const state = {
    policy: { rules: [] },
    snapshotIds: [],
    store: { receipt: () => undefined },
    addresses: [],
    positions: [
      { position: { id: "p-five", subject: "near:token:example", quantity: "0.5" } },
      { position: { id: "p-eight", subject: "near:token:example", quantity: "800" } },
    ],
  } as unknown as DeskState;
  const sent: Array<Record<string, unknown>> = [];
  let nextId = "resp_58a5f8";
  const agent = (async (_url: unknown, init?: { body?: unknown }) => {
    sent.push(JSON.parse(String(init?.body)));
    return Response.json({ id: nextId, output_text: "an answer" });
  }) as unknown as typeof fetch;
  const deps: DeskDeps = {
    readPositions: async () => { throw new Error("no reader in this test"); },
    env: { LINCHPIN_IRONCLAW_URL: "http://127.0.0.1:9", LINCHPIN_IRONCLAW_TOKEN: "guard-test-agent-token" },
    fetch: agent,
    now: () => 0,
  };
  let server: DeskServer;
  const ask = (body: unknown): Promise<Response> =>
    fetch(`${server.origin}/api/desk/ask`, { method: "POST", headers: { "x-desk-token": server.token, origin: server.origin, "content-type": "application/json" }, body: JSON.stringify(body) });

  beforeAll(async () => {
    server = await startDesk({ state, deps, port: 0, log: () => undefined });
  }, 60_000);

  afterAll(async () => {
    await server.stop();
  });

  test("an id is refused with 400 before the agent has answered, and nothing is sent", async () => {
    const res = await ask({ question: "a follow-up", previousResponseId: "resp_58a5f8" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad-request" });
    expect(sent).toHaveLength(0);
  }, 30_000);

  test("the id the agent returned is sent with a follow-up, though it holds the digits of held quantities", async () => {
    const first = await ask({ question: "what is the oracle of usdc?" });
    expect(first.status).toBe(200);
    expect((await first.json()).responseId).toBe("resp_58a5f8");
    expect(guardHit("resp_58a5f8", guardTerms(state))).toBe(true);
    sent.length = 0;
    nextId = "resp_second_85";
    const followUp = await ask({ question: "and of usdt?", previousResponseId: "resp_58a5f8" });
    expect(followUp.status).toBe(200);
    expect(sent).toEqual([{ model: "default", input: "and of usdt?", stream: false, previous_response_id: "resp_58a5f8" }]);
  }, 30_000);

  test("a made-up id is refused with 400, and nothing is sent", async () => {
    sent.length = 0;
    for (const previousResponseId of ["resp_made_up", "resp_58a5f9", "RESP_58A5F8", "resp_58a5f8 ", "", 58, null, ["resp_58a5f8"]]) {
      const res = await ask({ question: "a follow-up", previousResponseId });
      expect([previousResponseId, res.status]).toEqual([previousResponseId, 400]);
      expect(await res.json()).toEqual({ error: "bad-request" });
    }
    expect(sent).toHaveLength(0);
  }, 30_000);

  test("the question of a follow-up is guarded: a held value in it answers 422 and nothing is sent", async () => {
    sent.length = 0;
    for (const question of ["is 0.5 held?", "what about p-eight?", "rule 8"]) {
      const res = await ask({ question, previousResponseId: "resp_second_85" });
      expect([question, res.status]).toEqual([question, 422]);
    }
    expect(sent).toHaveLength(0);
  }, 30_000);

  test("an id the agent returns in another form is not kept", async () => {
    nextId = "resp with a space";
    expect((await ask({ question: "another question" })).status).toBe(200);
    sent.length = 0;
    expect((await ask({ question: "a follow-up", previousResponseId: "resp with a space" })).status).toBe(400);
    expect(sent).toHaveLength(0);
  }, 30_000);

  test("the server keeps the last ids only: the oldest is refused once more than the limit were issued", async () => {
    for (let at = 0; at < MAX_ISSUED_RESPONSE_IDS; at++) {
      nextId = `resp_fill_${at}`;
      expect((await ask({ question: "another question" })).status).toBe(200);
    }
    sent.length = 0;
    for (const previousResponseId of ["resp_58a5f8", "resp_second_85"]) {
      expect([previousResponseId, (await ask({ question: "a follow-up", previousResponseId })).status]).toEqual([previousResponseId, 400]);
    }
    expect(sent).toHaveLength(0);
    nextId = "resp_last";
    expect((await ask({ question: "a follow-up", previousResponseId: "resp_fill_0" })).status).toBe(200);
    expect((await ask({ question: "a follow-up", previousResponseId: `resp_fill_${MAX_ISSUED_RESPONSE_IDS - 1}` })).status).toBe(200);
    expect(sent.map((body) => body.previous_response_id)).toEqual(["resp_fill_0", `resp_fill_${MAX_ISSUED_RESPONSE_IDS - 1}`]);
  }, 60_000);
});
