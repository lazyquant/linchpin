export class NearAgentError extends Error {
  constructor(readonly code: string) { super(code); this.name = "NearAgentError"; }
}
export const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
export const clone = <T>(v: T): T => structuredClone(v);
export function freeze<T>(v: T): T {
  if (v && typeof v === "object") { Object.values(v).forEach(freeze); Object.freeze(v); }
  return v;
}
export function codeOf(error: unknown, fallback: string): string {
  return error instanceof NearAgentError ? error.code : fallback;
}
