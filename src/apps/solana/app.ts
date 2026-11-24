/**
 * The page: it reads the address fragment, builds the shell for that route and fills each slot with a kit surface
 * that the validator accepted. A refused surface leaves "view refused:" with its codes and nothing of itself.
 * The shell is built element by element from the trees of `chrome.ts`; text arrives as text and no markup string
 * is ever parsed. Evidence is drawn by the kit's `mount` alone.
 */
import { allowedAttr, allowedTag } from "../../ui/html";
import { mount, type SelectKind } from "../../ui/mount";
import type { A2uiMessage, GraphResult, ReceiptRecord, UiNode } from "../../ui/types";
import {
  IDS, OVERVIEW_BLOCKS, askView, drawerTree, indexView, navTree, positionsView, preflightView, protocolView, refusedTree, themeTree, type AskAnswerContext,
} from "./chrome";
import { render, resolverOver } from "./compose";
import { PREFIX, RESULT, findSeries, type AppData, type PackData, type PreparedAnswers, type ReadData, type SeriesData } from "./model";
import { formatRoute, parseRoute, type ReadSource, type Route } from "./route";
import { initialState, reduce, type Action, type ExplorerState, type PageState, type Theme } from "./state";
import { APP_STRINGS as S, LAYERS } from "./strings";
import { drawerSurface, headerSurface, indexSurface, positionsSurface, sheetSurface, sheetView, tabSurface, tablesSurface, type Selection } from "./surfaces";

const TOKEN_KEY = "solana-app-token";
const THEME_CLASS: Record<Theme, string> = { auto: "sx lk-page", light: "sx lk-page lk-theme-light", dark: "sx lk-page lk-theme-dark" };

export interface AppEnv {
  document: Document;
  location: { hash: string };
  /** Registers a listener for `hashchange`. */
  addEventListener: (type: string, handler: () => void) => void;
  sessionStorage?: { getItem(key: string): string | null; setItem(key: string, value: string): void };
  /** Requests to the page's own origin. Left out in a static build, which makes none. */
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  data: AppData;
}

export interface AppOptions {
  /** Receipt ids taken out of what a surface may cite, to show that an unresolved citation refuses the view. */
  dropReceiptIds?: string[];
}

export interface App {
  /** Draws the current route again. */
  draw(): void;
  /** Resolves when no read or answer is on its way. */
  settled(): Promise<void>;
}

/** What selecting something in a mounted region means: which series its graph belongs to, and which explorer it moves. */
interface SelectContext { pack: string; series: string; explorerKey: string | null }
interface Region { slot: string; messages: A2uiMessage[] | null; select?: SelectContext | "evidence"; sections?: boolean; aside?: string }
interface Wire { slots: Map<string, Element>; fields: Map<string, Element> }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function startApp(env: AppEnv, options: AppOptions = {}): App {
  const { document: doc, data } = env;
  const known = new Set(Object.keys(data.receipts));
  let state: PageState = initialState();
  let wire: Wire = { slots: new Map(), fields: new Map() };
  let drawn = "";
  let token: string | null = null;
  let returnTo: Element | null = null;
  let goToMissing = false;
  let pending: Promise<void> = Promise.resolve();
  const reads: Partial<Record<ReadSource, ReadData | { error: string }>> = {};
  for (const read of data.positions?.reads ?? []) reads[read.source] = read;
  const reading = new Set<ReadSource>();
  let pinnedAsked = false;
  let pinnedReady = false;
  let pinnedFailed = false;
  let prepared: PreparedAnswers | null = null;
  let askProtocol = "";
  let askQuestion = "";
  let answerContext: AskAnswerContext = {};
  let answer: { messages: A2uiMessage[] | null; refused: string[] | null; loading: boolean } = { messages: null, refused: null, loading: false };

