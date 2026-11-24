/**
 * The shell of the app as trees of plain objects: top bar, navigation, tabs, controls, the drawer frame, the status
 * line. It holds the app's own words and the ids a reader navigates by. It holds no evidence value: every value on
 * a page stands inside a slot that a validated kit surface fills.
 */
import type { UiNode } from "../../ui/types";
import { PREFIX, TABS, type AppData, type PackData, type PreparedAnswers, type SeriesData, type TabId } from "./model";
import { formatRoute, type ReadSource, type Route } from "./route";
import type { ExplorerState, Theme } from "./state";
import { APP_STRINGS as S, LAYERS } from "./strings";

export const IDS = Object.freeze({ root: "app-root", nav: "app-nav", theme: "app-theme", main: "app-main", drawer: "app-drawer", status: "app-status", data: "app-data" });
/** The class of an element a kit surface is mounted into. The kit drops its page padding inside it. */
export const KIT_SLOT = "sx-kit lk-embedded";

export function h(tag: string, className: string, text?: string, children: UiNode[] = [], attrs: Record<string, string> = {}): UiNode {
  const node: UiNode = { tag, attrs: className ? { class: className, ...attrs } : { ...attrs }, children };
  if (text !== undefined) node.text = text;
  return node;
}
const slot = (name: string, className = KIT_SLOT): UiNode => h("div", className, undefined, [], { "data-slot": name });
const go = (className: string, text: string, fragment: string, attrs: Record<string, string> = {}): UiNode => h("button", className, text, [], { type: "button", "data-go": fragment, ...attrs });
const act = (className: string, text: string, action: string, arg: string, attrs: Record<string, string> = {}): UiNode =>
  h("button", className, text, [], { type: "button", "data-act": action, "data-arg": arg, ...attrs });
const short = (id: string): string => (id.startsWith(PREFIX) ? id.slice(PREFIX.length) : id);

/** The fixed frame of the document. The page script fills the navigation, the main region and the drawer. */
export function frameTree(): UiNode {
  return h("div", "sx lk-page", undefined, [
    h("header", "sx-top", undefined, [h("div", "sx-top-inner", undefined, [
      h("span", "sx-brand", undefined, [h("span", "sx-brand-name", S.brand), h("span", "sx-brand-chain", S.chain)]),
      h("nav", "sx-nav", undefined, [], { id: IDS.nav, "aria-label": S.pageTitle }),
      h("div", "sx-top-right", undefined, [h("span", "sx-mock", S.offline), h("div", "sx-theme-box", undefined, [], { id: IDS.theme })]),
    ])]),
    h("main", "sx-main", undefined, [], { id: IDS.main, tabindex: "-1" }),
    h("aside", "sx-drawer", undefined, [], { id: IDS.drawer, hidden: "", "aria-label": S.drawerTitle }),
    h("footer", "sx-foot", undefined, [h("p", "", S.status, [], { id: IDS.status })]),
  ], { id: IDS.root });
}

const NAV: readonly { view: Route["view"]; label: string; fragment: string }[] = [
  { view: "protocols", label: S.navProtocols, fragment: "#/protocols" },
  { view: "positions", label: S.navPositions, fragment: "#/positions" },
  { view: "ask", label: S.navAsk, fragment: "#/ask" },
  { view: "preflight", label: S.navPreflight, fragment: "#/preflight" },
];

/** The navigation: exactly four destinations, in this order. */
export function navTree(route: Route): UiNode {
  const current = route.view === "protocol" || route.view === "not-found" ? "protocols" : route.view;
  return h("div", "sx-nav-list", undefined, NAV.map((item) => {
    const button = go("sx-nav-item", item.label, item.fragment, item.view === current ? { "aria-current": "page" } : {});
    if (item.view === "preflight") button.children = [h("span", "sx-nav-tag", S.reserved)];
    return button;
  }));
}

