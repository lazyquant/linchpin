/**
 * A fake NEAR AI Cloud transport for the offline suite. It serves the three endpoints the
 * agent uses (attestation report, chat completions, response signature) from in-memory
 * bytes, records every call exactly as received, and signs recorded request/response byte
 * hashes with a synthetic Ed25519 key generated here. No credential, no network.
 */
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { sha256 } from "../../../src/chain/evidence";
import { NEARAI_MODEL } from "../../../src/near/agent/nearai";

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Uint8Array | null;
}

export interface CompletionTurn {
  message: {
    role: "assistant";
    content?: string;
    reasoning_content?: string;
    tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  };
  usage?: { prompt_tokens: number; completion_tokens: number } | null;
}

const hex = (u8: Uint8Array): string => Buffer.from(u8).toString("hex");

export class SyntheticSigner {
  readonly pair = generateKeyPairSync("ed25519");
  readonly publicKeyHex: string;
  constructor() {
    const spki = this.pair.publicKey.export({ format: "der", type: "spki" }) as Buffer;
    this.publicKeyHex = hex(spki.subarray(spki.length - 32));
  }
  sign(text: string): string {
    return hex(cryptoSign(null, Buffer.from(text, "utf8"), this.pair.privateKey));
  }
}

export interface ReportOptions {
  signer: SyntheticSigner;
  gateway?: SyntheticSigner;
  model?: string;
  /** When set, the report echoes this instead of the nonce the caller sent. */
  wrongNonceFor?: string;
  /** When true, no model_attestations entry is included. */
  noModels?: boolean;
  /** Replaces the model name inside the model report. */
  wrongModelFor?: string;
}

const REPORT_MODEL = NEARAI_MODEL;

export class FakeNearCloud {
  readonly calls: RecordedCall[] = [];
  readonly signer = new SyntheticSigner();
  readonly gatewaySigner = new SyntheticSigner();
  /** Queued assistant messages, one per chat completion call. */
  readonly completions: CompletionTurn[] = [];
  reportOptions: ReportOptions | null = null;
  /** Overrides for the next completion call: an HTTP status with a raw body, or a thrown error. */
  chatFailure: { status: number; body: string } | { throw: Error } | null = null;
  reportFailure: { status: number; body: string } | { throw: Error } | null = null;
  signatureFailure: { status: number; body: string } | { throw: Error } | null = null;
  signatureKind: "provider_tee" | "gateway" = "provider_tee";
  private completionCount = 0;

  private record(request: Request | URL | string, init?: RequestInit): { call: RecordedCall; url: URL } {
    const url = new URL(typeof request === "string" ? request : request instanceof URL ? request.href : request.url);
    const headers: Record<string, string> = {};
    const source = (init?.headers ?? (typeof request === "object" && "headers" in (request as Request) ? (request as Request).headers : undefined)) as
      | Headers
      | Record<string, string>
      | undefined;
    if (source && typeof (source as Headers).forEach === "function") {
      (source as Headers).forEach((v, k) => { headers[k.toLowerCase()] = v; });
    } else if (source) {
      for (const [k, v] of Object.entries(source as Record<string, string>)) headers[k.toLowerCase()] = String(v);
    }
    const body = init?.body != null ? new TextEncoder().encode(String(init.body)) : null;
    const call: RecordedCall = { url: url.href, method: init?.method ?? "GET", headers, body };
    this.calls.push(call);
    return { call, url };
  }

  private jsonResponse(bytes: Uint8Array, status = 200): Response {
    return new Response(Buffer.from(bytes), { status, headers: { "content-type": "application/json" } });
  }

  readonly fetch = (async (request: Request | URL | string, init?: RequestInit): Promise<Response> => {
    const { call, url } = this.record(request, init);
    if (url.pathname.endsWith("/attestation/report")) {
      if (this.reportFailure) {
        if ("throw" in this.reportFailure) throw this.reportFailure.throw;
        return new Response(this.reportFailure.body, { status: this.reportFailure.status });
      }
      const nonce = url.searchParams.get("nonce") ?? "";
      const opts = this.reportOptions ?? { signer: this.signer };
      const echo = opts.wrongNonceFor ? `${opts.wrongNonceFor}${nonce}`.slice(0, 64) : nonce;
      const model = opts.model ?? REPORT_MODEL;
      const report: Record<string, unknown> = {
        gateway_attestation: {
          signing_address: (opts.gateway ?? this.gatewaySigner).publicKeyHex,
          signing_algo: "ed25519",
          request_nonce: echo,
          intel_quote: "synthetic-quote-not-a-real-intel-observation",
        },
        model_attestations: opts.noModels ? [] : [{
          model_name: opts.wrongModelFor ?? model,
          signing_address: opts.signer.publicKeyHex,
          signing_algo: "ed25519",
          signing_public_key: opts.signer.publicKeyHex,
          request_nonce: echo,
        }],
      };
      const body = new TextEncoder().encode(JSON.stringify(report));
      (call as RecordedCall & { servedBytes?: Uint8Array }).servedBytes = body;
      return this.jsonResponse(body);
    }
    if (url.pathname.endsWith("/chat/completions")) {
      if (this.chatFailure) {
        if ("throw" in this.chatFailure) throw this.chatFailure.throw;
        return new Response(this.chatFailure.body, { status: this.chatFailure.status });
      }
      const turn = this.completions.shift();
      if (turn === undefined) throw new Error("fake near cloud: no scripted completion left");
      const id = `cmpl-fake-${this.completionCount++}`;
      const body: Record<string, unknown> = {
        id,
        object: "chat.completion",
        model: REPORT_MODEL,
        choices: [{ index: 0, message: turn.message, finish_reason: "stop" }],
      };
      if (turn.usage !== undefined) body.usage = turn.usage;
      const bytes = new TextEncoder().encode(JSON.stringify(body));
      (call as RecordedCall & { servedBytes?: Uint8Array }).servedBytes = bytes;
      (call as RecordedCall & { completionId?: string }).completionId = id;
      return this.jsonResponse(bytes);
    }
    if (url.pathname.includes("/signature/")) {
      if (this.signatureFailure) {
        if ("throw" in this.signatureFailure) throw this.signatureFailure.throw;
        return new Response(this.signatureFailure.body, { status: this.signatureFailure.status });
      }
      const completion = this.calls.find(c => c.url.endsWith("/chat/completions") && (c as RecordedCall & { completionId?: string }).completionId === url.pathname.split("/signature/")[1]?.split("?")[0]);
      if (!completion) return new Response('{"error":"no such completion"}', { status: 404 });
      const reqHash = sha256Hex((completion as RecordedCall & { body?: Uint8Array | null }).body ?? new Uint8Array());
      const respHash = sha256Hex((completion as RecordedCall & { servedBytes?: Uint8Array }).servedBytes ?? new Uint8Array());
      const servedModel = JSON.parse(new TextDecoder().decode((completion as RecordedCall & { body?: Uint8Array }).body)).model as string;
      const text = this.signatureKind === "provider_tee"
        ? `${servedModel}:${reqHash}:${respHash}`
        : `${reqHash}:${respHash}`;
      const signer = this.signatureKind === "provider_tee" ? this.signer : this.gatewaySigner;
      const signature = {
        text,
        signature: signer.sign(text),
        signing_address: signer.publicKeyHex,
        signing_algo: "ed25519",
        signature_kind: this.signatureKind,
      };
      return this.jsonResponse(new TextEncoder().encode(JSON.stringify(signature)));
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

export function sha256Hex(bytes: Uint8Array): string {
  return sha256(bytes);
}
