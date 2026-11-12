import { jsonRecord } from '../../policy/registry';
export interface RouteClassification { family: string | null; reason: string | null; rule: string | null; ruleSetSha256: string | null; sdkVersion: string | null; factIds: string[]; receiptIds: string[] }
export interface ProposalSummaryLite { proposalSubject: string; id: number; status: string; state: string | null; effectClass: string; constructed: boolean; factIds: string[] }
export interface IntentLibrary {
  classify(assetId: string, snapshotId: string): RouteClassification;
  review(assetId: string, snapshotId: string): unknown;
}
export interface GovernanceLibrary {
  openProposals(snapshotId: string, dao: string): ProposalCoverage;
  proposalsTouching(snapshotId: string, subject: string): ProposalCoverage;
  review(snapshotId: string, dao: string, id: number | null): unknown;
}
export interface ProposalCoverage { proposals: ProposalSummaryLite[]; coverageGap: boolean }
export type LibraryStatus = { name: 'near-intent-review' | 'near-governance-review'; status: 'absent' | 'loaded' | 'incompatible' };
export interface NearLibraries { intents: IntentLibrary | null; governance: GovernanceLibrary | null; status: LibraryStatus[] }
export const NO_LIBRARIES: NearLibraries = { intents: null, governance: null, status: [{ name: 'near-intent-review', status: 'absent' }, { name: 'near-governance-review', status: 'absent' }] };
export const missingLibrary = (name: string) => ({ outcome: 'unknown', reasons: [{ code: 'missing-coverage', subject: null, ref: `library:${name}` }] });
const ids = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string');
export function isRoute(v: unknown): v is RouteClassification {
  return jsonRecord(v) && ['family', 'reason', 'rule', 'ruleSetSha256', 'sdkVersion'].every(k => v[k] === null || typeof v[k] === 'string') && ids(v.factIds) && ids(v.receiptIds);
}
export function isProposal(v: unknown): v is ProposalSummaryLite {
  return jsonRecord(v) && typeof v.proposalSubject === 'string' && Number.isSafeInteger(v.id) && typeof v.status === 'string'
    && (v.state === null || typeof v.state === 'string') && typeof v.effectClass === 'string' && typeof v.constructed === 'boolean' && ids(v.factIds);
}
export function isCoverage(v: unknown): v is ProposalCoverage {
  return jsonRecord(v) && typeof v.coverageGap === 'boolean' && Array.isArray(v.proposals) && v.proposals.every(isProposal);
}
export function readRoute(libs: NearLibraries, asset: string, snapshot: string): RouteClassification | null {
  try { const v = libs.intents?.classify(asset, snapshot); return isRoute(v) ? v : null; } catch { return null; }
}
export function readProposals(libs: NearLibraries, method: 'openProposals' | 'proposalsTouching', snapshot: string, subject: string): ProposalCoverage {
  try { const v = libs.governance?.[method](snapshot, subject); return isCoverage(v) ? v : { proposals: [], coverageGap: true }; }
  catch { return { proposals: [], coverageGap: true }; }
}
export function readLibraryReview(libs: NearLibraries, kind: 'intents' | 'governance', snapshot: string, subject: string, id: number | null = null): unknown {
  try {
    const v = kind === 'intents' ? libs.intents?.review(subject, snapshot) : libs.governance?.review(snapshot, subject, id);
    return jsonRecord(v) ? v : missingLibrary(kind === 'intents' ? 'near-intent-review' : 'near-governance-review');
  } catch { return missingLibrary(kind === 'intents' ? 'near-intent-review' : 'near-governance-review'); }
}
function hasGap(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(hasGap);
  return jsonRecord(v) && (v.code === 'missing-coverage' || v.coverageGap === true || Object.values(v).some(hasGap));
}
function adaptProposals(v: unknown): ProposalCoverage {
  const list = Array.isArray(v) ? v : jsonRecord(v) ? v.proposals : null;
  if (!Array.isArray(list) || !list.every(isProposal)) return { proposals: [], coverageGap: true };
  return { proposals: list, coverageGap: hasGap(v) };
}
const libraryResults = new Map<string, unknown>();
const intentContexts = new Map<string, any>();
const governanceContexts = new Map<string, { snapshotId: string }>();
function governanceContext(snapshotId: string) {
  if (!governanceContexts.has(snapshotId)) governanceContexts.set(snapshotId, { snapshotId });
  return governanceContexts.get(snapshotId)!;
}
/** All optional-module signatures and coverage decisions stay at this boundary. */
export async function loadNearLibraries(base: URL = new URL(import.meta.url)): Promise<NearLibraries> {
  const result: NearLibraries = { intents: null, governance: null, status: [] };
  for (const kind of ['intents', 'governance'] as const) {
    const name = kind === 'intents' ? 'near-intent-review' : 'near-governance-review';
    const url = new URL(`../${kind}/index.ts`, base);
    if (!await Bun.file(url).exists()) { result.status.push({ name, status: 'absent' }); continue; }
    try {
      const m = await import(url.href);
      const required = kind === 'intents' ? ['classifyAsset', 'reviewIntent', 'loadIntentContext'] : ['openProposals', 'proposalsTouching', 'reviewProposal'];
      if (!required.every(k => typeof m[k] === 'function')) throw new Error();
      const intentContext = (snapshotId: string) => {
        if (!intentContexts.has(snapshotId)) intentContexts.set(snapshotId, m.loadIntentContext({ snapshotId }));
        return intentContexts.get(snapshotId);
      };
      if (kind === 'intents') result.intents = {
        classify(asset, snapshotId) {
          try {
            const ctx = intentContext(snapshotId);
            const v = m.classifyAsset(asset, ctx.rules, ctx.routeEvidence);
            const normalized = jsonRecord(v) ? { ...v, factIds: v.factIds ?? [], receiptIds: v.receiptIds ?? [] } : v;
            if (isRoute(normalized)) return normalized;
          } catch { /* Missing coverage remains explicit. */ }
          return { family: null, reason: 'missing-coverage', rule: null, ruleSetSha256: null, sdkVersion: null, factIds: [], receiptIds: [] };
        },
        review(assetId, snapshotId) { try { const v = m.reviewIntent({ kind: 'asset', assetId }, intentContext(snapshotId)); return jsonRecord(v) ? v : missingLibrary(name); } catch { return missingLibrary(name); } },
      };
      else result.governance = {
        openProposals(snapshotId, dao) { try { return adaptProposals(m.openProposals(governanceContext(snapshotId), dao)); } catch { return { proposals: [], coverageGap: true }; } },
        proposalsTouching(snapshotId, subject) { try { return adaptProposals(m.proposalsTouching(governanceContext(snapshotId), subject)); } catch { return { proposals: [], coverageGap: true }; } },
        review(snapshotId, dao, id) { try { const v = id === null ? m.openProposals(governanceContext(snapshotId), dao) : m.reviewProposal(governanceContext(snapshotId), dao, id); return Array.isArray(v) ? { proposals: v } : jsonRecord(v) ? v : missingLibrary(name); } catch { return missingLibrary(name); } },
      };
      const library = kind === 'intents' ? result.intents : result.governance;
      if (library) for (const key of Object.keys(library)) {
        const methods = library as unknown as Record<string, (...args: any[]) => unknown>;
        const original = methods[key]!;
        methods[key] = (...args: any[]) => {
          const cacheKey = JSON.stringify([url.href, key, args]);
          if (!libraryResults.has(cacheKey)) libraryResults.set(cacheKey, structuredClone(original(...args)));
          return structuredClone(libraryResults.get(cacheKey));
        };
      }
      result.status.push({ name, status: 'loaded' });
    } catch { result.status.push({ name, status: 'incompatible' }); }
  }
  return result;
}