export function themeTree(theme: Theme): UiNode {
  const options: [Theme, string][] = [["auto", S.themeAuto], ["light", S.themeLight], ["dark", S.themeDark]];
  return h("div", "sx-seg", undefined, options.map(([value, label]) => act("", label, "theme", value, { "aria-pressed": String(value === theme) })), { role: "group", "aria-label": S.themeLabel });
}

export function refusedTree(codes: string[], aside?: string): UiNode {
  return h("div", "sx-refused-box", undefined, [
    h("p", "sx-refused", `${S.refused} ${codes.join(", ")}`),
    ...(aside ? [h("p", "sx-block-aside", aside)] : []),
  ]);
}
export const noticeTree = (text: string, className = "sx-notice"): UiNode => h("p", className, text);

function hero(eyebrow: string, title: string, lede: string): UiNode {
  return h("div", "sx-hero", undefined, [h("p", "sx-eyebrow", eyebrow), h("h1", "sx-display", title), h("p", "sx-lede", lede)]);
}

const firstTab = (pack: PackData, series: SeriesData, tab: TabId = "overview"): string => formatRoute({ view: "protocol", pack: pack.id, series: series.id, tab, focus: null });

/** The Protocols index: one ledger row per protocol with a slot for its counts, then what this build leaves out. */
export function indexView(data: AppData, notFound = false): UiNode {
  return h("div", "sx-view", undefined, [
    ...(notFound ? [h("p", "sx-not-found", S.notFound)] : []),
    hero(S.indexEyebrow, S.indexTitle, S.indexLede),
    h("div", "sx-ledger", undefined, data.packs.map((pack) => h("article", "sx-ledger-row", undefined, [
      h("div", "sx-ledger-name", undefined, [
        go("sx-ledger-title", pack.title, firstTab(pack, pack.series[0]), { "data-pack": pack.id }),
        h("p", "sx-ledger-line", pack.line),
        ...(pack.series.length > 1 ? [h("div", "sx-series", undefined, pack.series.map((series) => go("", series.title, firstTab(pack, series), { "data-series": series.id })), { role: "group", "aria-label": S.seriesLabel })] : []),
      ]),
      slot(`index-${pack.id}`),
    ], { "data-pack": pack.id }))),
    ...data.absent.map((entry) => h("p", "sx-absent", entry.line, [], { "data-absent": entry.id })),
    h("p", "sx-footnote", S.indexFootnote),
  ]);
}

const TAB_LABELS: Record<TabId, string> = {
  overview: S.tabOverview, control: S.tabControl, dependencies: S.tabDependencies, "value-path": S.tabValuePath, unknowns: S.tabUnknowns, changes: S.tabChanges,
};

/** The blocks of the Overview, in order: the id of the result each holds, its aside and the link to its tab. */
export const OVERVIEW_BLOCKS: readonly { id: string; aside: string; link: string; tab: TabId }[] = [
  { id: "who", aside: S.blockControlAside, link: S.blockControlLink, tab: "control" },
  { id: "rests", aside: S.blockRestsAside, link: S.blockRestsLink, tab: "dependencies" },
  { id: "routed", aside: S.blockValueAside, link: S.blockValueLink, tab: "value-path" },
  { id: "unknown", aside: S.blockUnknownAside, link: S.blockUnknownLink, tab: "unknowns" },
  { id: "changed", aside: S.blockChangedAside, link: S.blockChangedLink, tab: "changes" },
];

function wide(title: string, aside: string, body: UiNode[]): UiNode {
  return h("section", "sx-wide", undefined, [h("div", "sx-wide-head", undefined, [h("h2", "", title), h("p", "sx-block-aside", aside)]), ...body]);
}

