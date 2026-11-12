import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonical, sha256 } from "../../chain/evidence";
import type { EvidenceReceipt, Fact, QueryReason } from "../../engine/contracts";
import { ID_PATTERN, SUBJECT_PATTERN, isTime } from "../../engine/queries/request";
import { classifyAsset, loadTokenList } from "./rules";
import type { DryQuoteOptions, DryQuoteRequest, DryQuoteResult, QuoteRecord, QuoteAttempt, QuoteNotRecorded, TokenListEntry } from "./types";
export const ONECLICK_QUOTE_URL = "https://1click.chaindefuser.com/v0/quote";
const HOST = "1click.chaindefuser.com";
const FIGURES = { amountIn: "quote-amount-in", amountOut: "quote-amount-out", minAmountOut: "quote-min-amount-out", timeEstimate: "quote-time-estimate", refundFee: "quote-refund-fee", withdrawFee: "quote-withdraw-fee" } as const;
function placeholder(chain: string): string {
  if (chain === "sol") return "11111111111111111111111111111111";
  if (chain === "near") return "0".repeat(64);
  if (["eth", "arb", "base", "bsc", "pol", "op", "avax", "gnosis"].includes(chain)) return `0x${"0".repeat(40)}`;
  throw new Error(`no placeholder format for ${chain}`);
}
export function buildDryQuoteRequest(i: { originAsset: string; destinationAsset: string; amount: string }, tokens = loadTokenList()): DryQuoteRequest {
  if (!/^[1-9][0-9]*$/.test(i.amount)) throw new Error("Invalid quote amount");
  for (const asset of [i.originAsset, i.destinationAsset]) if (!classifyAsset(asset).parsed) throw new Error("Malformed quote asset");
  const address = (asset: string) => placeholder(tokens.find(t => t.assetId === asset)?.blockchain ?? "unknown");
  return { dry: true, swapType: "EXACT_INPUT", slippageTolerance: 100, originAsset: i.originAsset, destinationAsset: i.destinationAsset, amount: i.amount, depositType: "ORIGIN_CHAIN", refundTo: address(i.originAsset), refundType: "ORIGIN_CHAIN", recipient: address(i.destinationAsset), recipientType: "DESTINATION_CHAIN" };
}
export function dryQuoteRequestSha256(r: DryQuoteRequest): string { return sha256(canonical(r)); }
function validateRequest(r: DryQuoteRequest): void {
  const fields = ["dry", "swapType", "slippageTolerance", "originAsset", "destinationAsset", "amount", "depositType", "refundTo", "refundType", "recipient", "recipientType"];
  if (!r || Object.keys(r).length !== fields.length || !fields.every(k => Object.hasOwn(r, k)) || r.dry !== true || r.swapType !== "EXACT_INPUT" || r.slippageTolerance !== 100 || r.depositType !== "ORIGIN_CHAIN" || r.refundType !== "ORIGIN_CHAIN" || r.recipientType !== "DESTINATION_CHAIN" || !/^[1-9][0-9]*$/.test(r.amount) || !classifyAsset(r.originAsset).parsed || !classifyAsset(r.destinationAsset).parsed || !r.refundTo || !r.recipient) throw new Error("Invalid dry quote request");
  const placeholders = [placeholder("sol"), placeholder("near"), placeholder("eth")];
  if (!placeholders.includes(r.refundTo) || !placeholders.includes(r.recipient)) throw new Error("Only placeholder addresses are accepted");
}
export function loadQuoteNotRecorded(root = "fixtures/near/oneclick"): QuoteNotRecorded {
  const file = join(root, "quote-attempt.json");
  if (!existsSync(file)) return { status: "not recorded", reason: "No recorded dry quote is available for this asset review.", attempt: null };
  const attempt: QuoteAttempt = JSON.parse(readFileSync(file, "utf8"));
  validateRequest(attempt.request);
  if (attempt.version !== 1 || attempt.endpointHost !== HOST || attempt.httpStatus !== 400 || attempt.cause !== "deadline-required" || attempt.responseRetention !== "hash-and-diagnostic-only" || attempt.disposition !== "not-sent-by-decision" || !/^\d{4}-\d{2}-\d{2}$/.test(attempt.recordedDate) || !isTime(attempt.recordedDate + "T00:00:00.000Z") || attempt.requestSha256 !== dryQuoteRequestSha256(attempt.request) || !/^[a-f0-9]{64}$/.test(attempt.responseSha256)) throw new Error("Invalid failed quote attempt");
  return { status: "not recorded", reason: `1Click requires a deadline for dry quotes (HTTP ${attempt.httpStatus}, recorded ${attempt.recordedDate}); not sent by decision`, attempt };
}
type Body = { correlationId: string; timestamp: string; signature: string; quote: Record<string, unknown> };
function bodyError(body: unknown): Extract<DryQuoteResult, {ok:false}>["error"] | null {
  if (!body || typeof body !== "object") return "invalid-response";
  const scan = (v: unknown): string | null => {
    if (!v || typeof v !== "object") return null;
    for (const [k, x] of Object.entries(v)) {
      if (["depositAddress", "depositMemo", "chainDepositAddresses"].includes(k)) return "deposit-address-present";
      if (k === "deadline") return "deadline-present";
      const nested = scan(x); if (nested) return nested;
    } return null;
  };
  const forbidden = scan(body); if (forbidden) return forbidden as "deposit-address-present" | "deadline-present";
  const b = body as Body;
  if (![b.correlationId, b.timestamp, b.signature].every(x => typeof x === "string" && x.length > 0) || !b.quote || typeof b.quote !== "object") return "invalid-response";
  const decimal = (v: unknown) => (typeof v === "string" || typeof v === "number") && /^\d+(?:\.\d+)?$/.test(String(v));
  if (!["amountIn", "amountOut", "minAmountOut", "timeEstimate"].every(k => decimal(b.quote[k]))) return "invalid-response";
  for (const k of ["refundFee", "withdrawFee"]) if (Object.hasOwn(b.quote, k) && !decimal(b.quote[k])) return "invalid-response";
  return null;
}
export function verifyQuoteRecord(r: QuoteRecord): void {
  validateRequest(r.request);
  if (r.version !== 1 || r.endpointHost !== HOST || typeof r.authenticated !== "boolean" || !isTime(r.retrievedAt) || r.httpStatus < 200 || r.httpStatus >= 300 || r.requestSha256 !== dryQuoteRequestSha256(r.request) || r.responseSha256 !== sha256(canonical(r.response)) || bodyError(r.response)) throw new Error("Invalid quote record or hash mismatch");
}
function receipt(r: QuoteRecord): EvidenceReceipt {
  return { id: `oc:${r.requestSha256.slice(0, 40)}`, source: `oneclick:${HOST}`, responseSha256: r.responseSha256, privacy: "public", observation: { chain: "near", network: "mainnet", blockOrSlot: null, blockHash: null, observedAt: r.retrievedAt, retrievedAt: r.retrievedAt, historicalState: "current-only" } };
}
export function quoteFacts(r: QuoteRecord, receipt: EvidenceReceipt): Fact[] {
  const q = (r.response as Body).quote;
  return Object.entries(FIGURES).filter(([k]) => Object.hasOwn(q, k)).map(([k, predicate]) => ({ id: `qf:${r.requestSha256.slice(0, 40)}:${predicate}`, subject: `near:mainnet:intents.near#quote:${r.requestSha256.slice(0, 40)}`, predicate, object: String(q[k]), basis: "claimed", status: "unverified", evidenceIds: [receipt.id], path: [], validFrom: null, validTo: null, privacy: "public" }));
}
export function validateQuoteFacts(facts: Fact[], receipts: EvidenceReceipt[]): void {
  const ids = new Set<string>();
  for (const f of facts) {
    if (!ID_PATTERN.test(f.id) || ids.has(f.id) || !SUBJECT_PATTERN.test(f.subject) || !f.subject.startsWith("near:mainnet:") || !Object.values(FIGURES).includes(f.predicate as typeof FIGURES[keyof typeof FIGURES]) || !/^\d+(?:\.\d+)?$/.test(f.object) || f.basis !== "claimed" || f.status !== "unverified" || f.privacy !== "public" || f.path.length || f.validFrom !== null || f.validTo !== null || !f.evidenceIds.length || !f.evidenceIds.every(id => receipts.some(r => r.id === id && r.privacy === "public" && r.source === `oneclick:${HOST}`))) throw new Error("Invalid quote fact");
    ids.add(f.id);
  }
}
export async function fetchDryQuote(request: DryQuoteRequest, opts: DryQuoteOptions): Promise<DryQuoteResult> {
  validateRequest(request);
  const hash = dryQuoteRequestSha256(request), root = opts.root ?? "fixtures/near/oneclick", file = join(root, `${hash}.json`);
  const fail = (error: Extract<DryQuoteResult, {ok:false}>["error"]): DryQuoteResult => ({ ok: false, record: null, receipt: null, facts: [], reasons: [{ code: ["deposit-address-present", "deadline-present"].includes(error) ? "conflict" : "missing-evidence", subject: null, ref: hash }], error });
  let record: QuoteRecord;
  if (opts.mode === "offline") {
    if (!existsSync(file)) return fail("missing-fixture");
    record = JSON.parse(readFileSync(file, "utf8")); verifyQuoteRecord(record);
    if (record.requestSha256 !== hash) throw new Error("Quote request mismatch");
  } else if (opts.mode === "record") {
    if (existsSync(file)) return fail("already-recorded");
    const key = opts.apiKey === undefined ? process.env.LINCHPIN_ONECLICK_API_KEY : opts.apiKey;
    const headers: Record<string, string> = { "content-type": "application/json" }; if (key) headers["X-API-Key"] = key;
    let response: Response;
    try { response = await (opts.fetch ?? globalThis.fetch)(ONECLICK_QUOTE_URL, { method: "POST", headers, body: JSON.stringify(request), redirect: "error", signal: AbortSignal.timeout(20_000) }); }
    catch { return fail("http-error"); }
    if (!response.ok) {
      // Only a hash and fixed diagnostic leave this branch; no returned addresses or body text.
      const body = await response.text();
      const cause = /deadline/i.test(body) ? "deadline-required" : /refundTo|recipient|invalid.{0,20}address/i.test(body) ? "placeholder-rejected" : "http-error";
      return { ...fail("http-error"), failure: { httpStatus: response.status, responseSha256: sha256(body), cause } } as Extract<DryQuoteResult, { ok: false }>;
    }
    let body: unknown; try { body = await response.json(); } catch { return fail("invalid-response"); }
    const error = bodyError(body); if (error) return fail(error);
    if (key && canonical(body).includes(key)) return fail("invalid-response");
    record = { version: 1, requestSha256: hash, request, endpointHost: HOST, authenticated: !!key, retrievedAt: (opts.now?.() ?? new Date()).toISOString(), httpStatus: response.status, responseSha256: sha256(canonical(body)), response: body };
    verifyQuoteRecord(record); mkdirSync(root, { recursive: true }); writeFileSync(file, JSON.stringify(record, null, 1) + "\n", { flag: "wx" });
  } else throw new Error("Invalid quote mode");
  const r = receipt(record), facts = quoteFacts(record, r), b = record.response as Body;
  validateQuoteFacts(facts, [r]);
  const reasons: QueryReason[] = ["refundFee", "withdrawFee"].filter(k => !Object.hasOwn(b.quote, k)).map(k => ({ code: "missing-coverage", subject: facts[0].subject, ref: `quote.${k}` }));
  return { ok: true, record, receipt: r, facts, correlationId: b.correlationId, timestamp: b.timestamp, signature: b.signature, reasons };
}
