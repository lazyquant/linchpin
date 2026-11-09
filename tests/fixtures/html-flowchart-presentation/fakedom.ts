// A minimal fake DOM and an injectable timeout scheduler for executing the shipped viewer script
// (the literal <script id="linchpin-flowchart-viewer"> text of a rendered document) under Bun.
// Written by the independent tester from the spec, plan and type contracts; it does not copy or
// replace the product's playback core. Every element is wrapped in a Proxy so that an access to a
// DOM property this fixture does not model is recorded (fixture limitation, not a product verdict).
import * as legacy from "../html-flowchart/dom";

export type Write =
  | { kind: "attr"; el: FakeElement; name: string; value: string }
  | { kind: "text"; el: FakeElement; value: string }
  | { kind: "disabled"; el: FakeElement; value: boolean }
  | { kind: "create"; tag: string }
  | { kind: "append"; parent: FakeElement }
  | { kind: "remove"; parent: FakeElement }
  | { kind: "forbidden"; el: FakeElement | null; what: string };

export class FakeText {
  parentNode: FakeElement | null = null;
  nodeType = 3;
  constructor(public data: string) {}
  get textContent() {
    return this.data;
  }
  set textContent(v: string) {
    this.data = String(v);
  }
  get nodeValue() {
    return this.data;
  }
}

type Child = FakeElement | FakeText;
type Listener = { type: string; fn: (e: FakeEvent) => void; capture: boolean };

export class FakeEvent {
  defaultPrevented = false;
  propagationStopped = false;
  target: any = null;
  currentTarget: any = null;
  bubbles = true;
  constructor(public type: string, init: Record<string, unknown> = {}) {
    Object.assign(this, init);
  }
  preventDefault() {
    this.defaultPrevented = true;
  }
  stopPropagation() {
    this.propagationStopped = true;
  }
  stopImmediatePropagation() {
    this.propagationStopped = true;
  }
}

const KNOWN_EL = new Set<string>();