/** The controls of the explorer: steps, layers, the trail and "go to". State of the page, not data. */
export function explorerControls(explorer: ExplorerState, trailFragment: (account: string) => string, missing: boolean): UiNode {
  return h("div", "gx-bar", undefined, [
    h("div", "gx-bar-group gx-bar-trail", undefined, [
      h("span", "sx-label", S.trailLabel),
      h("ol", "gx-trail", undefined, [
        ...explorer.trail.map((account) => h("li", "", undefined, [go("gx-trail-step", short(account), trailFragment(account))])),
        h("li", "gx-trail-here", short(explorer.focus), [], { "aria-current": "true" }),
      ]),
    ]),
    h("div", "gx-bar-group", undefined, [
      h("span", "sx-label", S.stepsLabel),
      h("div", "sx-seg", undefined, [1, 2, 3].map((steps) => act("", String(steps), "steps", String(steps), { "aria-pressed": String(explorer.steps === steps) })), { role: "group", "aria-label": S.stepsLabel }),
    ]),
    h("div", "gx-bar-group", undefined, [
      h("span", "sx-label", S.layersLabel),
      h("div", "sx-seg", undefined, LAYERS.map((layer) => act("", layer.name, "layer", layer.name, { "aria-pressed": String(explorer.layers.includes(layer.name)) })), { role: "group", "aria-label": S.layersLabel }),
    ]),
    h("div", "gx-bar-group gx-bar-jump", undefined, [
      h("label", "sx-label", S.goToLabel, [], { for: "gx-jump" }),
      h("div", "gx-jump-row", undefined, [
        h("input", "gx-jump", undefined, [], { id: "gx-jump", type: "text", placeholder: S.goToPlaceholder, autocomplete: "off", spellcheck: "false", "data-field": "goto", "data-enter": "goto" }),
        act("sx-btn", S.goToButton, "goto", ""),
      ]),
      ...(missing ? [h("p", "gx-hint", S.goToMissing)] : []),
    ]),
  ]);
}

export function legendTree(): UiNode {
  return h("div", "gx-under", undefined, [
    h("ul", "gx-legend", undefined, LAYERS.map((layer) => h("li", "", undefined, [h("span", "gx-legend-word", layer.name), h("span", "gx-legend-says", `${layer.line}: ${layer.says}`)]))),
    h("p", "gx-hint", `${S.legendLead} ${S.legendUnknown}`),
  ]);
}

export interface ProtocolViewInput {
  data: AppData; pack: PackData; series: SeriesData; tab: TabId;
  explorer?: ExplorerState; goToMissing?: boolean;
}

/** One protocol: crumbs, its series, a slot for the header, the six tabs and the body of the chosen one. */
export function protocolView(input: ProtocolViewInput): UiNode {
  const { pack, series, tab } = input;
  const fragment = (to: TabId): string => firstTab(pack, series, to);
  let body: UiNode[];
  if (tab === "overview") {
    body = OVERVIEW_BLOCKS.map((block, at) => h("div", "sx-block", undefined, [
      slot(`block-${at}`, "sx-block-kit lk-surface lk-embedded"),
      h("div", "sx-block-foot", undefined, [h("p", "sx-block-aside", block.aside), go("sx-more", block.link, fragment(block.tab))]),
    ], { "data-block": block.id }));
  } else if (tab === "dependencies") {
    const explorer = input.explorer!;
    body = [wide(S.dependenciesTitle, S.dependenciesAside, [
      explorerControls(explorer, (account) => formatRoute({ view: "protocol", pack: pack.id, series: series.id, tab: "dependencies", focus: account }), input.goToMissing === true),
      slot("explorer"),
      legendTree(),
      slot("tables"),
    ])];
  } else {
    const [title, aside] = tab === "control" ? [S.controlTitle, S.controlAside]
      : tab === "value-path" ? [S.valueTitle, series.results.path ? S.valueAside : S.valueCoverageAside]
        : tab === "unknowns" ? [S.unknownsTitle, S.unknownsAside] : [S.changesTitle, S.changesAside];
    body = [wide(title, aside, [slot("tab")])];
  }
  return h("div", "sx-view", undefined, [
    h("p", "sx-crumbs", undefined, [go("sx-crumb", S.crumbProtocols, "#/protocols"), h("span", "", ` / ${pack.title}`)]),
    ...(pack.series.length > 1 ? [h("div", "sx-series", undefined, pack.series.map((other) => go("", other.title, firstTab(pack, other, tab), other.id === series.id ? { "aria-current": "true", "data-series": other.id } : { "data-series": other.id })), { role: "group", "aria-label": S.seriesLabel })] : []),
    slot("header", `${KIT_SLOT} sx-head`),
    h("div", "sx-tabs", undefined, TABS.map((id) => go("", TAB_LABELS[id], fragment(id), { role: "tab", "aria-selected": String(id === tab), "data-tab": id })), { role: "tablist", "aria-label": S.tabsLabel }),
    h("div", "sx-tab-body", undefined, body, { role: "tabpanel", "data-tab": tab }),
  ]);
}

