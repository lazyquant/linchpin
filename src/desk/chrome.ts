/**
 * Everything the desk draws itself, as trees of plain objects: the page frame, the source line, the refusal line,
 * the fold around a long table or list of a view, and the agent panel. The trees go onto the page through the kit's `mount` and into the served document through
 * the kit's `treeToHtml`, so the desk has no code that builds elements or markup. Every fixed word is a desk string;
 * every other text is drawn as text.
 */
import type { SurfaceTree, UiNode } from "../ui/types";
import type { AnswerSegment } from "./answer";
import { DESK_STRINGS as S } from "./strings";

export const DESK_VIEW_IDS = ["verdict", "map", "words", "changes", "unknowns"] as const;

/** Element ids the page script looks up. */
export const IDS = Object.freeze({
  source: "desk-source",
  nav: "desk-nav",
  view: (name: string): string => `desk-view-${name}`,
  region: (name: string): string => `desk-region-${name}`,
  explain: "desk-explain",
  address: "desk-address",
  addressAdd: "desk-address-add",
  addressStatus: "desk-address-status",
  agentStatus: "desk-agent-status",
  agentLog: "desk-agent-log",
  question: "desk-question",
  ask: "desk-ask",
  askStatus: "desk-ask-status",
});

function el(tag: string, className: string, text?: string, children: UiNode[] = [], attrs: Record<string, string> = {}): UiNode {
  const node: UiNode = { tag, attrs: className ? { class: className, ...attrs } : { ...attrs }, children };
  if (text !== undefined) node.text = text;
  return node;
}

/* ---------- what the desk reads from its own routes ---------- */

export interface PositionsInfo {
  book: "synthetic" | "file" | "none";
  readerHost: string;
  addresses: { ordinal: number; chain: string; address: string; status: string; reason: string | null }[];
}
export interface AgentInfo { enabled: boolean; reason: string | null; text: string | null }
export interface AnswerBody { responseId: string | null; heading: string; segments: AnswerSegment[]; toolCalls: string[] | null }
export type Exchange = { question: string } & ({ answer: AnswerBody } | { error: string } | { waiting: true });

/* ---------- views ---------- */

/** A table or a list of a view with more rows than this is drawn folded. */
export const FOLD_OVER_ROWS = 6;

const hasClass = (node: UiNode, name: string): boolean => (node.attrs.class ?? "").split(/\s+/).includes(name);
const FOLDED_LISTS = ["lk-graph-nodes", "lk-graph-edges", "lk-unknowns"];

/** The rows of a node the kit drew as a table or as one of its long lists; null for any other node. */
function rowsIn(node: UiNode): number | null {
  if (node.tag === "table" && hasClass(node, "lk-table")) {
    return node.children.filter((child) => child.tag === "tbody").reduce((count, body) => count + body.children.length, 0);
  }
  if (node.tag === "ul" && FOLDED_LISTS.some((name) => hasClass(node, name))) return node.children.length;
  return null;
}

/**
 * The same nodes, with every long table and list inside a native disclosure that starts closed. The summary line
 * names what is folded and counts its rows: the kit's own label where the kit drew one in front of the list (the
 * nodes and the edges of a graph), else the desk's word for rows. The folded node is the kit's, unchanged, so each
 * row keeps its basis, its observation and its evidence; nothing is left out and nothing is fetched on opening.
 */
function foldLong(nodes: UiNode[]): UiNode[] {
  const out: UiNode[] = [];
  for (const node of nodes) {
    const rows = rowsIn(node);
    if (rows === null) {
      out.push(node.tag === "svg" || node.children.length === 0 ? node : { ...node, children: foldLong(node.children) });
      continue;
    }
    if (rows <= FOLD_OVER_ROWS) {
      out.push(node);
      continue;
    }
    const before = out[out.length - 1];
    const label = before !== undefined && before.tag === "p" && hasClass(before, "lk-list-label") ? before : null;
    if (label !== null) out.pop();
    const summary = label !== null
      ? el("summary", "lk-list-label desk-fold-summary", label.text, label.children)
      : el("summary", "lk-list-label desk-fold-summary", S.foldRows, [el("span", "lk-count", String(rows))]);
    out.push(el("details", "desk-fold", undefined, [summary, node]));
  }
  return out;
}

