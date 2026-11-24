import { createPublicKey, verify } from "node:crypto";
import { sha256 } from "../../chain/evidence";
import { record } from "./errors";
import { NEARAI_BASE, NEARAI_MODEL, jsonBytes, responseBytes } from "./nearai";
import type { AttestationCapture, BindingCheck, ResponseBinding, WireCompletion } from "./types";

export const emptyBinding = (): ResponseBinding => ({ status: "unavailable", turns: [] });
export function aggregateBindings(turns: BindingCheck[]): ResponseBinding {
  return { status: turns.some(t => t.status === "invalid") ? "invalid"
    : turns.length && turns.every(t => t.status === "valid-under-unverified-key") ? "valid-under-unverified-key" : "unavailable", turns };
}
const hex = (s: string) => s.replace(/^0x/, "").toLowerCase();
export function checkResponseSignature(signature: unknown, wire: WireCompletion, capture: AttestationCapture): BindingCheck {
  const requestSha256 = sha256(wire.requestBytes), responseSha256 = sha256(wire.responseBytes);
  const base = { completionId: wire.completionId, signatureKind: record(signature) && typeof signature.signature_kind === "string" ? signature.signature_kind : null, requestSha256, responseSha256 };
  const fail = (code: string): BindingCheck => ({ ...base, status: "invalid", code });
  if (capture.meta.status !== "not-checked" || capture.fetchedAt > wire.receivedAt) return { ...base, status: "unavailable", code: "binding-preflight-missing" };
  if (capture.model !== NEARAI_MODEL) return fail("signature-model");
  if (!record(signature) || typeof signature.error_code === "string" || typeof signature.message === "string" && !signature.signature) return { ...base, status: "unavailable", code: "signature-unavailable" };
  if (signature.signing_algo !== "ed25519" || typeof signature.signing_address !== "string" || typeof signature.signature !== "string" || typeof signature.text !== "string") return fail("signature-shape");
  const kind = signature.signature_kind;
  if (kind !== "provider_tee" && kind !== "gateway") return fail("signature-kind");
  const candidates = kind === "provider_tee" ? capture.candidates : capture.gateway ? [capture.gateway] : [];
  const matches = candidates.filter(c => c.signing_algo === signature.signing_algo && hex(c.signing_address) === hex(signature.signing_address as string));
  if (matches.length !== 1 || kind === "provider_tee" && matches[0]!.model_name !== NEARAI_MODEL) return fail("signature-signer");
  const text = `${kind === "provider_tee" ? NEARAI_MODEL + ":" : ""}${requestSha256}:${responseSha256}`;
  if (signature.text !== text) return fail("signature-bytes");
  const publicHex = hex(signature.signing_address), signatureHex = hex(signature.signature);
  if (!/^[a-f0-9]{64}$/.test(publicHex) || !/^[a-f0-9]{128}$/.test(signatureHex)) return fail("signature-shape");
  try {
    const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(publicHex, "hex")]), format: "der", type: "spki" });
    return verify(null, Buffer.from(text), key, Buffer.from(signatureHex, "hex"))
      ? { ...base, status: "valid-under-unverified-key", code: null } : fail("signature-invalid");
  } catch { return fail("signature-invalid"); }
}
export async function verifyResponseBinding(wire: WireCompletion, capture: AttestationCapture, options: { fetch?: typeof fetch; key?: () => string | undefined; signal?: AbortSignal; clock?: () => number } = {}): Promise<BindingCheck> {
  const unavailable = (code: string): BindingCheck => ({ status: "unavailable", code, completionId: wire.completionId, signatureKind: null,
    requestSha256: sha256(wire.requestBytes), responseSha256: sha256(wire.responseBytes) });
  const key = (options.key ?? (() => process.env.NEARAI_API_KEY))();
  if (!key) return unavailable("signature-not-configured");
  const url = new URL(`${NEARAI_BASE}/signature/${encodeURIComponent(wire.completionId)}`);
  url.searchParams.set("model", NEARAI_MODEL); url.searchParams.set("signing_algo", "ed25519");
  try {
    const response = await (options.fetch ?? globalThis.fetch)(url, { signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json", "Accept-Encoding": "identity" } });
    if (!response.ok) { await response.body?.cancel().catch(() => {}); return unavailable(response.status === 404 ? "signature-missing" : "signature-http"); }
    const bytes = await responseBytes(response, 16384);
    return { ...checkResponseSignature(jsonBytes(bytes), wire, capture), signatureSha256: sha256(bytes),
      source: url.origin + url.pathname, observedAt: new Date((options.clock ?? Date.now)()).toISOString() };
  } catch { return unavailable("signature-unavailable"); }
}
