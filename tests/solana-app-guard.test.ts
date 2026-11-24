import { expect, test } from "bun:test";
import { PrivateTerms } from "../src/apps/solana/guard";
import type { ReadData } from "../src/apps/solana/model";
import type { ResultSet } from "../src/ui/types";

function remembered(...quantities: string[]): PrivateTerms {
  const list: ResultSet = {
    resultId: "positions", shape: "table", columns: [], coverage: "mapped", coverageNotes: [], truncated: false,
    rows: quantities.map((quantity, at) => ({
      rowKind: "reader", key: `position-${at}`, values: { quantity }, factIds: [], bases: [],
      evidenceIds: [], blockOrSlot: null, asOf: null, snapshotIds: [],
    })),
  };
  const read: ReadData = {
    source: "constructed", constructed: true, address: "", meta: { snapshotIds: [] }, list,
    notRead: { ...list, resultId: "not-read", shape: "unknowns", rows: [] }, receipts: {}, sheets: [],
  };
  const guard = new PrivateTerms();
  guard.add(read);
  return guard;
}

test("equivalent exact decimals are private without floating-point rounding", () => {
  const guard = remembered("739172635000000123");
  for (const value of [
    "739172635000000123", "+739172635000000123.000", "000739172635000000123.0",
    "7.39172635000000123e17", "7.39172635000000123E+17", "7391726350000001230e-1",
    "73917263500000012.3e1", ".739172635000000123e18",
  ]) expect(guard.hit(`held: ${value}`), value).toBe(true);
  for (const value of [
    "1739172635000000123", "7391726350000001231", "739172635000000124",
    "7.39172635000000124e17", "7.39172635000000123e16", "-739172635000000123",
  ]) expect(guard.hit(`held: ${value}`), value).toBe(false);
});

test("JSON atoms preserve numeric precision and decode strings, nested values and keys", () => {
  const guard = remembered("739172635000000123");
  for (const json of [
    '{"amount":739172635000000123}',
    '{"amount":739172635000000123.0}',
    '{"amount":7.39172635000000123e17}',
    '{"nested":[{"amount":7391726350000001230e-1}]}',
    '{"question":"held: 7.39172635000000123e17"}',
    JSON.stringify({ "held: 7.39172635000000123e17": "details" }),
    '{"question":"held: \\u0037.39172635000000123e17"}',
  ]) expect(guard.hitJson(json), json).toBe(true);
  expect(guard.hitJson('{"amount":739172635000000124}')).toBe(false);
  expect(guard.hitJson('{"amount":1739172635000000123}')).toBe(false);
});

test("escape source fragments are not treated as decoded numeric values", () => {
  const guard = remembered("0", "3", "37");
  expect(guard.hitJson('{"question":"\\u0037\\u0033\\u0039"}')).toBe(false); // decoded 739
  expect(guard.hitJson('{"question":"\\u0033"}')).toBe(true); // decoded 3
  expect(guard.hitJson('{"question":"a \\"quoted\\" value 739"}')).toBe(false);
});

test("signed quantities and zero normalize without conflating different values", () => {
  const negative = remembered("-125.000");
  for (const value of ["-125", "-1.25e2", "-.125e3"]) expect(negative.hit(value)).toBe(true);
  expect(negative.hit("125")).toBe(false);
  expect(negative.hit("-1250")).toBe(false);
  const zero = remembered("0.000");
  for (const value of ["0", "-0", "+0.000e999999999999999999", "0e-999999999999999999"]) expect(zero.hit(value)).toBe(true);
  expect(zero.hit("1e-999999999999999999")).toBe(false);
});

test("large exponents remain bounded representations rather than expanded numbers", () => {
  const guard = remembered("1");
  const exponent = "9".repeat(8000);
  expect(guard.hitJson(`{"question":"2e${exponent}"}`)).toBe(false);
  expect(guard.hitJson('{"amount":2e9007199254740993}')).toBe(false);
  expect(guard.hitJson(JSON.stringify({ question: `1${"0".repeat(8000)}1` }))).toBe(false);
  expect(guard.hitJson('{"question":"1e000000000000000000000000"}')).toBe(true);
  expect(remembered("0").hitJson(`{"amount":0e${exponent}}`)).toBe(true);
}, 10_000);
