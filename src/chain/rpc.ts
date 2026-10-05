import { Connection, PublicKey, VersionedTransaction, type AccountInfo, type SimulateTransactionConfig, type SimulatedTransactionResponse, type ConfirmedSignatureInfo, type VersionedTransactionResponse } from "@solana/web3.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { canonical, fixtureKey, sha256, type Evidence } from "./evidence";
import type { RunOptions } from "../config";

type Recorded<T> = { value: T; evidence: Evidence };

export class RecordingRpc {
  readonly connection: Connection;
  readonly evidence: Evidence[] = [];
  constructor(readonly opts: RunOptions, readonly caseId: string) {
    this.connection = new Connection(opts.rpcUrl, "confirmed");
  }
  private fixturePath(key: string) { return join(this.opts.fixturesDir, this.caseId, `${key}.json`); }

  /** Run one RPC call through evidence capture and record/replay. `serialize`/`revive` keep fixtures JSON-safe. */
  private async call<T>(method: string, params: unknown, live: () => Promise<{ value: T; slot: number | null }>, serialize: (v: T) => unknown, revive: (j: any) => T): Promise<Recorded<T>> {
    const key = fixtureKey(method, params);
    const path = this.fixturePath(key);
    if (this.opts.offline) {
      if (!existsSync(path)) throw new Error(`offline: fixture missing for ${method} → ${path}`);
      const fx = JSON.parse(readFileSync(path, "utf8"));
      const value = revive(fx.response);
      const evidence: Evidence = { id: sha256(`${method}${canonical(params)}${fx.responseSha256}`), method, params, slot: fx.slot, retrievedAt: fx.retrievedAt, rpcUrl: fx.rpcUrl, responseSha256: fx.responseSha256, source: "fixture" };
      this.evidence.push(evidence);
      return { value, evidence };
    }
    const { value, slot } = await live();
    const response = serialize(value);
    const responseSha256 = sha256(canonical(response));
    const retrievedAt = new Date().toISOString();
    const evidence: Evidence = { id: sha256(`${method}${canonical(params)}${responseSha256}`), method, params, slot, retrievedAt, rpcUrl: this.opts.rpcUrl, responseSha256, source: "rpc" };
    this.evidence.push(evidence);
    if (this.opts.record) {
      mkdirSync(join(this.opts.fixturesDir, this.caseId), { recursive: true });
      writeFileSync(path, JSON.stringify({ method, params, slot, retrievedAt, rpcUrl: this.opts.rpcUrl, responseSha256, response }, null, 1));
    }
    return { value, evidence };
  }

  getAccountInfo(pubkey: PublicKey): Promise<Recorded<AccountInfo<Buffer> | null>> {
    return this.call("getAccountInfo", { pubkey: pubkey.toBase58() },
      async () => { const r = await this.connection.getAccountInfoAndContext(pubkey); return { value: r.value, slot: r.context.slot }; },
      (v) => v && { ...v, owner: v.owner.toBase58(), data: v.data.toString("base64") },
      (j) => j && { ...j, owner: new PublicKey(j.owner), data: Buffer.from(j.data, "base64") });
  }

  getBalance(pubkey: PublicKey): Promise<Recorded<number>> {
    return this.call("getBalance", { pubkey: pubkey.toBase58() },
      async () => { const r = await this.connection.getBalanceAndContext(pubkey); return { value: r.value, slot: r.context.slot }; }, (v) => v, (j) => j);
  }

  getSignaturesForAddress(pubkey: PublicKey, limit = 50): Promise<Recorded<ConfirmedSignatureInfo[]>> {
    return this.call("getSignaturesForAddress", { pubkey: pubkey.toBase58(), limit },
      async () => ({ value: await this.connection.getSignaturesForAddress(pubkey, { limit }), slot: null }), (v) => v, (j) => j);
  }

  getTransaction(signature: string): Promise<Recorded<VersionedTransactionResponse | null>> {
    return this.call("getTransaction", { signature },
      async () => ({ value: await this.connection.getTransaction(signature, { maxSupportedTransactionVersion: 0 }), slot: null }),
      (v) => v && JSON.parse(JSON.stringify(v)), (j) => j);  // fixtures keep the raw JSON shape; consumers only read meta/logs/balances
  }

  simulate(tx: VersionedTransaction, config: SimulateTransactionConfig): Promise<Recorded<SimulatedTransactionResponse>> {
    const message = Buffer.from(tx.message.serialize()).toString("base64");
    return this.call("simulateTransaction", { message, config: { ...config, accounts: config.accounts } },
      async () => { const r = await this.connection.simulateTransaction(tx, config); return { value: r.value, slot: r.context.slot }; }, (v) => v, (j) => j);
  }

  /** Append the evidence log for this run. */
  flushEvidence(outDir: string) {
    mkdirSync(outDir, { recursive: true });
    const path = join(outDir, "evidence.jsonl");
    appendFileSync(path, this.evidence.map((e) => JSON.stringify(e)).join("\n") + "\n");
    return path;
  }
}
