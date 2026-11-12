/** Errors expose stable codes, never handler messages or evidence payloads. */
export class EngineError extends Error {
  constructor(public readonly code: string) {
    super(`engine: ${code}`);
    this.name = "EngineError";
  }
}
