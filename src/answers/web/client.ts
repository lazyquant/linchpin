/**
 * The page script. It lists the prepared answers, posts a typed question, and draws a reply with the kit:
 * the three messages are checked by the kit's validator, read into a tree and mounted as elements. Text reaches
 * the page as text only. It talks to its own origin and to nothing else.
 */
import { interpret } from "../../ui/interpret";
import { mount } from "../../ui/mount";
import type { CoverageInput, UiNode } from "../../ui/types";
import { validateSurface } from "../../ui/validate";
import { PAGE_STRINGS as S } from "./strings";

interface Prepared { id: string; question: string; protocol: string; label: string; ndjson: string }
interface PinnedDocument { label: string; protocols: { id: string; title: string }[]; answers: Prepared[] }

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const form = byId<HTMLFormElement>("aa-form");
const protocolField = byId<HTMLSelectElement>("aa-protocol");
const questionField = byId<HTMLTextAreaElement>("aa-question");
const submit = byId<HTMLButtonElement>("aa-submit");
const status = byId<HTMLParagraphElement>("aa-status");
const preparedList = byId<HTMLDivElement>("aa-prepared");
const answer = byId<HTMLElement>("aa-answer");
const origin = byId<HTMLParagraphElement>("aa-origin");
const region = byId<HTMLDivElement>("aa-region");

let asking = false;
let ready = false;

function element(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className !== "") node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setStatus(text: string): void {
  status.textContent = text;
}

function setOrigin(kind: string, detail: string): void {
  origin.replaceChildren(element("span", "aa-origin-kind", kind), element("span", "", detail));
}

function showMessage(text: string): void {
  const line = element("p", "lk-empty", text);
  line.setAttribute("role", "alert");
  region.replaceChildren(line);
}

function setBusy(busy: boolean): void {
  asking = busy;
  submit.disabled = busy || !ready;
  for (const button of preparedList.querySelectorAll("button")) button.disabled = busy;
}

function markCurrent(current: HTMLButtonElement | null): void {
  for (const button of preparedList.querySelectorAll("button")) {
    if (button === current) button.setAttribute("aria-current", "true");
    else button.removeAttribute("aria-current");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The coverage list of a reply's data model, which the validator reads beside the messages. */
function coverageOf(messages: unknown[]): CoverageInput | undefined {
  for (const message of messages) {
    if (!isRecord(message) || !isRecord(message.updateDataModel)) continue;
    const value = message.updateDataModel.value;
    if (isRecord(value) && isRecord(value.coverage) && Array.isArray(value.coverage.mechanics) && Array.isArray(value.coverage.asked)) {
      return value.coverage as unknown as CoverageInput;
    }
  }
  return undefined;
}

/**
 * Draws one reply. The server resolved every evidence id before it sent the reply; the page checks the rest of
 * the kit's rules again and draws only a surface that passes.
 */
function draw(ndjson: string): void {
  let messages: unknown[];
  try {
    messages = ndjson.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as unknown);
  } catch {
    showMessage(S.unreadable);
    return;
  }
  if (messages.length !== 3) {
    showMessage(S.unreadable);
    return;
  }
  const verdict = validateSurface(messages, { resolveEvidence: () => ({ missing: [] }), coverage: coverageOf(messages) });
  if (!verdict.ok) {
    showMessage(`${S.rejected} ${verdict.codes.join(", ")}`);
    return;
  }
  let drawn: UiNode;
  try {
    const tree = interpret(messages);
    if (tree.errors.length > 0) {
      showMessage(`${S.rejected} ${[...new Set(tree.errors.map((error) => error.code))].join(", ")}`);
      return;
    }
    drawn = { tag: "div", attrs: { class: "aa-drawn" }, children: tree.root.children };
  } catch {
    showMessage(S.unreadable);
    return;
  }
  mount(drawn, region);
}

/** Brings the answer to the reader: focus for a keyboard, and into view where it sits below the questions. */
function reveal(): void {
  answer.focus({ preventScroll: true });
  if (window.matchMedia("(max-width: 1179px)").matches) answer.scrollIntoView({ block: "start" });
}

function showPrepared(entry: Prepared, button: HTMLButtonElement): void {
  if (asking) return;
  markCurrent(button);
  setStatus("");
  setOrigin(S.originPrepared, entry.label);
  draw(entry.ndjson);
  reveal();
}

function listPrepared(pinned: PinnedDocument): void {
  const groups: HTMLElement[] = [];
  for (const protocol of pinned.protocols) {
    const option = document.createElement("option");
    option.value = protocol.id;
    option.textContent = protocol.title;
    protocolField.append(option);

    const entries = pinned.answers.filter((entry) => entry.protocol === protocol.id);
    if (entries.length === 0) continue;
    const group = element("div", "aa-group");
    const list = element("div", "aa-questions");
    for (const entry of entries) {
      const button = element("button", "aa-question", entry.question) as HTMLButtonElement;
      button.type = "button";
      button.addEventListener("click", () => showPrepared(entry, button));
      list.append(button);
    }
    group.append(element("h3", "aa-group-title", protocol.title), list);
    groups.push(group);
  }
  preparedList.replaceChildren(...groups);
}

function sentenceFor(code: number): string {
  if (code === 400) return S.refusedRequest;
  if (code === 403) return S.refusedOrigin;
  if (code === 409) return S.refusedBusy;
  if (code === 422) return S.refusedPrivate;
  return S.serverFailed;
}

async function ask(): Promise<void> {
  const question = questionField.value.trim();
  if (asking || !ready || question === "") return;
  setBusy(true);
  markCurrent(null);
  setStatus(S.asking);
  try {
    const response = await fetch("/api/answers/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question, protocol: protocolField.value }),
    });
    setOrigin(S.originTyped, S.originTypedDetail);
    if (response.status === 200) {
      draw(await response.text());
      setStatus("");
    } else {
      showMessage(sentenceFor(response.status));
      setStatus("");
    }
  } catch {
    setOrigin(S.originTyped, S.originTypedDetail);
    showMessage(S.unreachable);
    setStatus("");
  } finally {
    setBusy(false);
    reveal();
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void ask();
});

// Enter asks; Shift with Enter keeps its line break. A key press that belongs to an input method is left alone.
questionField.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    form.requestSubmit();
  }
});

async function start(): Promise<void> {
  setStatus(S.loadingPrepared);
  try {
    const response = await fetch("/api/answers/pinned");
    if (response.status !== 200) throw new Error("pinned");
    const pinned = (await response.json()) as PinnedDocument;
    listPrepared(pinned);
    ready = pinned.protocols.length > 0;
    protocolField.disabled = !ready;
    submit.disabled = !ready;
    setStatus("");
  } catch {
    setStatus(S.preparedFailed);
  }
}

void start();