export class FakeElement {
  nodeType = 1;
  parentNode: FakeElement | null = null;
  childNodes: Child[] = [];
  attrs = new Map<string, string>();
  listeners: Listener[] = [];
  proxy!: FakeElement;
  _disabled = false;
  constructor(public world: FakeWorld, public localName: string) {}
  get tagName() {
    return this.localName.toUpperCase();
  }
  get nodeName() {
    return this.tagName;
  }
  get ownerDocument() {
    return this.world.document;
  }
  get id() {
    return this.attrs.get("id") ?? "";
  }
  get parentElement(): FakeElement | null {
    return this.parentNode && this.parentNode.localName !== "#document" ? this.parentNode.proxy : null;
  }
  get children(): FakeElement[] {
    return this.childNodes.filter((c): c is FakeElement => c instanceof FakeElement).map((c) => c.proxy);
  }
  get firstChild(): FakeElement | FakeText | null {
    const c = this.childNodes[0];
    return c ? (c instanceof FakeElement ? c.proxy : c) : null;
  }
  get lastChild(): FakeElement | FakeText | null {
    const c = this.childNodes[this.childNodes.length - 1];
    return c ? (c instanceof FakeElement ? c.proxy : c) : null;
  }
  get firstElementChild(): FakeElement | null {
    return this.children[0] ?? null;
  }
  get childElementCount() {
    return this.children.length;
  }
  get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join("");
  }
  set textContent(v: string) {
    this.world.log({ kind: "text", el: this, value: String(v) });
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = String(v) === "" ? [] : [new FakeText(String(v))];
    this.childNodes.forEach((c) => (c.parentNode = this));
  }
  get disabled() {
    return this.attrs.has("disabled");
  }
  set disabled(v: boolean) {
    this.world.log({ kind: "disabled", el: this, value: !!v });
    if (v) this.attrs.set("disabled", "");
    else this.attrs.delete("disabled");
  }
  get hidden() {
    return this.attrs.has("hidden");
  }
  set hidden(_v: boolean) {
    this.world.log({ kind: "forbidden", el: this, what: "hidden=" });
  }
  get tabIndex() {
    return Number(this.attrs.get("tabindex") ?? -1);
  }
  getAttribute(n: string) {
    return this.attrs.has(n.toLowerCase()) ? this.attrs.get(n.toLowerCase())! : null;
  }
  hasAttribute(n: string) {
    return this.attrs.has(n.toLowerCase());
  }
  setAttribute(n: string, v: string) {
    this.world.log({ kind: "attr", el: this, name: n.toLowerCase(), value: String(v) });
    this.attrs.set(n.toLowerCase(), String(v));
  }
  removeAttribute(n: string) {
    this.world.log({ kind: "forbidden", el: this, what: `removeAttribute(${n})` });
    this.attrs.delete(n.toLowerCase());
  }
  toggleAttribute(n: string, force?: boolean) {
    this.world.log({ kind: "forbidden", el: this, what: `toggleAttribute(${n})` });
    const on = force ?? !this.attrs.has(n);
    if (on) this.attrs.set(n, "");
    else this.attrs.delete(n);
    return on;
  }
  private adopt(c: any): Child {
    const raw: Child = c instanceof FakeText ? c : (c?.__raw ?? c);
    if (raw.parentNode) raw.parentNode.childNodes = raw.parentNode.childNodes.filter((x) => x !== raw);
    raw.parentNode = this;
    return raw;
  }
  appendChild(c: any) {
    this.world.log({ kind: "append", parent: this });
    this.childNodes.push(this.adopt(c));
    return c;
  }
  append(...cs: any[]) {
    for (const c of cs) this.appendChild(typeof c === "string" ? new FakeText(c) : c);
  }
  replaceChildren(...cs: any[]) {
    this.world.log({ kind: "remove", parent: this });
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    this.append(...cs);
  }
  removeChild(c: any) {
    this.world.log({ kind: "remove", parent: this });
    const raw = c?.__raw ?? c;
    this.childNodes = this.childNodes.filter((x) => x !== raw);
    raw.parentNode = null;
    return c;
  }
  remove() {
    this.parentNode?.removeChild(this.proxy);
  }
  insertBefore(c: any, ref: any) {
    this.world.log({ kind: "append", parent: this });
    const raw = this.adopt(c);
    const r = ref?.__raw ?? ref;
    const i = this.childNodes.indexOf(r);
    if (i < 0) this.childNodes.push(raw);
    else this.childNodes.splice(i, 0, raw);
    return c;
  }
  contains(o: any): boolean {
    let cur: FakeElement | null = (o?.__raw ?? o) as FakeElement | null;
    while (cur) {
      if (cur === this) return true;
      cur = cur.parentNode;
    }
    return false;
  }
  matches(sel: string) {
    return matchesSelector(this, sel);
  }
  closest(sel: string) {
    let cur: FakeElement | null = this;
    while (cur && cur.localName !== "#document") {
      if (matchesSelector(cur, sel)) return cur.proxy;
      cur = cur.parentNode;
    }
    return null;
  }
  descendants(): FakeElement[] {
    const out: FakeElement[] = [];
    const walk = (e: FakeElement) => {
      for (const c of e.childNodes)
        if (c instanceof FakeElement) {
          out.push(c);
          walk(c);
        }
    };
    walk(this);
    return out;
  }
  querySelectorAll(sel: string) {
    return this.descendants()
      .filter((e) => matchesSelector(e, sel))
      .map((e) => e.proxy);
  }
  querySelector(sel: string) {
    return this.querySelectorAll(sel)[0] ?? null;
  }
  getElementsByTagName(t: string) {
    return this.descendants()
      .filter((e) => e.localName === t.toLowerCase())
      .map((e) => e.proxy);
  }
  addEventListener(type: string, fn: any, opts?: boolean | { capture?: boolean }) {
    if (typeof fn !== "function" && typeof fn?.handleEvent === "function") {
      const h = fn;
      fn = (e: FakeEvent) => h.handleEvent(e);
    }
    this.listeners.push({ type, fn, capture: typeof opts === "boolean" ? opts : !!opts?.capture });
  }
  removeEventListener(type: string, fn: any) {
    this.listeners = this.listeners.filter((l) => !(l.type === type && l.fn === fn));
  }
  focus() {
    this.world.activeElement = this;
  }
  blur() {
    if (this.world.activeElement === this) this.world.activeElement = null;
  }
  scrollIntoView() {
    this.world.log({ kind: "forbidden", el: this, what: "scrollIntoView" });
  }
  get style() {
    this.world.log({ kind: "forbidden", el: this, what: "style" });
    return {};
  }
  get innerHTML() {
    this.world.log({ kind: "forbidden", el: this, what: "innerHTML get" });
    return "";
  }
  set innerHTML(_v: string) {
    this.world.log({ kind: "forbidden", el: this, what: "innerHTML" });
  }
}

