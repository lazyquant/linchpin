import { Connection, PublicKey, VersionedTransaction, type AccountInfo, type GetProgramAccountsFilter, type GetProgramAccountsResponse, type SimulateTransactionConfig, type SimulatedTransactionResponse, type ConfirmedSignatureInfo, type VersionedTransactionResponse } from "@solana/web3.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { canonical, fixtureKey, sha256, type Evidence } from "./evidence";
import type { RunOptions } from "../config";

type Recorded<T> = { value: T; evidence: Evidence };
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000];
const MAX_ATTEMPTS = 8;
const RETRYABLE = /429|Too Many Requests|503|502|ECONNRESET|ETIMEDOUT|fetch failed/i;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Persist endpoint identity only; credentials, query strings and fragments are private. */
function redactedRpcUrl(value: string): string {
  const url = new URL(value);
  return `${url.protocol}//${url.host}${url.pathname}`;
}

export class RecordingRpc {
  readonly connection: Connection;
  readonly evidence: Evidence[] = [];
  private liveQueue: Promise<void> = Promise.resolve();
  private lastLiveStart = -Infinity;
  private liveReads = 0;
  private replayedReads = 0;
  private retryCount = 0;
  get counts() { return { live: this.liveReads, replayed: this.replayedReads, retries: this.retryCount }; }
  constructor(readonly opts: RunOptions, readonly caseId: string) {
    this.connection = new Connection(opts.rpcUrl, { commitment: "confirmed", disableRetryOnRateLimit: true });
  }
  private fixturePath(key: string) { return join(this.opts.fixturesDir, this.caseId, `${key}.json`); }

  /** Serialize attempts so concurrent reads and retries share the same throttle. */
  private liveAttempt<T>(live: () => Promise<T>): Promise<T> {
    const result = this.liveQueue.then(async () => {
      let remaining: number;
      while ((remaining = this.opts.minIntervalMs - (performance.now() - this.lastLiveStart)) > 0) await sleep(remaining);
      this.lastLiveStart = performance.now();
      return live();
    });
    this.liveQueue = result.then(() => {}, () => {});
    return result;
  }

  private async retryLive<T>(method: string, live: () => Promise<T>): Promise<T> {
    const delays = this.opts.retryDelaysMs ?? RETRY_DELAYS_MS;
    for (let attempt = 1; ; attempt++) {
      try { return await this.liveAttempt(live); }
      catch (error) {
        if (!(error instanceof Error) || !RETRYABLE.test(error.message) || attempt >= MAX_ATTEMPTS) throw error;
        const delay = (delays[attempt - 1] ?? RETRY_DELAYS_MS[attempt - 1]) * (0.8 + Math.random() * 0.4);
        this.retryCount++;
        console.error(`[record] ${method} retry: attempt ${attempt + 1}/${MAX_ATTEMPTS} in ${Math.round(delay)} ms`);
        await sleep(delay);
      }
    }
  }

  /** Run one RPC call through evidence capture and record/replay. `serialize`/`revive` keep fixtures JSON-safe. */
  private async call<T>(method: string, params: unknown, live: () => Promise<{ value: T; slot: number | null }>, serialize: (v: T) => unknown, revive: (j: any) => T): Promise<Recorded<T>> {
    const key = fixtureKey(method, params);
    const path = this.fixturePath(key);
    if (this.opts.offline || (this.opts.record && !this.opts.refresh && existsSync(path))) {
      if (!existsSync(path)) throw new Error(`offline: fixture missing for ${method} → ${path}`);
      const fx = JSON.parse(readFileSync(path, "utf8"));
      const value = revive(fx.response);
      const evidence: Evidence = { id: sha256(`${method}${canonical(params)}${fx.responseSha256}`), method, params, slot: fx.slot, retrievedAt: fx.retrievedAt, rpcUrl: redactedRpcUrl(fx.rpcUrl), responseSha256: fx.responseSha256, source: "fixture" };
      this.evidence.push(evidence);
      this.replayedReads++;
      return { value, evidence };
    }
    const { value, slot } = await this.retryLive(method, live);
    const response = serialize(value);
    const responseSha256 = sha256(canonical(response));
    const retrievedAt = new Date().toISOString();
    const rpcUrl = redactedRpcUrl(this.opts.rpcUrl);
    const evidence: Evidence = { id: sha256(`${method}${canonical(params)}${responseSha256}`), method, params, slot, retrievedAt, rpcUrl, responseSha256, source: "rpc" };
    this.evidence.push(evidence);
    if (this.opts.record) {
      mkdirSync(join(this.opts.fixturesDir, this.caseId), { recursive: true });
      writeFileSync(path, JSON.stringify({ method, params, slot, retrievedAt, rpcUrl, responseSha256, response }, null, 1));
    }
    this.liveReads++;
    if (this.opts.record && this.liveReads % 25 === 0) console.error(`[record] ${this.liveReads} live reads, ${this.replayedReads} replayed, last: ${method}`);
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

  getProgramAccounts(programId: PublicKey, filters: GetProgramAccountsFilter[] = []): Promise<Recorded<GetProgramAccountsResponse>> {
    return this.call("getProgramAccounts", { programId: programId.toBase58(), filters },
      async () => { const r = await this.connection.getProgramAccounts(programId, { filters, withContext: true }); return { value: r.value, slot: r.context.slot }; },
      (v) => v.map(({ pubkey, account }) => ({ pubkey: pubkey.toBase58(), account: { ...account, owner: account.owner.toBase58(), data: account.data.toString("base64") } })),
      (j) => j.map((entry: any) => ({ pubkey: new PublicKey(entry.pubkey), account: { ...entry.account, owner: new PublicKey(entry.account.owner), data: Buffer.from(entry.account.data, "base64") } })));
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
