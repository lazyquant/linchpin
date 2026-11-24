/**
 * Plain-word sentences for a rule that is outside policy or undetermined. One template per rule kind and outcome,
 * filled only from the rule's parameters, the reasons of its outcome and the facts it evaluated. No model writes
 * them. A reason code a template does not list is shown as the code itself.
 *
 * Placeholders: `{param.<name>}` a parameter of the rule (a list is joined with ", "); `{reason.subject}` and
 * `{reason.ref}` from the reason; `{fact.object}` the distinct objects of the rule's facts that are not "none"
 * (or "none" when every object is). Template text holds no digit: every number in a sentence is a value.
 */
import type { Fact } from "../engine/contracts";
import type { Outcome, PublicRuleResult, RuleReason, RuleSpec } from "../policy/types";

export interface SentenceTemplate { codes: string[]; text: string }
export type SentenceOutcome = Exclude<Outcome, "within-policy">;
export interface SentenceValue { value: string; from: string }
export interface Sentence { text: string; values: SentenceValue[] }

const GAP = ["missing-snapshot", "missing-fact", "observed-after-evaluation", "unknown-controller", "missing-coverage"];

function pair(outsideCodes: string[], outside: string, undeterminedCodes: string[], undetermined: string): Record<SentenceOutcome, SentenceTemplate> {
  return { "outside-policy": { codes: outsideCodes, text: outside }, undetermined: { codes: undeterminedCodes, text: undetermined } };
}

export const SENTENCE_TEMPLATES: Readonly<Record<string, Record<SentenceOutcome, SentenceTemplate>>> = Object.freeze({
  "no-full-access-keys": pair(
    ["full-access-key"], "{reason.subject} has a full-access key, {reason.ref}; the policy allows none on {param.accounts}.",
    GAP, "The access keys of {param.accounts} could not be read in full from this snapshot.",
  ),
  "min-threshold": pair(
    ["below-threshold"], "A vote threshold of {reason.subject} is below {param.num} of {param.denom}.",
    [...GAP, "unsupported-weight"], "The vote thresholds of {param.dao} could not be compared with {param.num} of {param.denom} from this snapshot.",
  ),
  "max-council-change-days": pair(
    ["council-changed"], "The council of {reason.subject} changed within the last {param.days} days: {reason.ref}.",
    [...GAP, "missing-history", "approval-time-unknown"], "Council changes of {param.dao} over the last {param.days} days could not be established from the recorded history.",
  ),
  "pause-operator-set": pair(
    ["no-pause-operator"], "No pause operator is recorded for {reason.subject}.",
    GAP, "Whether {param.contract} has a pause operator could not be read from this snapshot.",
  ),
  "pause-state-is": pair(
    ["paused-state"], "{reason.subject} reports the state {reason.ref}; the policy expects paused to be {param.paused}.",
    GAP, "The pause state of {param.contract} could not be read from this snapshot.",
  ),
  "role-grantee-count-max": pair(
    ["grantees-above-max"], "{reason.subject} is held by {fact.object}; the policy allows at most {param.n}.",
    GAP, "The holders of role {param.role} on {param.contract} could not be read from this snapshot.",
  ),
  "role-grantee-count-min": pair(
    ["grantees-below-min"], "{reason.subject} is held by {fact.object}; the policy asks for at least {param.n}.",
    GAP, "The holders of role {param.role} on {param.contract} could not be read from this snapshot.",
  ),
  "oracle-enabled-is": pair(
    ["oracle-not-enabled"], "{reason.subject} does not record {param.account} as its enabled price oracle.",
    GAP, "Which price oracle {param.contract} uses could not be read from this snapshot.",
  ),
  "no-upgrade-since": pair(
    ["upgraded-since"], "The code of {reason.subject} changed after {param.isoDate}: {reason.ref}.",
    [...GAP, "missing-history"], "Whether the code of {param.contract} changed after {param.isoDate} could not be established from the recorded history.",
  ),
  "mpc-threshold-min": pair(
    ["threshold-below-min"], "{reason.subject} records a signing threshold of {fact.object}; the policy asks for at least {param.n}.",
    GAP, "The signing threshold of {param.contract} could not be read from this snapshot.",
  ),
  "route-family-in": pair(
    ["route-family-outside"], "{param.assetId} routes through the family {reason.ref}; the policy allows {param.families}.",
    GAP, "The route family of {param.assetId} could not be classified from this snapshot.",
  ),
  "no-open-proposal-of-class": pair(
    ["open-proposal"], "{reason.subject} has an open proposal of a class the policy names ({param.classes}): {reason.ref}.",
    GAP, "Open proposals of {param.dao} could not be read in full from this snapshot.",
  ),
  "no-open-proposal-touching": pair(
    ["open-proposal"], "An open proposal touches {reason.subject}: {reason.ref}.",
    GAP, "Open proposals touching {param.subject} could not be read in full from this snapshot.",
  ),
  "controller-resolved": pair(
    ["conflict"], "The recorded control facts of {reason.subject} conflict with each other.",
    GAP, "Who controls {param.account} could not be established from this snapshot.",
  ),
  "unchanged-since": pair(
    ["changed"], "{reason.ref} differs from what snapshot {param.snapshotId} recorded.",
    GAP, "A fact this rule watches could not be compared with snapshot {param.snapshotId}: {reason.ref}.",
  ),
});

