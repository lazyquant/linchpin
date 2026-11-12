import { createRuleRegistry } from "../registry";
import { maxShareBehind } from "./share";
import { minExitEvidence } from "./exit";
import { maxEvidenceAge } from "./age";
import { controllerResolved } from "./controller";
import { unchangedSince } from "./unchanged";
export * from "./share";
export * from "./exit";
export * from "./age";
export * from "./controller";
export * from "./unchanged";
export const GENERIC_RULES = Object.freeze([maxShareBehind, minExitEvidence, maxEvidenceAge, controllerResolved, unchangedSince]);
export function createGenericRegistry() { return createRuleRegistry(GENERIC_RULES); }