for (let p: any = FakeElement.prototype; p && p !== Object.prototype; p = Object.getPrototypeOf(p))
  for (const k of Object.getOwnPropertyNames(p)) KNOWN_EL.add(k);
for (const k of ["nodeType", "parentNode", "childNodes", "attrs", "listeners", "proxy", "_disabled", "world", "localName"]) KNOWN_EL.add(k);

function wrap(el: FakeElement): FakeElement {
  const p = new Proxy(el, {
    get(t, k, r) {
      if (k === "__raw") return t;
      if (typeof k === "string" && !KNOWN_EL.has(k) && !(k in t)) t.world.unknown.add(`element.${k}`);
      const v = Reflect.get(t, k, t);
      return typeof v === "function" ? v.bind(t) : v;
    },
    set(t, k, v) {
      if (typeof k === "string" && !KNOWN_EL.has(k)) {
        t.world.unknown.add(`element.${k}=`);
        t.world.log({ kind: "forbidden", el: t, what: `set ${k}` });
      }
      return Reflect.set(t, k, v, t);
    },
  });
  el.proxy = p;
  return p;
}

// ---------------------------------------------------------------------------------------------
// Selectors: tag, #id, .class, [attr], [attr="v"], compound, descendant and child combinators, lists.

interface Simple {
  tag?: string;
  id?: string;
  classes: string[];
  attrs: { name: string; value?: string }[];
}

function parseCompound(s: string): Simple {
  const out: Simple = { classes: [], attrs: [] };
  const re = /([a-zA-Z][a-zA-Z0-9-]*)|#([\w-]+)|\.([\w-]+)|\[\s*([\w:-]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+)))?\s*\]|(\*)/g;
  let m: RegExpExecArray | null;
  let consumed = 0;
  while ((m = re.exec(s))) {
    if (m.index !== consumed) throw new Error(`fake DOM: unsupported selector ${s}`);
    consumed = re.lastIndex;
    if (m[1]) out.tag = m[1].toLowerCase();
    else if (m[2]) out.id = m[2];
    else if (m[3]) out.classes.push(m[3]);
    else if (m[4]) out.attrs.push({ name: m[4].toLowerCase(), value: m[5] ?? m[6] ?? m[7] });
  }
  if (consumed !== s.length) throw new Error(`fake DOM: unsupported selector ${s}`);
  return out;
}

function matchSimple(e: FakeElement, s: Simple) {
  if (s.tag && e.localName !== s.tag) return false;
  if (s.id && e.attrs.get("id") !== s.id) return false;
  const cls = (e.attrs.get("class") ?? "").split(/\s+/);
  if (s.classes.some((c) => !cls.includes(c))) return false;
  for (const a of s.attrs) {
    if (!e.attrs.has(a.name)) return false;
    if (a.value !== undefined && e.attrs.get(a.name) !== a.value) return false;
  }
  return true;
}

function matchesComplex(e: FakeElement, parts: string[]): boolean {
  // parts alternate compound, combinator, compound ... ; match from the right
  const last = parts[parts.length - 1]!;
  if (!matchSimple(e, parseCompound(last))) return false;
  if (parts.length === 1) return true;
  const comb = parts[parts.length - 2]!;
  const rest = parts.slice(0, -2);
  let cur = e.parentNode;
  if (comb === ">") return !!cur && cur.localName !== "#document" && matchesComplex(cur, rest);
  while (cur && cur.localName !== "#document") {
    if (matchesComplex(cur, rest)) return true;
    cur = cur.parentNode;
  }
  return false;
}

export function matchesSelector(e: FakeElement, sel: string): boolean {
  return sel.split(",").some((one) => {
    const tokens = one
      .trim()
      .replace(/\s*>\s*/g, " > ")
      .split(/\s+/)
      .filter(Boolean);
    const parts: string[] = [];
    for (const t of tokens) {
      if (t === ">") parts.push(">");
      else {
        if (parts.length && parts[parts.length - 1] !== ">") parts.push(" ");
        parts.push(t);
      }
    }
    return matchesComplex(e, parts);
  });
}

// ---------------------------------------------------------------------------------------------
// Scheduler

export interface Timer {
  handle: number;
  fn: () => void;
  ms: number;
  due: number;
  cancelled: boolean;
  fired: boolean;
}