/**
 * A drawn surface as one block of the page: the kit's tree without its own page frame, its long tables and lists
 * folded. What stays open is everything short: the verdict, the summary, the legend, each map's drawing with its
 * marks, the coverage notes.
 */
export function viewTree(tree: SurfaceTree): UiNode {
  return el("div", "desk-view", undefined, foldLong(tree.root.children));
}

/** The line shown instead of a view the server refused. */
export function refusalTree(codes: string[]): UiNode {
  return el("p", "lk-empty desk-refused", `${S.viewRefused} ${codes.join(", ")}`, [], { role: "alert" });
}

export function unavailableTree(what: string): UiNode {
  return el("p", "lk-empty desk-refused", `${S.viewUnavailable} ${what}`, [], { role: "alert" });
}

export function noticeTree(text: string): UiNode {
  return el("p", "lk-empty", text);
}

function pair(label: string, value: string, mono = false): UiNode {
  return el("span", "lk-pair", undefined, [el("span", "lk-pair-label", label), el("span", mono ? "lk-value lk-mono" : "lk-value", value)]);
}

/** Where the positions come from, the host the reader asks, and how many addresses were given. No address is drawn here. */
export function sourceTree(info: PositionsInfo): UiNode {
  const book = info.book === "synthetic" ? S.sourceSynthetic : info.book === "file" ? S.sourceFile : S.sourceNone;
  return el("div", "lk-pairs desk-source-line", undefined, [
    pair(S.sourceLabel, book),
    pair(S.readerHostLabel, info.readerHost, true),
    pair(S.addressesLabel, String(info.addresses.length)),
  ]);
}

/** One button per rule that is not within policy. The button carries the rule id and nothing else. */
export function explainTree(ruleIds: string[]): UiNode {
  if (ruleIds.length === 0) return el("div", "desk-explain-list");
  return el("div", "desk-explain-list", undefined, [
    el("p", "lk-pair-label", S.explainLabel),
    el("ul", "desk-buttons", undefined, ruleIds.map((ruleId) => el("li", "", undefined, [
      el("button", "desk-button", `${S.explainFurther}: ${ruleId}`, [], { type: "button", "data-rule": ruleId }),
    ]))),
  ]);
}

/* ---------- agent panel ---------- */

const REASONS: Record<string, string> = {
  "token-missing": S.reasonTokenMissing,
  "url-not-loopback": S.reasonUrlNotLoopback,
  "url-invalid": S.reasonUrlInvalid,
};

/** The panel's state line: nothing when it is available, else the fixed words and the reason. */
export function agentStatusTree(info: AgentInfo): UiNode {
  if (info.enabled) return el("div", "desk-agent-state");
  return el("div", "desk-agent-state", undefined, [
    el("p", "lk-empty desk-not-demonstrated", info.text ?? S.agentNotDemonstrated),
    el("p", "lk-scope", `${S.reasonLabel}: ${REASONS[info.reason ?? ""] ?? info.reason ?? ""}`),
  ]);
}

/**
 * An agent's answer. The prose is drawn as text, under the heading that says it is unchecked, and outside every
 * kit value component. An id that resolves is a reference; one that does not is struck through and says so.
 */
export function answerTree(answer: AnswerBody): UiNode {
  const prose: UiNode[] = [];
  for (const segment of answer.segments) {
    if ("text" in segment) prose.push(el("span", "", segment.text));
    else if (segment.resolves) prose.push(el("code", "desk-ref", segment.id));
    else prose.push(el("span", "desk-unresolved", undefined, [el("s", "lk-mono", segment.id), el("span", "lk-scope", ` ${S.notInSnapshot}`)]));
  }
  return el("div", "desk-answer", undefined, [
    el("p", "lk-pair-label desk-answer-heading", answer.heading),
    el("p", "lk-scope", S.agentHeadingNote),
    el("p", "desk-answer-text", undefined, prose),
    answer.toolCalls === null || answer.toolCalls.length === 0
      ? el("p", "lk-scope desk-tool-calls", S.toolCallsNotReported)
      : el("p", "desk-tool-calls", undefined, [el("span", "lk-pair-label", S.toolCalls), ...answer.toolCalls.map((name) => el("code", "lk-mono", name))]),
  ]);
}

