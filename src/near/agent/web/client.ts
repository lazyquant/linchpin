import { interpret } from "../../../ui/interpret";
import { mount } from "../../../ui/mount";
import { readSurface, isRecord } from "../../../ui/messages";
import { receiptResolver, validateSurface } from "../../../ui/validate";
import type { AskResponse } from "../types";
import type { PreparedAnswer } from "../prepared";
import { LABELS, SCRIPTED_LABEL } from "./strings";

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = element("status"), answer = element("answer"), label = element("mode-label");
const kind = element<HTMLSelectElement>("kind"), subject = element<HTMLSelectElement>("subject"), offline = element<HTMLInputElement>("offline");
let prepared: PreparedAnswer[] = [];
let current: AbortController | undefined;
function show(response: AskResponse): void {
  const model = readSurface(response.messages).model;
  const receipts = isRecord(model) && Array.isArray(model.receipts) ? model.receipts.flatMap(r => isRecord(r) && typeof r.id === "string" ? [r.id] : []) : [];
  const checked = validateSurface(response.messages, { resolveEvidence: receiptResolver(receipts) });
  if (!checked.ok) { answer.replaceChildren(); status.textContent = checked.codes.join(", "); return; }
  mount(interpret(response.messages), answer);
  label.textContent = response.model.label ?? `Model: ${response.model.id ?? "unavailable"}. Hardware attestation: ${response.attestation.status}. Response binding: ${response.responseBinding.status}.`;
  status.textContent = response.codes.join(", ");
}
function usePrepared(task: string): void {
  current?.abort();
  const entry = prepared.find(e => e.id === task);
  if (!entry) { status.textContent = "prepared-unavailable"; return; }
  kind.value = task; updateControls(); show(entry.response); label.textContent = SCRIPTED_LABEL;
}
function updateControls(): void {
  subject.disabled = kind.value !== "control";
  element("preflight-intent").hidden = kind.value !== "preflight";
  element("policy-intent").hidden = kind.value !== "policy";
}
kind.addEventListener("change", updateControls);
document.querySelectorAll<HTMLButtonElement>("[data-prepared]").forEach(button => button.addEventListener("click", () => usePrepared(button.dataset.prepared!)));
element<HTMLFormElement>("request").addEventListener("submit", async event => {
  event.preventDefault();
  if (offline.checked || !navigator.onLine) { usePrepared(kind.value); return; }
  current?.abort(); current = new AbortController();
  const active = current;
  const input = kind.value === "control" ? { kind: "control", subject: subject.value }
    : prepared.find(e => e.id === kind.value)?.input;
  if (!input) { status.textContent = "invalid-request"; return; }
  status.textContent = LABELS.waiting;
  try {
    const result = await fetch("/api/near-agent/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), signal: active.signal });
    const data = await result.json();
    if (active !== current) return;
    if (!result.ok) { status.textContent = Array.isArray(data.codes) ? data.codes.join(", ") : LABELS.failed; return; }
    if (data.kind === "no-model") { usePrepared(kind.value); return; }
    show(data);
  } catch { if (active === current) status.textContent = active.signal.aborted ? "aborted" : LABELS.failed; }
});
async function load(): Promise<void> {
  try {
    const response = await fetch("/api/near-agent/prepared");
    if (!response.ok) throw new Error();
    prepared = await response.json(); usePrepared("control");
  } catch { status.textContent = "prepared-unavailable"; }
}
updateControls(); void load();