  const dispatch = (action: Action): void => {
    state = reduce(state, action);
  };
  const readReceipts = (): Record<string, ReceiptRecord> => Object.assign({}, ...Object.values(reads).filter((read): read is ReadData => read !== undefined && !("error" in read)).map((read) => read.receipts));
  const resolver = () => resolverOver(known, Object.keys(readReceipts()), options.dropReceiptIds ?? []);

  /* ---------- the shell, element by element ---------- */

  function build(node: UiNode, into: Wire): Element | null {
    if (node === null || typeof node !== "object" || !allowedTag(node.tag)) return null;
    const element = doc.createElement(node.tag);
    const attrs = node.attrs ?? {};
    for (const name of Object.keys(attrs)) if (allowedAttr(name)) element.setAttribute(name, String(attrs[name]));
    if (typeof node.text === "string" && node.text !== "") element.textContent = node.text;
    const children: Element[] = [];
    for (const child of node.children ?? []) {
      const built = build(child, into);
      if (built) children.push(built);
    }
    if (children.length > 0) element.append(...children);
    const fragment = attrs["data-go"];
    if (typeof fragment === "string") element.addEventListener("click", () => navigate(fragment));
    const action = attrs["data-act"];
    if (typeof action === "string") element.addEventListener("click", () => perform(action, attrs["data-arg"] ?? ""));
    if (typeof attrs["data-slot"] === "string") into.slots.set(attrs["data-slot"], element);
    if (typeof attrs["data-field"] === "string") {
      into.fields.set(attrs["data-field"], element);
      if (attrs["data-field"] === "protocol") element.addEventListener("change", () => { askProtocol = fieldValue("protocol"); });
      if (attrs["data-field"] === "question") element.addEventListener("input", () => { askQuestion = (element as HTMLInputElement).value; });
      const onEnter = attrs["data-enter"];
      if (typeof onEnter === "string") {
        element.addEventListener("keydown", (event: Event) => {
          if ((event as KeyboardEvent).key !== "Enter") return;
          if (typeof event.preventDefault === "function") event.preventDefault();
          perform(onEnter, "");
        });
      }
    }
    return element;
  }

  function place(tree: UiNode, target: Element | null, into: Wire = wire): void {
    if (!target) return;
    const built = build(tree, into);
    if (built) target.replaceChildren(built);
    else target.replaceChildren();
  }

  const fieldValue = (name: string): string => {
    const element = wire.fields.get(name) as (Element & { value?: unknown }) | undefined;
    return element && typeof element.value === "string" ? element.value.trim() : "";
  };

  /* ---------- regions: a validated surface, or the line that says it was refused ---------- */

  function fill(region: Region, into: Wire = wire): void {
    const target = into.slots.get(region.slot);
    if (!target || region.messages === null) return;
    const rendered = render(region.messages, resolver());
    if (!rendered.ok) {
      place(refusedTree(rendered.codes, rendered.codes.includes("graph-too-large") ? region.aside : undefined), target, into);
      return;
    }
    const context = region.select;
    mount(rendered.tree, target, context === undefined ? undefined : { onSelect: (kind, id) => select(context, kind, id) });
  }

  /** The Overview: one accepted surface whose sections are placed one by one into the five blocks. */
  function fillBlocks(messages: A2uiMessage[]): void {
    const rendered = render(messages, resolver());
    if (!rendered.ok) {
      place(refusedTree(rendered.codes), wire.slots.get("block-0") ?? null);
      return;
    }
    const sections = rendered.tree.root.children[0]?.children ?? [];
    OVERVIEW_BLOCKS.forEach((_, at) => {
      const target = wire.slots.get(`block-${at}`);
      if (target && sections[at]) mount(sections[at], target);
    });
  }

  /* ---------- selection ---------- */