const PLACEHOLDER = /\{(param\.[A-Za-z][A-Za-z0-9]*|reason\.subject|reason\.ref|fact\.object)\}/g;

function texts(value: unknown): string[] | null {
  if (typeof value === "string") return value === "" ? null : [value];
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" || typeof item === "number")) return value.map(String);
  return null;
}

function factObjects(facts: readonly Pick<Fact, "object">[]): string[] | null {
  if (facts.length === 0) return null;
  const objects = [...new Set(facts.map((fact) => fact.object))].sort();
  const held = objects.filter((object) => object !== "none");
  return held.length > 0 ? held : ["none"];
}

/** Fills one template for one reason. `null` when a placeholder has no value to take. */
function fill(template: string, params: Record<string, unknown>, reason: RuleReason | null, facts: readonly Pick<Fact, "object">[]): Sentence | null {
  const values: SentenceValue[] = [];
  let missing = false;
  const text = template.replace(PLACEHOLDER, (_whole, name: string) => {
    const found = name === "fact.object" ? factObjects(facts)
      : name === "reason.subject" ? texts(reason?.subject)
      : name === "reason.ref" ? texts(reason?.ref)
      : texts(Object.prototype.hasOwnProperty.call(params, name.slice("param.".length)) ? params[name.slice("param.".length)] : undefined);
    if (found === null) {
      missing = true;
      return "";
    }
    for (const value of found) values.push({ value, from: name });
    return found.join(", ");
  });
  return missing ? null : { text, values };
}

/**
 * The sentence of one rule outcome. A rule within policy has no sentence and gets the outcome word. Each reason
 * gives one sentence; equal sentences are said once. A reason whose code the template does not list, a rule kind
 * without a template, and a placeholder with nothing to take each give the reason code itself.
 */
export function sentenceFor(rule: RuleSpec, result: Pick<PublicRuleResult, "outcome" | "reasons">, facts: readonly Pick<Fact, "object">[]): Sentence {
  if (result.outcome === "within-policy") return { text: result.outcome, values: [] };
  const template = Object.prototype.hasOwnProperty.call(SENTENCE_TEMPLATES, rule.kind) ? SENTENCE_TEMPLATES[rule.kind][result.outcome] : undefined;
  if (result.reasons.length === 0) {
    return (template ? fill(template.text, rule.params, null, facts) : null) ?? { text: result.outcome, values: [] };
  }
  const parts: Sentence[] = [];
  for (const reason of result.reasons) {
    const filled = template && template.codes.includes(reason.code) ? fill(template.text, rule.params, reason, facts) : null;
    const part = filled ?? { text: reason.code, values: [{ value: reason.code, from: "reason.code" }] };
    if (!parts.some((earlier) => earlier.text === part.text)) parts.push(part);
  }
  return { text: parts.map((part) => part.text).join(" "), values: parts.flatMap((part) => part.values) };
}
