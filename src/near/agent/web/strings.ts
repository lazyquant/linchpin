export const SCRIPTED_LABEL = "Composed by a fixed script over recorded evidence, not by a model";
export const NO_MODEL_TEXT = "No model is configured on this machine";
export const REFUSAL_TEXT = "A model answer could not be composed from the recorded evidence.";
export const LABELS = {
  title: "NEAR evidence", facts: "Recorded facts", policy: "Policy rules", graph: "Dependency map",
  unknowns: "Unknowns and coverage", report: "Model report", binding: "Response binding", receipts: "Receipts",
  context: "Additional evidence", summary: "unchecked summary", prepared: "Prepared answers",
  control: "Control", preflight: "Preflight", policyTask: "Policy", subject: "Public subject",
  ask: "Ask with recorded evidence", waiting: "Reading recorded evidence", failed: "The request could not be completed",
  hardware: "Hardware attestation", model: "Model", result: "Answer", source: "Source",
} as const;