/** The questions asked in this page and what came back for each, oldest first. */
export function agentLogTree(exchanges: Exchange[]): UiNode {
  return el("ol", "desk-log", undefined, exchanges.map((exchange) => el("li", "desk-exchange", undefined, [
    el("p", "desk-question-line", undefined, [el("span", "lk-pair-label", S.youAsked), el("span", "desk-question-text", exchange.question)]),
    "answer" in exchange ? answerTree(exchange.answer)
      : "error" in exchange ? el("p", "lk-empty desk-agent-error", exchange.error, [], { role: "alert" })
      : el("p", "lk-scope", S.askWaiting),
  ])));
}

/* ---------- the page frame ---------- */

function region(name: string, label: string, extra: UiNode[] = []): UiNode {
  return el("section", "desk-region", undefined, [
    el("div", "desk-slot", undefined, [el("p", "lk-scope", S.loading)], { id: IDS.view(name) }),
    ...extra,
  ], { id: IDS.region(name), "aria-label": label });
}

/** The static frame of the page. It holds labels only: no value of a book, a policy or a snapshot, and no token. */
export function pageTree(): UiNode {
  const addressField = el("div", "desk-address", undefined, [
    el("label", "lk-pair-label", S.addressLabel, [], { for: IDS.address }),
    el("div", "desk-field-row", undefined, [
      el("input", "desk-input lk-mono", undefined, [], { id: IDS.address, type: "text", autocomplete: "off", spellcheck: "false", autocapitalize: "off", placeholder: S.addressPlaceholder }),
      el("button", "desk-button", S.addressButton, [], { id: IDS.addressAdd, type: "button" }),
    ]),
    el("p", "lk-scope", S.addressHint),
    el("p", "lk-scope desk-status", "", [], { id: IDS.addressStatus, role: "status" }),
  ]);
  const labels: Record<string, string> = { verdict: S.regionVerdict, map: S.regionMap, words: S.regionWords, changes: S.regionChanges, unknowns: S.regionUnknowns };
  return el("div", "lk-surface desk-page", undefined, [
    el("header", "desk-top", undefined, [
      el("p", "lk-eyebrow", undefined, [el("span", "lk-pair-label", S.loopbackNote)]),
      el("h1", "", S.pageTitle),
      el("p", "lk-note", S.pageLede),
      el("div", "desk-slot", undefined, [], { id: IDS.source }),
    ]),
    // The page is long: one button per region moves the reader there. A button carries a region id and nothing else.
    el("nav", "desk-nav", undefined, [["positions", S.regionPositions], ...DESK_VIEW_IDS.map((view): [string, string] => [view, labels[view]]), ["agent", S.regionAgent]]
      .map(([name, label]) => el("button", "desk-button desk-nav-button", label, [], { type: "button", "data-go": IDS.region(name) })), { id: IDS.nav, "aria-label": S.navLabel }),
    el("div", "desk-layout", undefined, [
      el("main", "desk-main", undefined, [
        region("positions", S.regionPositions, [addressField]),
        ...DESK_VIEW_IDS.map((view) => region(view, labels[view], view === "words" ? [el("div", "desk-slot", undefined, [], { id: IDS.explain })] : [])),
      ]),
      el("aside", "desk-agent", undefined, [
        el("section", "lk-section", undefined, [
          el("h2", "", S.regionAgent),
          el("p", "lk-scope", S.agentLede),
          el("div", "desk-slot", undefined, [], { id: IDS.agentStatus }),
          el("div", "desk-slot", undefined, [], { id: IDS.agentLog, "aria-live": "polite" }),
          el("label", "lk-pair-label", S.askLabel, [], { for: IDS.question }),
          el("textarea", "desk-input", undefined, [], { id: IDS.question, rows: "3" }),
          el("div", "desk-field-row", undefined, [el("button", "desk-button", S.askButton, [], { id: IDS.ask, type: "button" })]),
          el("p", "lk-scope desk-status", "", [], { id: IDS.askStatus, role: "status" }),
        ]),
      ], { id: IDS.region("agent"), "aria-label": S.regionAgent }),
    ]),
  ]);
}