export interface PositionsViewInput {
  read: ReadSource; live: boolean; served: boolean;
  /** `loading`, an error word, or the number of positions the read holds. */
  state: "loading" | { error: string } | { positions: number; constructed: boolean };
  ordinal: number | null;
}

export function positionsView(input: PositionsViewInput): UiNode {
  const reads: [ReadSource, string][] = [["recorded", S.readRecorded], ["constructed", S.readConstructed], ...(input.live ? [["live", S.readLive] as [ReadSource, string]] : [])];
  const body: UiNode[] = [];
  if (input.read === "live") {
    body.push(h("div", "sx-address", undefined, [
      h("label", "sx-label", S.liveAddress, [], { for: "sx-live-address" }),
      h("input", "gx-jump sx-address-field", undefined, [], { id: "sx-live-address", type: "text", autocomplete: "off", spellcheck: "false", "data-field": "address", "data-enter": "read-live" }),
      act("sx-btn", S.liveRead, "read-live", ""),
    ]));
  }
  if (input.state === "loading") {
    if (input.read !== "live") body.push(noticeTree(S.loading));
  } else if ("error" in input.state) body.push(noticeTree(`${S.positionsFailed} ${input.state.error}`, "sx-refused"));
  else {
    if (input.state.constructed) body.push(h("p", "sx-constructed-note", S.constructedNote));
    body.push(slot("positions"));
    if (input.state.positions > 0) {
      body.push(h("div", "sx-open-list", undefined, Array.from({ length: input.state.positions }, (_, at) =>
        go("", `${S.openPosition} ${at + 1}`, formatRoute({ view: "positions", read: input.read, ordinal: at + 1 }), input.ordinal === at + 1 ? { "aria-current": "true" } : {})), { role: "group", "aria-label": S.openPosition }));
    }
    if (input.ordinal !== null) body.push(h("section", "sx-sheet", undefined, [h("h2", "", `${S.sheetTitle} ${input.ordinal}`), slot("sheet")]));
  }
  return h("div", "sx-view", undefined, [
    hero(S.positionsEyebrow, S.positionsTitle, S.positionsLede),
    h("div", "sx-reads", undefined, [
      h("div", "sx-seg", undefined, reads.map(([id, label]) => go("", label, formatRoute({ view: "positions", read: id, ordinal: null }), { "aria-pressed": String(id === input.read) })), { role: "group", "aria-label": S.readsLabel }),
      ...(input.served ? [] : [h("span", "sx-dim", S.positionsStatic)]),
    ]),
    ...body,
  ]);
}

