/**
 * The page script. It takes the access token from the address fragment, fetches each view from this origin and
 * puts it on the page with the kit's `interpret` and `mount`. It builds no element and parses no markup itself:
 * everything drawn is a tree from the kit or from the desk's tree builders, and every text arrives as text.
 */
import { interpret } from "../ui/interpret";
import { mount } from "../ui/mount";
import type { UiNode } from "../ui/types";
import {
  agentLogTree, agentStatusTree, DESK_VIEW_IDS, explainTree, IDS, noticeTree, refusalTree, sourceTree, unavailableTree, viewTree,
  type AgentInfo, type AnswerBody, type Exchange, type PositionsInfo,
} from "./chrome";
import { nextPreviousResponseId } from "./followup";
import { DESK_STRINGS as S } from "./strings";

const TOKEN_KEY = "desk-token";
const exchanges: Exchange[] = [];
let token: string | null = null;
let previousResponseId: string | null = null;
let agentEnabled = false;
let asking = false;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function draw(id: string, tree: UiNode): void {
  const element = document.getElementById(id);
  if (element) mount(tree, element);
}

function say(id: string, text: string): void {
  const element = document.getElementById(id);
  if (element) element.textContent = text;
}

/** The token arrives once, in the fragment, and is taken out of the address bar. A reload finds it in this tab's session. */
function takeToken(): string | null {
  const match = /^#token=([0-9a-f]{64})$/.exec(location.hash);
  if (match) {
    try {
      sessionStorage.setItem(TOKEN_KEY, match[1]);
    } catch { /* a page without session storage keeps the token in memory only */ }
    history.replaceState(null, "", location.pathname);
    return match[1];
  }
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

async function api(path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { "x-desk-token": token ?? "" };
  if (body !== undefined) headers["content-type"] = "application/json";
  try {
    const response = await fetch(path, { method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" });
    let parsed: unknown = null;
    try {
      parsed = await response.json();
    } catch { /* an empty or unreadable body is no body */ }
    return { status: response.status, body: parsed };
  } catch {
    return { status: 0, body: null };
  }
}

/** Draws served messages into a slot, or the line that says why there is no view. Returns the messages when drawn. */
function drawServed(slotId: string, answer: { status: number; body: unknown }, messages: unknown): unknown[] | null {
  if (answer.status === 200 && Array.isArray(messages)) {
    try {
      draw(slotId, viewTree(interpret(messages)));
      return messages;
    } catch {
      draw(slotId, unavailableTree(String(answer.status)));
      return null;
    }
  }
  if (answer.status === 403) draw(slotId, noticeTree(S.tokenMissing));
  else if (isRecord(answer.body) && Array.isArray(answer.body.codes)) draw(slotId, refusalTree(answer.body.codes.map(String)));
  else draw(slotId, unavailableTree(String(answer.status)));
  return null;
}

/** The rule ids of the plain-words rows: what "explain further" can be asked about. */
function wordRuleIds(messages: unknown[]): string[] {
  for (const message of messages) {
    const model = isRecord(message) && isRecord(message.updateDataModel) ? message.updateDataModel.value : null;
    const results = isRecord(model) ? model.results : null;
    const words = isRecord(results) ? results.words : null;
    if (isRecord(words) && Array.isArray(words.rows)) return words.rows.filter(isRecord).map((row) => row.key).filter((key): key is string => typeof key === "string");
  }
  return [];
}

async function loadView(view: string): Promise<void> {
  const answer = await api(`/api/desk/surface/${view}`);
  const drawn = drawServed(IDS.view(view), answer, answer.body);
  if (view === "words") draw(IDS.explain, explainTree(drawn ? wordRuleIds(drawn) : []));
}

async function loadPositions(): Promise<void> {
  const answer = await api("/api/desk/positions");
  const info = isRecord(answer.body) ? answer.body : {};
  drawServed(IDS.view("positions"), answer, info.surface);
  if (answer.status === 200 && Array.isArray(info.addresses) && typeof info.readerHost === "string") draw(IDS.source, sourceTree(info as unknown as PositionsInfo));
}

function setDisabled(id: string, disabled: boolean): void {
  const element = document.getElementById(id);
  if (!element) return;
  if (disabled) element.setAttribute("disabled", "");
  else element.removeAttribute("disabled");
}

async function loadAgent(): Promise<void> {
  const answer = await api("/api/desk/agent");
  const info: AgentInfo = isRecord(answer.body) && typeof answer.body.enabled === "boolean"
    ? (answer.body as unknown as AgentInfo)
    : { enabled: false, reason: null, text: S.agentNotDemonstrated };
  agentEnabled = info.enabled;
  draw(IDS.agentStatus, agentStatusTree(info));
  setDisabled(IDS.ask, !agentEnabled || asking);
  setDisabled(IDS.question, !agentEnabled);
}

async function loadAll(): Promise<void> {
  await Promise.all([loadPositions(), ...DESK_VIEW_IDS.map(loadView), loadAgent()]);
}

async function addAddress(): Promise<void> {
  const field = document.getElementById(IDS.address);
  if (!(field instanceof HTMLInputElement)) return;
  const address = field.value.trim();
  if (address === "") return;
  setDisabled(IDS.addressAdd, true);
  const answer = await api("/api/desk/addresses", { address });
  setDisabled(IDS.addressAdd, false);
  if (answer.status === 200) {
    field.value = "";
    say(IDS.addressStatus, S.addressDone);
    await loadAll();
  } else if (answer.status === 400) say(IDS.addressStatus, S.addressMalformed);
  else if (answer.status === 429) say(IDS.addressStatus, S.addressLimit);
  else if (answer.status === 403) say(IDS.addressStatus, S.tokenMissing);
  else say(IDS.addressStatus, S.addressFailed);
}

function failureText(answer: { status: number; body: unknown }): string {
  if (answer.status === 422) return S.errorPrivate;
  if (answer.status === 409) return S.errorBusy;
  if (answer.status === 503) return S.errorDisabled;
  if (answer.status === 403) return S.tokenMissing;
  const error = isRecord(answer.body) && isRecord(answer.body.error) ? answer.body.error.cause : null;
  if (error === "unauthorized") return S.errorUnauthorized;
  if (error === "unreachable") return S.errorUnreachable;
  if (error === "timeout") return S.errorTimeout;
  if (error === "upstream") return S.errorUpstream;
  return S.errorBadRequest;
}

function isAnswer(body: unknown): body is AnswerBody {
  return isRecord(body) && typeof body.heading === "string" && Array.isArray(body.segments);
}

/** Sends one question, typed or prepared from a rule id, and shows what came back. */
async function ask(shown: string, request: Record<string, unknown>): Promise<void> {
  if (asking || !agentEnabled) {
    say(IDS.askStatus, asking ? S.errorBusy : S.errorDisabled);
    return;
  }
  asking = true;
  setDisabled(IDS.ask, true);
  say(IDS.askStatus, "");
  const at = exchanges.push({ question: shown, waiting: true }) - 1;
  draw(IDS.agentLog, agentLogTree(exchanges));
  const sent = previousResponseId;
  const answer = await api("/api/desk/ask", sent === null ? request : { ...request, previousResponseId: sent });
  const answered = answer.status === 200 && isAnswer(answer.body) ? answer.body : null;
  // A 400 on a follow-up drops the id it carried: the failure is shown as it is, and the next question starts afresh.
  previousResponseId = nextPreviousResponseId(sent, answer.status, answered?.responseId);
  if (answered) {
    exchanges[at] = { question: shown, answer: answered };
  } else {
    exchanges[at] = { question: shown, error: failureText(answer) };
    if (answer.status === 503) await loadAgent();
  }
  asking = false;
  setDisabled(IDS.ask, !agentEnabled);
  draw(IDS.agentLog, agentLogTree(exchanges));
}

function askTyped(): void {
  const field = document.getElementById(IDS.question);
  if (!(field instanceof HTMLTextAreaElement)) return;
  const question = field.value.trim();
  if (question === "") {
    say(IDS.askStatus, S.askEmpty);
    return;
  }
  field.value = "";
  void ask(question, { question });
}

function start(): void {
  token = takeToken();
  document.getElementById(IDS.addressAdd)?.addEventListener("click", () => void addAddress());
  document.getElementById(IDS.address)?.addEventListener("keydown", (event) => {
    if (event instanceof KeyboardEvent && event.key === "Enter") void addAddress();
  });
  document.getElementById(IDS.ask)?.addEventListener("click", askTyped);
  document.getElementById(IDS.question)?.addEventListener("keydown", (event) => {
    if (event instanceof KeyboardEvent && event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      askTyped();
    }
  });
  document.getElementById(IDS.explain)?.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest("[data-rule]") : null;
    const ruleId = button?.getAttribute("data-rule");
    if (typeof ruleId === "string" && ruleId !== "") void ask(`${S.explainFurther}: ${ruleId}`, { explain: { ruleId } });
  });
  document.getElementById(IDS.nav)?.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest("[data-go]") : null;
    const target = button?.getAttribute("data-go");
    if (typeof target === "string") document.getElementById(target)?.scrollIntoView({ block: "start" });
  });
  // A new launch address opened in the same tab changes only the fragment: take its token and draw again.
  window.addEventListener("hashchange", () => {
    if (!location.hash.startsWith("#token=")) return;
    token = takeToken();
    void loadAll();
  });
  void loadAll();
}

start();
