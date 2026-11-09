// A small, independent reader for the documents the renderer serves. It is written from the
// spec's H1 rules (canonical escaping, double-quoted attributes, raw text in script and style)
// and is used only to make structural assertions; it is not the product validator.

export interface El {
  tag: string;
  attrs: [string, string][];
  children: (El | string)[];
  parent: El | null;
  rawStart: string;
}

const VOID = new Set(["meta", "link", "img", "br", "hr", "input", "base", "source", "col", "area", "embed", "param", "track", "wbr"]);
const RAW = new Set(["script", "style"]);
const REF = /&(amp|lt|gt|quot|#39);/g;
const DECODE: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" };

export function decode(s: string): string {
  return s.replace(REF, (_, n: string) => DECODE[n]!);
}

function canonical(raw: string, where: string, errors: string[], forbidden: RegExp) {
  if (forbidden.test(raw)) errors.push(`raw special character in ${where}: ${JSON.stringify(raw.slice(0, 80))}`);
  const amps = raw.match(/&/g)?.length ?? 0;
  const refs = raw.match(REF)?.length ?? 0;
  if (amps !== refs) errors.push(`non-canonical character reference in ${where}: ${JSON.stringify(raw.slice(0, 80))}`);
}

export interface Parsed {
  root: El;
  errors: string[];
  all: El[];
}

export function parse(html: string): Parsed {
  const errors: string[] = [];
  const root: El = { tag: "#root", attrs: [], children: [], parent: null, rawStart: "" };
  const all: El[] = [];
  let cur = root;
  let i = 0;
  if (html.startsWith("<!DOCTYPE html>")) i = "<!DOCTYPE html>".length;
  else errors.push("no doctype");
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    const end = lt < 0 ? html.length : lt;
    if (end > i) {
      const raw = html.slice(i, end);
      canonical(raw, `text under <${cur.tag}>`, errors, /[>"']/);
      cur.children.push(decode(raw));
    }
    if (lt < 0) break;
    if (html.startsWith("</", lt)) {
      const gt = html.indexOf(">", lt);
      const name = html.slice(lt + 2, gt).toLowerCase();
      if (cur.tag !== name) errors.push(`end tag </${name}> while <${cur.tag}> is open`);
      else cur = cur.parent ?? root;
      i = gt + 1;
      continue;
    }
    if (html.startsWith("<!", lt) || html.startsWith("<?", lt)) {
      errors.push("markup declaration or processing instruction");
      i = lt + 2;
      continue;
    }
    let j = lt + 1;
    const nameMatch = /^[A-Za-z][A-Za-z0-9:-]*/.exec(html.slice(j, j + 64));
    if (!nameMatch) {
      errors.push(`bad tag at ${lt}`);
      i = lt + 1;
      continue;
    }
    const tag = nameMatch[0].toLowerCase();
    j += nameMatch[0].length;
    const attrs: [string, string][] = [];
    let closed = false;
    while (j < html.length) {
      while (html[j] === " " || html[j] === "\n" || html[j] === "\t") j++;
      if (html[j] === ">") { j++; closed = true; break; }
      if (html.startsWith("/>", j)) { j += 2; closed = true; break; }
      const an = /^[^\s=>/"']+/.exec(html.slice(j, j + 256));
      if (!an) { errors.push(`bad attribute in <${tag}>`); break; }
      const aname = an[0].toLowerCase();
      j += an[0].length;
      if (html[j] === "=") {
        j++;
        if (html[j] !== '"') { errors.push(`attribute ${aname} of <${tag}> is not double-quoted`); break; }
        const q = html.indexOf('"', j + 1);
        const rawv = html.slice(j + 1, q);
        canonical(rawv, `attribute ${aname} of <${tag}>`, errors, /[<>']/);
        attrs.push([aname, decode(rawv)]);
        j = q + 1;
      } else attrs.push([aname, ""]);
    }
    if (!closed) { i = j + 1; continue; }
    const el: El = { tag, attrs, children: [], parent: cur, rawStart: html.slice(lt, j) };
    cur.children.push(el);
    all.push(el);
    if (RAW.has(tag)) {
      const close = html.toLowerCase().indexOf(`</${tag}`, j);
      const stop = close < 0 ? html.length : close;
      el.children.push(html.slice(j, stop));
      const gt = close < 0 ? html.length : html.indexOf(">", close);
      i = gt + 1;
      continue;
    }
    if (!VOID.has(tag)) cur = el;
    i = j;
  }
  if (cur !== root) errors.push(`unclosed <${cur.tag}>`);
  return { root, errors, all };
}

export function attr(el: El, name: string): string | undefined {
  return el.attrs.find(([n]) => n === name)?.[1];
}

export function has(el: El, name: string): boolean {
  return el.attrs.some(([n]) => n === name);
}

export function text(el: El): string {
  return el.children.map((c) => (typeof c === "string" ? c : text(c))).join("");
}

export function descendants(el: El): El[] {
  const out: El[] = [];
  const walk = (e: El) => {
    for (const c of e.children) if (typeof c !== "string") { out.push(c); walk(c); }
  };
  walk(el);
  return out;
}

export function childEls(el: El): El[] {
  return el.children.filter((c): c is El => typeof c !== "string");
}

export function byId(p: Parsed, id: string): El[] {
  return p.all.filter((e) => attr(e, "id") === id);
}

export function oneById(p: Parsed, id: string): El {
  const found = byId(p, id);
  if (found.length !== 1) throw new Error(`expected one element with id ${id}, found ${found.length}`);
  return found[0]!;
}

export function tagsOf(p: Parsed, tag: string): El[] {
  return p.all.filter((e) => e.tag === tag);
}

/** Element sequence: tag and attribute names, in document order. */
export function shape(p: Parsed): string[] {
  return p.all.map((e) => `${e.tag}[${e.attrs.map(([n]) => n).join(",")}]`);
}