/** Ask. Without a mounted handler it says so and holds nothing else. */
export interface AskAnswerContext { preparedId?: string; origin?: { title: string; detail: string } }
export function askView(enabled: boolean, state: "idle" | "loading" | "drawn" = "idle", prepared: PreparedAnswers | null = null, protocol = "", question = "", ready = true, context: AskAnswerContext = {}): UiNode {
  if (!enabled) return h("div", "sx-view", undefined, [hero(S.navAsk, S.askTitle, S.askLede), h("p", "sx-reserved-line", S.askNotBuilt, [], { "data-ask": "absent" })]);
  return h("div", "sx-view", undefined, [
    hero(S.navAsk, S.askTitle, S.askLede),
    h("div", "sx-ask", undefined, [
      h("aside", "sx-ask-rail", undefined, [
        h("div", "sx-ask-field", undefined, [
          ...(prepared ? [
            h("label", "sx-label", S.askProtocol, [], { for: "sx-ask-protocol" }),
            h("select", "gx-jump", undefined, prepared.protocols.map((item) => h("option", "", item.title, [], { value: item.id, ...(item.id === protocol ? { selected: "" } : {}) })), { id: "sx-ask-protocol", "data-field": "protocol", "aria-label": S.askProtocol }),
          ] : []),
          h("label", "sx-label", S.askField, [], { for: "sx-ask-field" }),
          h("input", "gx-jump", undefined, [], { id: "sx-ask-field", type: "text", value: question, maxlength: "600", autocomplete: "off", "data-field": "question", "data-enter": "ask", ...(state === "loading" || !ready ? { disabled: "" } : {}) }),
          h("button", "sx-btn", S.askButton, [], { type: "button", "data-act": "ask", ...(state === "loading" || !ready ? { disabled: "" } : {}) }),
        ]),
        ...(prepared ? [h("section", "sx-ask-list", undefined, [
          h("h2", "sx-label", S.askPrepared),
          h("p", "sx-dim", prepared.label),
          ...prepared.protocols.map((group) => h("div", "sx-ask-group", undefined, [
            h("h3", "sx-label", group.title),
            h("ul", "", undefined, prepared.answers.filter((item) => item.protocol === group.id).map((item) => h("li", "", undefined, [
              act("sx-ask-choice", item.question, "prepared-answer", item.id, { ...(context.preparedId === item.id ? { "aria-current": "true" } : {}), ...(state === "loading" ? { disabled: "" } : {}) }),
            ]))),
          ])),
        ])] : []),
      ]),
      h("section", "sx-ask-main", undefined, [
        ...(context.origin ? [h("div", "sx-ask-origin", undefined, [h("p", "sx-label", context.origin.title), h("p", "sx-dim", context.origin.detail)])] : []),
        ...(state === "loading" ? [noticeTree(S.loading)] : state === "idle" ? [noticeTree(S.askWaiting)] : []),
        slot("answer"),
      ], { id: "sx-ask-answer", tabindex: "-1", "aria-label": S.askAnswer }),
    ]),
  ]);
}

/** Preflight: a reserved place. Four lanes that stay apart, each not built; no data and no logic. */
export function preflightView(): UiNode {
  const lanes = [S.laneClaimed, S.laneDecoded, S.laneSimulated, S.laneObserved];
  return h("div", "sx-view", undefined, [
    hero(S.reserved, S.preflightTitle, S.preflightLede),
    h("div", "sx-lanes", undefined, lanes.map((lane) => h("section", "sx-lane", undefined, [h("h2", "", lane), h("p", "sx-lane-state", S.notBuilt)], { "data-lane": lane }))),
  ]);
}

/** The frame of the evidence drawer: a title, a way to close it, the ids this build cannot show, and the slot for the cards. */
export function drawerTree(missing: string[], empty: boolean): UiNode {
  return h("div", "sx-drawer-inner", undefined, [
    h("div", "sx-drawer-head", undefined, [h("span", "sx-drawer-title", S.drawerTitle), act("sx-btn", S.close, "close-drawer", "")]),
    h("div", "sx-drawer-body", undefined, [
      ...missing.map((id) => h("p", "sx-missing", undefined, [h("code", "sx-missing-id", id), h("span", "", ` ${S.notInBuild}`)])),
      ...(empty ? [] : [slot("drawer-body")]),
    ]),
  ]);
}