export class FakeScheduler {
  now = 0;
  next = 1;
  timers: Timer[] = [];
  bad: string[] = [];
  maxOutstanding = 0;
  setTimeout = (fn: unknown, ms?: unknown, ...rest: unknown[]) => {
    if (typeof fn !== "function") this.bad.push(`setTimeout with non-function ${typeof fn}`);
    if (rest.length) this.bad.push("setTimeout with extra arguments");
    const t: Timer = { handle: this.next++, fn: fn as () => void, ms: Number(ms ?? 0), due: this.now + Number(ms ?? 0), cancelled: false, fired: false };
    this.timers.push(t);
    this.maxOutstanding = Math.max(this.maxOutstanding, this.outstanding().length);
    return t.handle;
  };
  clearTimeout = (h: unknown) => {
    for (const t of this.timers) if (t.handle === h && !t.fired) t.cancelled = true;
  };
  outstanding(): Timer[] {
    return this.timers.filter((t) => !t.cancelled && !t.fired);
  }
  cancelled(): Timer[] {
    return this.timers.filter((t) => t.cancelled);
  }
  /** Advance the clock by ms, firing due timers in due order. */
  advance(ms: number) {
    const target = this.now + ms;
    for (;;) {
      const due = this.outstanding()
        .filter((t) => t.due <= target)
        .sort((a, b) => a.due - b.due || a.handle - b.handle)[0];
      if (!due) break;
      this.now = due.due;
      due.fired = true;
      due.fn();
    }
    this.now = target;
  }
  /** Invoke a timer's callback even though it was cancelled (forced stale callback). */
  forceFire(t: Timer) {
    t.fn();
  }
}

// ---------------------------------------------------------------------------------------------
// World

export class FakeWorld {
  writes: Write[] = [];
  unknown = new Set<string>();
  errors: unknown[] = [];
  activeElement: FakeElement | null = null;
  document: any;
  window: any;
  root: FakeElement;
  docListeners: Listener[] = [];
  winListeners: Listener[] = [];
  hidden = false;
  scheduler = new FakeScheduler();
  private byIdCache = new Map<string, FakeElement>();