  function select(context: SelectContext | "evidence", kind: SelectKind, id: string): void {
    if (kind === "evidence") return openDrawer({ kind: "evidence", id });
    if (context === "evidence") return;
    if (kind === "edge") return openDrawer({ kind: "edge", pack: context.pack, series: context.series, key: id });
    if (kind === "group") {
      if (context.explorerKey === null) return;
      dispatch({ type: "expand", key: context.explorerKey, group: id });
      draw();
      return;
    }
    navigate(formatRoute({ view: "protocol", pack: context.pack, series: context.series, tab: "dependencies", focus: id }));
  }

  function drawDrawer(): void {
    const element = doc.getElementById(IDS.drawer);
    if (!element) return;
    if (state.drawer === null) {
      element.setAttribute("hidden", "");
      element.replaceChildren();
      return;
    }
    const { messages, missing } = drawerSurface(data, state.drawer, readReceipts());
    const own: Wire = { slots: new Map(), fields: new Map() };
    place(drawerTree(missing, messages === null), element, own);
    element.removeAttribute("hidden");
    if (messages !== null) fill({ slot: "drawer-body", messages, select: "evidence" }, own);
  }

  function openDrawer(selection: Selection): void {
    if (state.drawer === null) returnTo = doc.activeElement;
    dispatch({ type: "drawer", selection });
    drawDrawer();
  }

  function closeDrawer(): void {
    if (state.drawer === null) return;
    dispatch({ type: "drawer", selection: null });
    drawDrawer();
    const back = returnTo as (Element & { focus?: () => void }) | null;
    returnTo = null;
    if (back && typeof back.focus === "function") back.focus();
  }

  /* ---------- actions of the shell's controls ---------- */

  function navigate(fragment: string): void {
    if (env.location.hash !== fragment) env.location.hash = fragment;
    draw();
  }

  function currentExplorer(): { key: string; series: SeriesData; pack: PackData; route: Extract<Route, { view: "protocol" }> } | null {
    const route = parseRoute(env.location.hash);
    if (route.view !== "protocol" || route.tab !== "dependencies") return null;
    const pack = data.packs.find((candidate) => candidate.id === route.pack);
    const series = pack ? (route.series === null ? pack.series[0] : pack.series.find((candidate) => candidate.id === route.series)) : undefined;
    return pack && series ? { key: `${pack.id}/${series.id}`, series, pack, route } : null;
  }

  function perform(action: string, arg: string): void {
    if (action === "theme") {
      if (arg !== "auto" && arg !== "light" && arg !== "dark") return;
      dispatch({ type: "theme", theme: arg });
      drawTheme();
      return;
    }
    if (action === "close-drawer") return closeDrawer();
    if (action === "read-live") return void requestRead("live", fieldValue("address"));
    if (action === "ask") return void ask(fieldValue("question"));
    if (action === "prepared-answer") {
      const entry = prepared?.answers.find((item) => item.id === arg);
      if (!entry || answer.loading) return;
      askProtocol = entry.protocol;
      askQuestion = entry.question;
      answerContext = { preparedId: entry.id, origin: { title: S.askOriginPrepared, detail: entry.label } };
      const messages = linesToMessages(entry.ndjson);
      answer = messages ? { messages, refused: null, loading: false } : { messages: null, refused: ["schema"], loading: false };
      draw();
      revealAnswer();
      return;
    }
    const at = currentExplorer();
    if (!at) return;
    if (action === "steps") dispatch({ type: "steps", key: at.key, steps: Number(arg) });
    else if (action === "layer") dispatch({ type: "layer", key: at.key, layer: arg });
    else if (action === "goto") {
      const wanted = fieldValue("goto");
      const graph = at.series.results[RESULT.graph] as GraphResult;
      const lower = wanted.toLowerCase();
      const found = graph.nodes.find((node) => node.id === wanted || node.id === `${PREFIX}${wanted}`)
        ?? graph.nodes.find((node) => (node.name ?? "").toLowerCase() === lower && lower !== "")
        ?? (lower === "" ? undefined : graph.nodes.filter((node) => (node.name ?? "").toLowerCase().includes(lower)).find((_, n, all) => all.length === 1 && n === 0));
      goToMissing = found === undefined;
      if (found) return navigate(formatRoute({ view: "protocol", pack: at.pack.id, series: at.series.id, tab: "dependencies", focus: found.id }));
    } else return;
    draw();
  }

