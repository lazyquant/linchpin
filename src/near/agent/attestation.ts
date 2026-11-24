import { sha256 } from "../../chain/evidence";
import { NEARAI_BASE, NEARAI_MODEL, jsonBytes, responseBytes } from "./nearai";
import { record } from "./errors";
import type { AttestationCandidate, AttestationCapture, AttestationMeta } from "./types";

export function unavailableAttestation(code: string): AttestationMeta {
  return { status: "unavailable", code, source: null, observedAt: null, reportSha256: null, nonce: null, gatewayNonceMatches: null, modelReportCount: 0 };
}
export const freshNonce = (): string => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
function candidate(v: unknown): AttestationCandidate | null {
  return record(v) && typeof v.signing_address === "string" && typeof v.signing_algo === "string" && typeof v.request_nonce === "string"
    ? { signing_address: v.signing_address, signing_algo: v.signing_algo, request_nonce: v.request_nonce,
      ...(typeof v.model_name === "string" ? { model_name: v.model_name } : {}) } : null;
}
export async function captureAttestation(options: { fetch?: typeof fetch; clock?: () => number; nonce?: () => string; signal?: AbortSignal } = {}): Promise<AttestationCapture> {
  const clock = options.clock ?? Date.now, transport = options.fetch ?? globalThis.fetch;
  let nonce: string;
  try { nonce = (options.nonce ?? freshNonce)(); } catch { nonce = ""; }
  const empty = (code: string): AttestationCapture => ({ meta: unavailableAttestation(code), fetchedAt: clock(), model: NEARAI_MODEL, gateway: null, candidates: [] });
  if (!/^[a-f0-9]{64}$/i.test(nonce)) return empty("attestation-nonce");
  const url = new URL(`${NEARAI_BASE}/attestation/report`);
  for (const [k, v] of Object.entries({ model: NEARAI_MODEL, provider: "near", signing_algo: "ed25519", nonce, include_tls_fingerprint: "false" })) url.searchParams.set(k, v);
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000);
  try {
    const response = await transport(url, { signal, headers: { Accept: "application/json", "Accept-Encoding": "identity", "x-no-aliasing": "true" } });
    if (!response.ok) { await response.body?.cancel().catch(() => {}); return empty("attestation-http"); }
    const rawBytes = await responseBytes(response, 2097152), fetchedAt = clock();
    let body: unknown;
    const invalid = (code: string, gatewayNonceMatches: boolean | null = null): AttestationCapture => ({
      meta: { status: "unavailable", code, source: url.origin + url.pathname, observedAt: new Date(fetchedAt).toISOString(),
        reportSha256: sha256(rawBytes), nonce, gatewayNonceMatches,
        modelReportCount: record(body) && Array.isArray(body.model_attestations) ? body.model_attestations.length : 0 },
      fetchedAt, model: NEARAI_MODEL, gateway: null, candidates: [], rawBytes });
    try { body = jsonBytes(rawBytes); } catch { return invalid("attestation-json"); }
    if (!record(body) || !Array.isArray(body.model_attestations) || !body.model_attestations.length) return invalid("attestation-model-missing");
    const gateway = candidate(body.gateway_attestation), candidates = body.model_attestations.map(candidate);
    if (!gateway || candidates.some(c => !c)) return invalid("attestation-shape");
    const models = candidates.filter((c): c is AttestationCandidate => c !== null);
    if (gateway.request_nonce !== nonce || models.some(c => c.request_nonce !== nonce)) return invalid("attestation-nonce", gateway.request_nonce === nonce);
    if (models.some(c => c.model_name !== NEARAI_MODEL || c.signing_algo !== "ed25519") || gateway.signing_algo !== "ed25519") return invalid("attestation-model", true);
    return { meta: { status: "not-checked", code: null, source: url.origin + url.pathname, observedAt: new Date(fetchedAt).toISOString(),
      reportSha256: sha256(rawBytes), nonce, gatewayNonceMatches: true, modelReportCount: models.length },
      fetchedAt, model: NEARAI_MODEL, gateway, candidates: models, rawBytes };
  } catch { return empty("attestation-unavailable"); }
}