  constructor(public html: string) {
    const parsed = legacy.parse(html);
    if (parsed.errors.length) throw new Error(`fake DOM parse errors: ${parsed.errors.join("; ")}`);
    this.root = new FakeElement(this, "#document");
    wrap(this.root);
    const build = (src: legacy.El, parent: FakeElement) => {
      for (const c of src.children) {
        if (typeof c === "string") {
          const t = new FakeText(c);
          t.parentNode = parent;
          parent.childNodes.push(t);
        } else {
          const e = new FakeElement(this, c.tag);
          wrap(e);
          for (const [n, v] of c.attrs) e.attrs.set(n, v);
          e.parentNode = parent;
          parent.childNodes.push(e);
          build(c, e);
        }
      }
    };
    build(parsed.root, this.root);
    const world = this;
    const docTarget: any = {
      get hidden() {
        return world.hidden;
      },
      get visibilityState() {
        return world.hidden ? "hidden" : "visible";
      },
      get activeElement() {
        return world.activeElement?.proxy ?? world.body?.proxy ?? null;
      },
      get body() {
        return world.body?.proxy ?? null;
      },
      get documentElement() {
        return world.root.children[0] ?? null;
      },
      readyState: "complete",
      getElementById: (id: string) => world.root.descendants().find((e) => e.attrs.get("id") === id)?.proxy ?? null,
      querySelector: (s: string) => world.root.querySelector(s),
      querySelectorAll: (s: string) => world.root.querySelectorAll(s),
      getElementsByTagName: (t: string) => world.root.getElementsByTagName(t),
      createElement: (tag: string) => {
        world.log({ kind: "create", tag: tag.toLowerCase() });
        const e = new FakeElement(world, tag.toLowerCase());
        return wrap(e);
      },
      createElementNS: (_ns: string, tag: string) => {
        world.log({ kind: "forbidden", el: null, what: `createElementNS(${tag})` });
        return wrap(new FakeElement(world, tag.toLowerCase()));
      },
      createTextNode: (s: string) => new FakeText(String(s)),
      addEventListener: (type: string, fn: any, opts?: boolean | { capture?: boolean }) =>
        world.docListeners.push({ type, fn, capture: typeof opts === "boolean" ? opts : !!opts?.capture }),
      removeEventListener: (type: string, fn: any) => (world.docListeners = world.docListeners.filter((l) => !(l.type === type && l.fn === fn))),
      contains: (o: any) => world.root.contains(o),
      write: () => world.log({ kind: "forbidden", el: null, what: "document.write" }),
    };
    this.document = new Proxy(docTarget, {
      get(t, k) {
        if (typeof k === "string" && !(k in t)) world.unknown.add(`document.${k}`);
        return t[k];
      },
      set(t, k, v) {
        world.unknown.add(`document.${String(k)}=`);
        t[k] = v;
        return true;
      },
    });
    const winTarget: any = {
      document: this.document,
      setTimeout: this.scheduler.setTimeout,
      clearTimeout: this.scheduler.clearTimeout,
      addEventListener: (type: string, fn: any, opts?: boolean | { capture?: boolean }) =>
        world.winListeners.push({ type, fn, capture: typeof opts === "boolean" ? opts : !!opts?.capture }),
      removeEventListener: (type: string, fn: any) => (world.winListeners = world.winListeners.filter((l) => !(l.type === type && l.fn === fn))),
      matchMedia: (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }),
    };
    this.window = new Proxy(winTarget, {
      get(t, k) {
        if (typeof k === "string" && !(k in t)) world.unknown.add(`window.${k}`);
        return t[k];
      },
    });
  }

  get body(): FakeElement | undefined {
    return this.root.descendants().find((e) => e.localName === "body");
  }

  log(w: Write) {
    this.writes.push(w);
  }

  byId(id: string): FakeElement {
    const e = this.root.descendants().find((x) => x.attrs.get("id") === id);
    if (!e) throw new Error(`fake DOM: no element #${id}`);
    return e;
  }

  all(pred: (e: FakeElement) => boolean): FakeElement[] {
    return this.root.descendants().filter(pred);
  }

  /** Runs the script text with document, window, setTimeout and clearTimeout bound to the fakes. */
  run(script: string) {
    const fn = new Function("document", "window", "self", "setTimeout", "clearTimeout", script);
    fn(this.document, this.window, this.window, this.scheduler.setTimeout, this.scheduler.clearTimeout);
  }

  /** Dispatch with capture (window, document, ancestors) then target and bubble back up. */
  dispatch(target: FakeElement | "document" | "window", type: string, init: Record<string, unknown> = {}): FakeEvent {
    const ev = new FakeEvent(type, init);
    const path: { listeners: () => Listener[]; obj: any }[] = [];
    path.push({ listeners: () => this.winListeners, obj: this.window });
    path.push({ listeners: () => this.docListeners, obj: this.document });
    if (target !== "document" && target !== "window") {
      const chain: FakeElement[] = [];
      let cur: FakeElement | null = target;
      while (cur && cur.localName !== "#document") {
        chain.unshift(cur);
        cur = cur.parentNode;
      }
      for (const e of chain) path.push({ listeners: () => e.listeners, obj: e.proxy });
    } else if (target === "window") path.splice(1);
    const tgtObj = path[path.length - 1]!.obj;
    ev.target = tgtObj;
    const call = (l: Listener, obj: any) => {
      ev.currentTarget = obj;
      try {
        l.fn.call(obj, ev);
      } catch (err) {
        this.errors.push(err);
      }
    };
    // capture phase
    for (let i = 0; i < path.length - 1 && !ev.propagationStopped; i++)
      for (const l of path[i]!.listeners().filter((x) => x.type === type && x.capture)) call(l, path[i]!.obj);
    // target phase (both)
    if (!ev.propagationStopped) for (const l of path[path.length - 1]!.listeners().filter((x) => x.type === type)) call(l, tgtObj);
    // bubble phase
    for (let i = path.length - 2; i >= 0 && !ev.propagationStopped; i--)
      for (const l of path[i]!.listeners().filter((x) => x.type === type && !x.capture)) call(l, path[i]!.obj);
    return ev;
  }

  /** A click as a browser delivers it: none at all on a disabled button, unless forced. */
  click(el: FakeElement, opts: { force?: boolean } = {}): FakeEvent | null {
    const btn = el.localName === "button" ? el : null;
    if (btn && btn.attrs.has("disabled") && !opts.force) return null;
    return this.dispatch(el, "click", { button: 0, detail: 1 });
  }

  key(el: FakeElement | "document", key: string): FakeEvent {
    if (el !== "document") this.activeElement = el;
    return this.dispatch(el === "document" ? this.body! : el, "keydown", { key, code: key === " " ? "Space" : key, repeat: false, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false });
  }

  setHidden(hidden: boolean) {
    this.hidden = hidden;
    this.dispatch("document", "visibilitychange");
  }
}

export function textOf(e: FakeElement): string {
  return e.textContent;
}