  /* ---------- reads and answers: the only requests the page makes, both to its own origin ---------- */

  function track(work: Promise<void>): Promise<void> {
    pending = pending.then(() => work, () => work);
    return work;
  }

  async function requestRead(source: ReadSource, address: string): Promise<void> {
    if (!env.fetch || data.mode !== "served") return;
    if (reading.has(source)) return;
    reading.add(source);
    delete reads[source];
    draw();
    await track((async () => {
      try {
        const response = await env.fetch!("/api/positions", {
          method: "POST", headers: { "content-type": "application/json", "x-app-token": token ?? "" }, body: JSON.stringify({ source, address }), cache: "no-store",
        });
        const body: unknown = response.status === 200 || response.status === 400 ? await response.json().catch(() => null) : null;
        if (response.status === 200 && isRecord(body) && isRecord(body.list) && Array.isArray(body.sheets)) reads[source] = body as unknown as ReadData;
        else reads[source] = { error: isRecord(body) && typeof body.error === "string" ? body.error : String(response.status) };
      } catch {
        reads[source] = { error: "not-reached" };
      }
      reading.delete(source);
    })());
    draw();
  }

  /** An NDJSON reply as a message list: one A2UI message per non-empty line. */
  function linesToMessages(text: string): A2uiMessage[] | null {
    try {
      return text.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as A2uiMessage);
    } catch {
      return null;
    }
  }

  /** A selected answer replaces the controls; give keyboard readers its new context. */
  function revealAnswer(): void {
    if (parseRoute(env.location.hash).view !== "ask") return;
    const target = doc.getElementById("sx-ask-answer") as HTMLElement | null;
    target?.focus?.({ preventScroll: true });
    target?.scrollIntoView?.({ block: "start" });
  }

  async function ask(question: string, pinned = false): Promise<void> {
    if (!env.fetch || !data.ask.enabled || (!pinned && question === "")) return;
    // Keyboard activation obeys the same loading boundary as the buttons.
    // The first prepared document supplies the protocol for a typed ask.
    if (!pinned && (!pinnedReady || answer.loading)) return;
    pinnedAsked = true;
    if (pinned) { pinnedReady = false; pinnedFailed = false; }
    if (!pinned) {
      askProtocol = fieldValue("protocol") || askProtocol;
      askQuestion = question;
      answerContext = { origin: { title: S.askOriginTyped, detail: S.askOriginTypedDetail } };
    }
    answer = { messages: null, refused: null, loading: true };
    draw();
    await track((async () => {
      try {
        const response = pinned
          ? await env.fetch!("/api/answers/pinned", { method: "GET", cache: "no-store" })
          : await env.fetch!("/api/answers/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question, protocol: askProtocol }), cache: "no-store" });
        const text = await response.text();
        if (response.status === 200 && pinned && response.headers.get("content-type")?.includes("application/json")) {
          const document: unknown = JSON.parse(text);
          if (!isRecord(document) || typeof document.label !== "string" || !Array.isArray(document.protocols) || !document.protocols.every((item) => isRecord(item) && typeof item.id === "string" && typeof item.title === "string") || !Array.isArray(document.answers) || !document.answers.every((item) => isRecord(item) && typeof item.id === "string" && typeof item.question === "string" && typeof item.protocol === "string" && typeof item.label === "string" && typeof item.ndjson === "string")) throw new Error("prepared-schema");
          prepared = document as unknown as PreparedAnswers;
          askProtocol = prepared.protocols[0]?.id ?? "";
          pinnedReady = askProtocol !== "";
          answer = { messages: null, refused: null, loading: false };
        } else if (response.status === 200) {
          const messages = linesToMessages(text);
          if (pinned) pinnedReady = messages !== null;
          answer = messages ? { messages, refused: null, loading: false } : { messages: null, refused: ["schema"], loading: false };
        } else {
          let codes: string[] = [String(response.status)];
          try {
            const body: unknown = JSON.parse(text);
            if (isRecord(body) && Array.isArray(body.refused)) codes = body.refused.map(String);
            else if (isRecord(body) && typeof body.error === "string") codes = [body.error];
          } catch { /* a reply that is not JSON keeps its status as the code */ }
          answer = { messages: null, refused: codes, loading: false };
        }
      } catch {
        answer = { messages: null, refused: ["not-reached"], loading: false };
      }
      if (pinned) pinnedFailed = !pinnedReady;
    })());
    draw();
    if (!pinned) revealAnswer();
  }

  /* ---------- views ---------- */

  function drawTheme(): void {
    const root = doc.getElementById(IDS.root);
    if (root) root.setAttribute("class", THEME_CLASS[state.theme]);
    place(themeTree(state.theme), doc.getElementById(IDS.theme), { slots: new Map(), fields: new Map() });
  }

  function drawIndex(notFound: boolean): void {
    place(indexView(data, notFound), doc.getElementById(IDS.main));
    for (const pack of data.packs) fill({ slot: `index-${pack.id}`, messages: indexSurface(data, pack), select: "evidence" });
  }

  function drawProtocol(route: Extract<Route, { view: "protocol" }>): boolean {
    const pack = data.packs.find((candidate) => candidate.id === route.pack);
    const series = pack ? (route.series === null ? pack.series[0] : pack.series.find((candidate) => candidate.id === route.series)) : undefined;
    if (!pack || !series) return false;
    const key = `${pack.id}/${series.id}`;
    let explorer: ExplorerState | undefined;
    if (route.tab === "dependencies") {
      dispatch({ type: "open", key, focus: route.focus ?? series.focus, steps: 1 });
      dispatch({ type: "focus", key, focus: route.focus ?? series.focus });
      explorer = state.explorers[key];
    }
    place(protocolView({ data, pack, series, tab: route.tab, explorer, goToMissing }), doc.getElementById(IDS.main));
    goToMissing = false;
    fill({ slot: "header", messages: headerSurface(data, pack, series), select: "evidence" });
    if (route.tab === "overview") fillBlocks(tabSurface(data, pack, series, "overview"));
    else if (route.tab === "dependencies") {
      const view = { focus: explorer!.focus, steps: explorer!.steps, layers: explorer!.layers, expanded: explorer!.expanded };
      fill({ slot: "explorer", messages: tabSurface(data, pack, series, "dependencies", view), select: { pack: pack.id, series: series.id, explorerKey: key }, aside: S.tooLargeAside });
      fill({ slot: "tables", messages: tablesSurface(data, pack, series), select: "evidence" });
    } else fill({ slot: "tab", messages: tabSurface(data, pack, series, route.tab), select: "evidence" });
    return true;
  }

  function drawPositions(route: Extract<Route, { view: "positions" }>): boolean {
    const source: ReadSource = route.read ?? "recorded";
    const served = data.mode === "served";
    if (source === "live" && !(served && data.live)) return false;
    const read = reads[source];
    if (read === undefined && served && source !== "live" && data.replayAddress !== null && !reading.has(source)) {
      void requestRead(source, data.replayAddress);
      return true;
    }
    const shown = read === undefined ? "loading" as const : "error" in read ? read : { positions: read.list.rows.length, constructed: read.constructed };
    const ordinal = read !== undefined && !("error" in read) && route.ordinal !== null && read.sheets.some((sheet) => sheet.ordinal === route.ordinal) ? route.ordinal : null;
    if (route.ordinal !== null && read !== undefined && !("error" in read) && ordinal === null) return false;
    place(positionsView({ read: source, live: served && data.live, served, state: shown, ordinal }), doc.getElementById(IDS.main));
    if (read === undefined || "error" in read) return true;
    fill({ slot: "positions", messages: positionsSurface(read), select: "evidence" });
    if (ordinal !== null) {
      const sheet = read.sheets.find((candidate) => candidate.ordinal === ordinal)!;
      const key = `sheet/${source}/${ordinal}`;
      if (sheet.join) dispatch({ type: "open", key, focus: sheet.join.account, steps: 2, layers: LAYERS.slice(1).map((layer) => layer.name) });
      const view = sheet.join ? sheetView(sheet.join.account, state.explorers[key]?.expanded ?? []) : undefined;
      fill({
        slot: "sheet", messages: sheetSurface(data, read, ordinal, view), aside: S.tooLargeAside,
        select: sheet.join && findSeries(data, sheet.join.pack, sheet.join.series) ? { pack: sheet.join.pack, series: sheet.join.series, explorerKey: key } : "evidence",
      });
    }
    return true;
  }

  function drawAsk(): void {
    place(askView(data.ask.enabled, answer.loading ? "loading" : answer.messages || answer.refused ? "drawn" : "idle", prepared, askProtocol, askQuestion, pinnedReady, answerContext), doc.getElementById(IDS.main));
    if (!data.ask.enabled) return;
    if (!pinnedAsked) {
      pinnedAsked = true;
      void ask("", true);
      return;
    }
    if (answer.refused) place(refusedTree(answer.refused), wire.slots.get("answer") ?? null);
    else if (answer.messages) fill({ slot: "answer", messages: answer.messages, select: "evidence" });
  }

  function draw(): void {
    let route = parseRoute(env.location.hash);
    // A failure stays visible on this visit. Re-entering Ask retries it,
    // without making the completion's redraw an automatic retry loop.
    if (route.view === "ask" && parseRoute(drawn).view !== "ask" && pinnedFailed) pinnedAsked = false;
    if (route.view === "token") {
      token = route.token;
      try {
        env.sessionStorage?.setItem(TOKEN_KEY, route.token);
      } catch { /* a page without session storage keeps the token in memory only */ }
      env.location.hash = "#/protocols";
      route = { view: "protocols" };
    }
    drawn = env.location.hash;
    wire = { slots: new Map(), fields: new Map() };
    place(navTree(route), doc.getElementById(IDS.nav), { slots: new Map(), fields: new Map() });
    let found = true;
    if (route.view === "protocols") drawIndex(false);
    else if (route.view === "protocol") found = drawProtocol(route);
    else if (route.view === "positions") found = drawPositions(route);
    else if (route.view === "ask") drawAsk();
    else if (route.view === "preflight") place(preflightView(), doc.getElementById(IDS.main));
    else found = false;
    if (!found) {
      wire = { slots: new Map(), fields: new Map() };
      drawIndex(true);
    }
  }

  try {
    token = env.sessionStorage?.getItem(TOKEN_KEY) ?? null;
  } catch {
    token = null;
  }
  env.addEventListener("hashchange", () => {
    if (env.location.hash !== drawn) draw();
  });
  doc.addEventListener("keydown", (event: Event) => {
    if ((event as KeyboardEvent).key === "Escape" && state.drawer !== null) closeDrawer();
  });
  drawTheme();
  draw();
  return { draw, settled: () => pending };
}

/** Reads the data block of the document. `null` when the page holds none. */
export function readData(doc: Document): AppData | null {
  const element = doc.getElementById(IDS.data);
  if (!element || typeof element.textContent !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(element.textContent);
    return isRecord(parsed) && parsed.version === 1 && Array.isArray(parsed.packs) ? (parsed as unknown as AppData) : null;
  } catch {
    return null;
  }
}
