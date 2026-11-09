import { FLOWCHART_STYLE_CSS, FLOWCHART_VIEWER_JS } from "./assets";
import { hashFlowchartModel, toFlowchartModel } from "./model";
import { FlowchartError } from "./types";
import type { FlowchartEdge, FlowchartInput, FlowchartModel, FlowchartNode, FlowchartProblem, FlowchartProblemCode } from "./types";

type Add = (code: FlowchartProblemCode, detail: string) => void;

type Attr = { name: string; value: string };
type Rec = { tag: string; attrs: Attr[]; parent: Rec | null; children: Rec[]; text: string; closed: boolean; index: number };

const BASIS = new Set(["claimed", "reported", "decoded", "simulated", "observed", "derived", "unknown"]);
const VERIFICATION = new Set(["verified", "unverified", "conflicting", "unresolved"]);
const SOURCES = new Set(["evidence-graph", "execution-plan", "protocol-view"]);
const SEQUENCES = new Set(["plan-order", "explanation", "decoded-transaction", "observed-execution", "simulation", "constructed-example"]);

const FORBIDDEN_TAGS = new Set(["link", "iframe", "frame", "object", "embed", "img", "image", "audio", "video", "source", "base", "form", "input", "a", "use", "foreignobject"]);
const FORBIDDEN_ATTRS = new Set(["src", "href", "xlink:href", "srcset", "action", "formaction", "style", "hidden", "display", "visibility", "opacity"]);

const TAG_TOKEN = /<(?:\/[A-Za-z][A-Za-z0-9-]*|[A-Za-z][A-Za-z0-9-]*(?: [A-Za-z_:][-A-Za-z0-9_:.]*(?:="[^"<>]*")?)*\/?)>/y;

const DECODE_MAP: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeCanonical(raw: string): string | null {
  if (/[<>"']/.test(raw)) return null;
  if (/&(?!(?:amp|lt|gt|quot|#39);)/.test(raw)) return null;
  return raw.replace(/&(?:amp|lt|gt|quot|#39);/g, (match) => DECODE_MAP[match]);
}

function textOf(record: Rec): string {
  const decoded = decodeCanonical(record.text);
  return decoded === null ? record.text : decoded;
}

function attrOf(record: Rec, name: string): string | null {
  const found = record.attrs.find((attr) => attr.name === name);
  if (!found) return null;
  const decoded = decodeCanonical(found.value);
  return decoded === null ? found.value : decoded;
}

function hasAttr(record: Rec, name: string): boolean {
  return record.attrs.some((attr) => attr.name === name);
}

function hasAncestor(record: Rec, ancestor: Rec): boolean {
  let parent = record.parent;
  while (parent) {
    if (parent === ancestor) return true;
    parent = parent.parent;
  }
  return false;
}

function descendants(record: Rec): Rec[] {
  const found: Rec[] = [];
  const visit = (current: Rec): void => {
    for (const child of current.children) {
      found.push(child);
      visit(child);
    }
  };
  visit(record);
  return found;
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value);
  if (actual.length !== keys.length) return false;
  const set = new Set(actual);
  return keys.every((key) => set.has(key));
}

function sha256Base64(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("base64");
}

function expectedPolicy(): string {
  return `default-src 'none'; script-src 'sha256-${sha256Base64(FLOWCHART_VIEWER_JS)}'; style-src 'sha256-${sha256Base64(FLOWCHART_STYLE_CSS)}'; base-uri 'none'; form-action 'none'`;
}

function sequenceLine(sequence: FlowchartModel["sequence"]): string {
  if (sequence === null) return "No sequence";
  if (sequence === "observed-execution") return "Sequence: observed-execution";
  return `Sequence: ${sequence} (reading order, not an observed execution)`;
}

function phaseA(html: string, add: Add): void {
  const doctype = "<!DOCTYPE html>";
  const startsWithDoctype = html.startsWith(doctype);
  if (!startsWithDoctype) add("document", "document does not start with <!DOCTYPE html>");
  const base = startsWithDoctype ? doctype.length : 0;
  let bang = false;
  for (let i = base; i < html.length - 1; i++) {
    if (html[i] === "<" && (html[i + 1] === "!" || html[i + 1] === "?")) {
      bang = true;
      break;
    }
  }
  if (bang) add("document", "document contains <! or <? outside the doctype");
  let position = html.indexOf("<", base);
  while (position !== -1) {
    const following = html[position + 1];
    if (following === "!" || following === "?") {
      position = html.indexOf("<", position + 2);
      continue;
    }
    TAG_TOKEN.lastIndex = position;
    const match = TAG_TOKEN.exec(html);
    if (!match) {
      add("document", `non-canonical markup at offset ${position}`);
      break;
    }
    const token = match[0];
    const name = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(token);
    const tag = name ? name[1].toLowerCase() : "";
    const closing = token.startsWith("</");
    const selfClosing = token.endsWith("/>");
    let cursor = position + token.length;
    if (!closing && !selfClosing && (tag === "script" || tag === "style")) {
      const closer = new RegExp(`</${tag}`, "ig");
      closer.lastIndex = cursor;
      const found = closer.exec(html);
      cursor = found ? found.index : html.length;
    }
    position = html.indexOf("<", cursor);
  }
}

function walkDocument(html: string, add: Add): { ok: boolean; records: Rec[] } {
  const records: Rec[] = [];
  const stack: Rec[] = [];
  let index = 0;
  let buffer = "";
  const sentinel = { abort: true };
  try {
    new HTMLRewriter()
      .on("*", {
        element(element) {
          const attrs = Array.from(element.attributes).map(([name, value]) => ({ name, value }));
          const record: Rec = {
            tag: element.tagName,
            attrs,
            parent: stack.length > 0 ? stack[stack.length - 1] : null,
            children: [],
            text: "",
            closed: false,
            index: index++,
          };
          const names = new Set<string>();
          for (const attr of attrs) {
            if (names.has(attr.name)) add("document", `duplicate attribute ${attr.name} on <${record.tag}>`);
            names.add(attr.name);
            if (decodeCanonical(attr.value) === null) add("document", `non-canonical attribute value for ${attr.name} on <${record.tag}>`);
          }
          if (record.parent) record.parent.children.push(record);
          records.push(record);
          if (stack.length >= 256) {
            add("document", "nesting deeper than 256");
            throw sentinel;
          }
          if (element.canHaveContent && !element.selfClosing) {
            stack.push(record);
            element.onEndTag((end) => {
              const top = stack[stack.length - 1];
              const name = (end.name || "").toLowerCase();
              if (top !== record || name !== record.tag) add("document", `<${record.tag}> closed by </${name}>`);
              const at = stack.lastIndexOf(record);
              stack.length = at >= 0 ? at : 0;
              record.closed = true;
            });
          } else {
            record.closed = true;
          }
        },
      })
      .onDocument({
        text(chunk) {
          buffer += chunk.text;
          for (const record of stack) record.text += chunk.text;
          if (chunk.lastInTextNode) {
            const top = stack[stack.length - 1];
            if (top && top.tag !== "script" && top.tag !== "style" && decodeCanonical(buffer) === null) {
              add("document", `non-canonical text in <${top.tag}>`);
            }
            buffer = "";
          }
        },
        end() {
          for (const record of stack) add("document", `unclosed <${record.tag}>`);
          stack.length = 0;
        },
      })
      .transform(html);
  } catch (error) {
    if (error !== sentinel) return { ok: false, records };
    return { ok: false, records };
  }
  return { ok: true, records };
}

function phaseFrame(records: Rec[], add: Add): void {
  for (const tag of ["html", "head", "body"]) {
    const count = records.filter((record) => record.tag === tag).length;
    if (count !== 1) add("document", `expected exactly one ${tag} element, found ${count}`);
  }
  const head = records.find((record) => record.tag === "head");
  if (head) {
    const first = head.children[0];
    const ok = first !== undefined && first.tag === "meta" && first.attrs.length === 1 && first.attrs[0].name === "charset" && attrOf(first, "charset") === "utf-8";
    if (!ok) add("document", 'the first child of head is not <meta charset="utf-8">');
  }
  const titles = records.filter((record) => record.tag === "title").length;
  if (titles !== 1) add("document", `expected exactly one title element, found ${titles}`);
}

function attrsExactly(record: Rec, expected: Record<string, string>): boolean {
  const keys = Object.keys(expected);
  if (record.attrs.length !== keys.length) return false;
  return keys.every((key) => attrOf(record, key) === expected[key]);
}

function phaseC(records: Rec[], add: Add): void {
  for (const record of records) {
    if (FORBIDDEN_TAGS.has(record.tag)) add("active-content", `forbidden element <${record.tag}>`);
    for (const attr of record.attrs) {
      if (FORBIDDEN_ATTRS.has(attr.name) || attr.name.startsWith("on")) add("active-content", `forbidden attribute ${attr.name} on <${record.tag}>`);
    }
  }

  const scripts = records.filter((record) => record.tag === "script");
  if (scripts.length !== 2) add("active-content", `expected exactly two script elements, found ${scripts.length}`);
  const first = scripts[0];
  if (first) {
    if (!attrsExactly(first, { type: "application/json", id: "linchpin-flowchart-model" })) add("active-content", "the first script is not the model block");
  }
  const second = scripts[1];
  if (second) {
    if (!attrsExactly(second, { id: "linchpin-flowchart-viewer" })) add("active-content", "the second script is not the viewer");
    if (second.text !== FLOWCHART_VIEWER_JS) add("active-content", "the viewer script does not equal FLOWCHART_VIEWER_JS");
  }

  const styles = records.filter((record) => record.tag === "style");
  if (styles.length !== 1) add("active-content", `expected exactly one style element, found ${styles.length}`);
  if (styles[0] && styles[0].text !== FLOWCHART_STYLE_CSS) add("active-content", "the stylesheet does not equal FLOWCHART_STYLE_CSS");

  const metas = records.filter((record) => hasAttr(record, "http-equiv"));
  if (metas.length !== 1) {
    add("active-content", `expected exactly one policy meta element, found ${metas.length}`);
    return;
  }
  const meta = metas[0];
  if (!meta.parent || meta.parent.tag !== "head") add("active-content", "the policy meta is not inside head");
  if (!attrsExactly(meta, { "http-equiv": "Content-Security-Policy", content: expectedPolicy() })) add("active-content", "the policy meta does not carry the exact policy");
  if (styles[0] && meta.index > styles[0].index) add("active-content", "the policy meta comes after the style element");
  if (first && meta.index > first.index) add("active-content", "the policy meta comes after the model block");
  if (second && meta.index > second.index) add("active-content", "the policy meta comes after the viewer script");
}

type ModelResult = { parsed: unknown; title: string; schemaClean: boolean; missing: boolean; dangling: boolean; model: FlowchartModel | null };

function checkSchema(parsed: unknown, mark: (detail: string) => void): { clean: boolean; nodeIds: Set<string>; edgeIds: Set<string> } {
  let markFailed = false;
  const fail = (detail: string): void => {
    markFailed = true;
    mark(detail);
  };
  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();
  if (!isRecord(parsed)) {
    fail("model: not an object");
    return { clean: false, nodeIds, edgeIds };
  }
  if (!hasExactKeys(parsed, ["schema", "source", "title", "nodes", "edges", "sequence", "steps", "notes", "sha256"])) fail("model: keys differ from the model interface");
  if (parsed.schema !== "linchpin.flowchart/1") fail("model: schema is not linchpin.flowchart/1");
  if (!SOURCES.has(parsed.source as string)) fail("model: source is not one of the three source values");
  if (typeof parsed.title !== "string") fail("model: title is not a string");
  const sequence = parsed.sequence;
  if (!(sequence === null || SEQUENCES.has(sequence as string))) fail("model: sequence is not null and not a known value");
  if (!(Array.isArray(parsed.notes) && parsed.notes.every((note) => typeof note === "string"))) fail("model: notes is not an array of strings");
  if (typeof parsed.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(parsed.sha256)) fail("model: sha256 is not 64 lower-case hex characters");

  if (!Array.isArray(parsed.nodes)) fail("model: nodes is not an array");
  else {
    for (let i = 0; i < parsed.nodes.length; i++) {
      const node = parsed.nodes[i];
      if (!isRecord(node)) {
        fail(`node ${i}: not an object`);
        continue;
      }
      const id = typeof node.id === "string" ? node.id : null;
      const label = id === null ? `node ${i}` : `node ${id}`;
      if (!hasExactKeys(node, ["id", "kind", "label"])) fail(`${label}: keys differ from the node interface`);
      if (id === null) fail(`${label}: id is not a string`);
      else if (nodeIds.has(id)) fail(`node ${id}: duplicate id`);
      else nodeIds.add(id);
      if (typeof node.kind !== "string") fail(`${label}: kind is not a string`);
      if (typeof node.label !== "string") fail(`${label}: label is not a string`);
    }
  }

  if (!Array.isArray(parsed.edges)) fail("model: edges is not an array");
  else {
    for (let i = 0; i < parsed.edges.length; i++) {
      const edge = parsed.edges[i];
      if (!isRecord(edge)) {
        fail(`edge ${i}: not an object`);
        continue;
      }
      const id = typeof edge.id === "string" ? edge.id : null;
      const label = id === null ? `edge ${i}` : `edge ${id}`;
      if (!hasExactKeys(edge, ["id", "from", "to", "relation", "basis", "verification", "evidenceIds", "sourceId"])) fail(`${label}: keys differ from the edge interface`);
      if (id === null) fail(`${label}: id is not a string`);
      else if (edgeIds.has(id)) fail(`edge ${id}: duplicate id`);
      else edgeIds.add(id);
      for (const field of ["from", "to", "relation"]) if (typeof edge[field] !== "string") fail(`${label}: ${field} is not a string`);
      if (!(edge.basis === null || BASIS.has(edge.basis as string))) fail(`${label}: basis is not null and not a basis word`);
      if (!(edge.verification === null || VERIFICATION.has(edge.verification as string))) fail(`${label}: verification is not null and not a verification word`);
      if (!(Array.isArray(edge.evidenceIds) && edge.evidenceIds.every((value) => typeof value === "string"))) fail(`${label}: evidenceIds is not an array of strings`);
      if (!(edge.sourceId === null || typeof edge.sourceId === "string")) fail(`${label}: sourceId is not a string or null`);
    }
  }

  if (!Array.isArray(parsed.steps)) fail("model: steps is not an array");
  else {
    const stepIds = new Set<string>();
    for (let i = 0; i < parsed.steps.length; i++) {
      const step = parsed.steps[i];
      if (!isRecord(step)) {
        fail(`step ${i}: not an object`);
        continue;
      }
      const id = typeof step.id === "string" ? step.id : null;
      const label = id === null ? `step ${i}` : `step ${id}`;
      if (!hasExactKeys(step, ["id", "title", "nodeIds", "edgeIds"])) fail(`${label}: keys differ from the step interface`);
      if (id === null) fail(`${label}: id is not a string`);
      else if (stepIds.has(id)) fail(`step ${id}: duplicate id`);
      else stepIds.add(id);
      if (typeof step.title !== "string") fail(`${label}: title is not a string`);
      if (!(Array.isArray(step.nodeIds) && step.nodeIds.every((value) => typeof value === "string"))) fail(`${label}: nodeIds is not an array of strings`);
      if (!(Array.isArray(step.edgeIds) && step.edgeIds.every((value) => typeof value === "string"))) fail(`${label}: edgeIds is not an array of strings`);
    }
    if (parsed.steps.length === 0 && sequence !== null) fail("model: sequence is set but steps is empty");
    if (parsed.steps.length > 0 && sequence === null) fail("model: steps are set but sequence is null");
  }

  return { clean: !markFailed, nodeIds, edgeIds };
}

function checkDangling(model: FlowchartModel, nodeIds: Set<string>, edgeIds: Set<string>, add: Add): boolean {
  let dangling = false;
  for (const edge of model.edges) {
    for (const side of ["from", "to"] as const) {
      const value = edge[side];
      if (!nodeIds.has(value)) {
        add("model-dangling", `edge ${edge.id}: ${side} "${value}" is not a node`);
        dangling = true;
      }
    }
  }
  for (const step of model.steps) {
    for (const nodeId of step.nodeIds) {
      if (!nodeIds.has(nodeId)) {
        add("model-dangling", `step ${step.id}: node "${nodeId}" is not in the model`);
        dangling = true;
      }
    }
    for (const edgeId of step.edgeIds) {
      if (!edgeIds.has(edgeId)) {
        add("model-dangling", `step ${step.id}: edge "${edgeId}" is not in the model`);
        dangling = true;
      }
    }
  }
  return dangling;
}

function phaseD(records: Rec[], add: Add): ModelResult {
  const result: ModelResult = { parsed: null, title: "", schemaClean: false, missing: false, dangling: false, model: null };
  const blocks = records.filter((record) => record.tag === "script" && attrOf(record, "id") === "linchpin-flowchart-model");
  if (blocks.length !== 1) {
    add("model-missing", `expected exactly one model block, found ${blocks.length}`);
    result.missing = true;
    return result;
  }
  const raw = blocks[0].text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    add("model-missing", "model block is not valid JSON");
    result.missing = true;
    return result;
  }
  result.parsed = parsed;
  if (isRecord(parsed) && typeof parsed.title === "string") result.title = parsed.title;

  let clean = true;
  const bad = (detail: string): void => {
    add("model-schema", detail);
    clean = false;
  };
  if (raw.includes("<")) bad("model block contains a raw <");
  const info = checkSchema(parsed, bad);
  if (!info.clean) clean = false;
  result.schemaClean = clean;
  if (!clean) return result;

  const model = parsed as unknown as FlowchartModel;
  result.model = model;
  let hash = "";
  try {
    hash = hashFlowchartModel(model);
  } catch {
    hash = "";
  }
  if (hash !== model.sha256) add("model-hash", "model: sha256 does not match the recomputed hash");
  result.dangling = checkDangling(model, info.nodeIds, info.edgeIds, add);
  return result;
}

function elementsById(records: Rec[], id: string): Rec[] {
  return records.filter((record) => attrOf(record, "id") === id);
}

function checkNodeGroup(group: Rec, node: FlowchartNode, add: Add): void {
  if (attrOf(group, "data-kind") !== node.kind) add("render-mismatch", `node ${node.id}: data-kind is not "${node.kind}"`);
  if (attrOf(group, "tabindex") !== "0") add("render-mismatch", `node ${node.id}: tabindex is not 0`);
  if (attrOf(group, "aria-label") !== node.label) add("render-mismatch", `node ${node.id}: aria-label is not "${node.label}"`);
  const rects = descendants(group).filter((record) => record.tag === "rect");
  if (rects.length !== 1) add("render-mismatch", `node ${node.id}: ${rects.length} rect elements`);
  else {
    for (const name of ["x", "y", "width", "height"]) {
      const value = attrOf(rects[0], name);
      if (value === null || !/^-?\d+(?:\.\d+)?$/.test(value)) add("render-mismatch", `node ${node.id}: rect ${name} is not numeric`);
    }
  }
  const texts = descendants(group).filter((record) => record.tag === "text");
  if (texts.length !== 1) add("render-mismatch", `node ${node.id}: ${texts.length} text elements`);
  else {
    if (texts[0].children.length !== 0) add("render-mismatch", `node ${node.id}: text has element children`);
    if (textOf(texts[0]) !== node.label) add("render-mismatch", `node ${node.id}: text is not "${node.label}"`);
  }
}

function checkEdgeGroup(group: Rec, edge: FlowchartEdge, labels: Map<string, string>, add: Add): void {
  const fromLabel = labels.get(edge.from) ?? edge.from;
  const toLabel = labels.get(edge.to) ?? edge.to;
  if (attrOf(group, "data-from") !== edge.from) add("render-mismatch", `edge ${edge.id}: data-from is not "${edge.from}"`);
  if (attrOf(group, "data-to") !== edge.to) add("render-mismatch", `edge ${edge.id}: data-to is not "${edge.to}"`);
  if (attrOf(group, "data-relation") !== edge.relation) add("render-mismatch", `edge ${edge.id}: data-relation is not "${edge.relation}"`);
  if (attrOf(group, "data-basis") !== (edge.basis ?? "none")) add("render-mismatch", `edge ${edge.id}: data-basis is not "${edge.basis ?? "none"}"`);
  if (attrOf(group, "data-verification") !== (edge.verification ?? "none")) add("render-mismatch", `edge ${edge.id}: data-verification is not "${edge.verification ?? "none"}"`);
  if (attrOf(group, "data-evidence-count") !== String(edge.evidenceIds.length)) add("render-mismatch", `edge ${edge.id}: data-evidence-count is not "${edge.evidenceIds.length}"`);
  if (attrOf(group, "tabindex") !== "0") add("render-mismatch", `edge ${edge.id}: tabindex is not 0`);
  if (attrOf(group, "aria-label") !== `${fromLabel} ${edge.relation} ${toLabel}`) add("render-mismatch", `edge ${edge.id}: aria-label is not "${fromLabel} ${edge.relation} ${toLabel}"`);
  const paths = descendants(group).filter((record) => record.tag === "path");
  if (paths.length !== 1) add("render-mismatch", `edge ${edge.id}: ${paths.length} path elements`);
  const texts = descendants(group).filter((record) => record.tag === "text");
  if (texts.length !== 1) add("render-mismatch", `edge ${edge.id}: ${texts.length} text elements`);
  else {
    if (texts[0].children.length !== 0) add("render-mismatch", `edge ${edge.id}: text has element children`);
    const text = textOf(texts[0]);
    if (!text.includes(edge.relation)) add("render-mismatch", `edge ${edge.id}: text does not include the relation`);
    if (!text.includes(edge.basis ?? "not evidence")) add("render-mismatch", `edge ${edge.id}: text does not include the basis`);
  }
}

function checkRow(row: Rec, cells: string[], add: Add, label: string): void {
  const tds = row.children.filter((record) => record.tag === "td");
  if (tds.length !== cells.length) {
    add("render-mismatch", `${label}: ${tds.length} cells, expected ${cells.length}`);
    return;
  }
  for (let i = 0; i < tds.length; i++) {
    if (tds[i].children.length !== 0) add("render-mismatch", `${label}: cell ${i + 1} has element children`);
    if (textOf(tds[i]) !== cells[i]) add("render-mismatch", `${label}: cell ${i + 1} is not "${cells[i]}"`);
  }
}

function checkList(records: Rec[], id: string, tag: string, add: Add): Rec | null {
  const found = elementsById(records, id);
  if (found.length !== 1) {
    add("render-mismatch", `${tag}#${id}: found ${found.length} elements`);
    return null;
  }
  if (found[0].tag !== tag) add("render-mismatch", `${tag}#${id}: element is <${found[0].tag}>`);
  return found[0];
}

function phaseE(records: Rec[], model: FlowchartModel, add: Add): void {
  const titles = records.filter((record) => record.tag === "title");
  if (titles.length === 1 && textOf(titles[0]) !== model.title) add("render-mismatch", `title: text is not "${model.title}"`);

  const charts = elementsById(records, "linchpin-flowchart");
  if (charts.length !== 1) add("render-mismatch", `chart: found ${charts.length} elements with id linchpin-flowchart`);
  let chart: Rec | null = charts.length === 1 ? charts[0] : charts[0] ?? null;
  if (chart) {
    if (chart.tag !== "svg") add("render-mismatch", `chart: element is <${chart.tag}>, not svg`);
    const viewBox = attrOf(chart, "viewbox");
    const parts = viewBox === null ? [] : viewBox.trim().split(/\s+/);
    if (parts.length !== 4 || !parts.every((part) => /^-?\d+(?:\.\d+)?$/.test(part))) add("render-mismatch", "chart: viewBox is missing or not four numbers");
  }

  const labels = new Map<string, string>();
  for (const node of model.nodes) labels.set(node.id, node.label);
  const nodeIds = new Set(model.nodes.map((node) => node.id));
  const edgeIds = new Set(model.edges.map((edge) => edge.id));

  const nodeGroups = records.filter((record) => attrOf(record, "data-node-id") !== null);
  const groupsByNode = new Map<string, Rec[]>();
  for (const group of nodeGroups) {
    const id = attrOf(group, "data-node-id") as string;
    if (group.tag !== "g" || !chart || !hasAncestor(group, chart)) add("render-mismatch", `element <${group.tag}> with data-node-id "${id}" outside the chart`);
    const list = groupsByNode.get(id) ?? [];
    list.push(group);
    groupsByNode.set(id, list);
  }
  for (const node of model.nodes) {
    const list = groupsByNode.get(node.id) ?? [];
    if (list.length !== 1) add("render-mismatch", `node ${node.id}: ${list.length} groups`);
    if (list.length >= 1) checkNodeGroup(list[0], node, add);
  }
  for (const id of groupsByNode.keys()) if (!nodeIds.has(id)) add("render-mismatch", `node ${id}: not in the model`);

  const edgeGroups = records.filter((record) => attrOf(record, "data-edge-id") !== null);
  const groupsByEdge = new Map<string, Rec[]>();
  for (const group of edgeGroups) {
    const id = attrOf(group, "data-edge-id") as string;
    if (group.tag !== "g" || !chart || !hasAncestor(group, chart)) add("render-mismatch", `element <${group.tag}> with data-edge-id "${id}" outside the chart`);
    const list = groupsByEdge.get(id) ?? [];
    list.push(group);
    groupsByEdge.set(id, list);
  }
  for (const edge of model.edges) {
    const list = groupsByEdge.get(edge.id) ?? [];
    if (list.length !== 1) add("render-mismatch", `edge ${edge.id}: ${list.length} groups`);
    if (list.length >= 1) checkEdgeGroup(list[0], edge, labels, add);
  }
  for (const id of groupsByEdge.keys()) if (!edgeIds.has(id)) add("render-mismatch", `edge ${id}: not in the model`);

  const nodesTable = checkList(records, "linchpin-flowchart-nodes", "table", add);
  const nodeRows = records.filter((record) => attrOf(record, "data-node-row") !== null);
  const rowsByNode = new Map<string, Rec[]>();
  for (const row of nodeRows) {
    const id = attrOf(row, "data-node-row") as string;
    if (row.tag !== "tr" || !nodesTable || !hasAncestor(row, nodesTable)) add("render-mismatch", `element <${row.tag}> with data-node-row "${id}" outside the nodes table`);
    const list = rowsByNode.get(id) ?? [];
    list.push(row);
    rowsByNode.set(id, list);
  }
  for (const node of model.nodes) {
    const list = rowsByNode.get(node.id) ?? [];
    if (list.length !== 1) add("render-mismatch", `node ${node.id}: ${list.length} rows`);
    if (list.length >= 1) checkRow(list[0], [node.id, node.kind, node.label], add, `node ${node.id}`);
  }
  for (const id of rowsByNode.keys()) if (!nodeIds.has(id)) add("render-mismatch", `node ${id}: row not in the model`);

  const edgesTable = checkList(records, "linchpin-flowchart-edges", "table", add);
  const edgeRows = records.filter((record) => attrOf(record, "data-edge-row") !== null);
  const rowsByEdge = new Map<string, Rec[]>();
  for (const row of edgeRows) {
    const id = attrOf(row, "data-edge-row") as string;
    if (row.tag !== "tr" || !edgesTable || !hasAncestor(row, edgesTable)) add("render-mismatch", `element <${row.tag}> with data-edge-row "${id}" outside the edges table`);
    const list = rowsByEdge.get(id) ?? [];
    list.push(row);
    rowsByEdge.set(id, list);
  }
  for (const edge of model.edges) {
    const list = rowsByEdge.get(edge.id) ?? [];
    if (list.length !== 1) add("render-mismatch", `edge ${edge.id}: ${list.length} rows`);
    if (list.length >= 1) {
      const cells = [
        edge.id,
        labels.get(edge.from) ?? edge.from,
        edge.relation,
        labels.get(edge.to) ?? edge.to,
        edge.basis ?? "not evidence",
        edge.verification ?? "not stated",
        edge.evidenceIds.length > 0 ? edge.evidenceIds.join(", ") : "no evidence",
        edge.sourceId ?? "none",
      ];
      checkRow(list[0], cells, add, `edge ${edge.id}`);
    }
  }
  for (const id of rowsByEdge.keys()) if (!edgeIds.has(id)) add("render-mismatch", `edge ${id}: row not in the model`);

  const source = elementsById(records, "linchpin-flowchart-source");
  if (source.length !== 1) add("render-mismatch", `source: found ${source.length} elements`);
  else {
    if (source[0].tag !== "p") add("render-mismatch", `source: element is <${source[0].tag}>, not p`);
    if (source[0].children.length !== 0) add("render-mismatch", "source: element has children");
    if (textOf(source[0]) !== model.source) add("render-mismatch", `source: text is not "${model.source}"`);
  }

  const sequence = elementsById(records, "linchpin-flowchart-sequence");
  if (sequence.length !== 1) add("render-mismatch", `sequence: found ${sequence.length} elements`);
  else {
    if (sequence[0].tag !== "p") add("render-mismatch", `sequence: element is <${sequence[0].tag}>, not p`);
    const expected = sequenceLine(model.sequence);
    if (sequence[0].children.length !== 0) add("render-mismatch", "sequence: element has children");
    if (textOf(sequence[0]) !== expected) add("render-mismatch", `sequence: text is not "${expected}"`);
  }

  const stepsList = checkList(records, "linchpin-flowchart-steps", "ol", add);
  const stepRecords = records.filter((record) => attrOf(record, "data-step-id") !== null);
  const stepIds = new Map<string, Rec>();
  const stepCounts = new Map<string, number>();
  for (const record of stepRecords) {
    const id = attrOf(record, "data-step-id") as string;
    if (!stepsList || record.parent !== stepsList || record.tag !== "li") add("render-mismatch", `step ${id}: item is not an li child of the steps list`);
    stepCounts.set(id, (stepCounts.get(id) ?? 0) + 1);
    if (!stepIds.has(id)) stepIds.set(id, record);
  }
  for (const [id, count] of stepCounts) if (count !== 1) add("render-mismatch", `step ${id}: ${count} items, expected 1`);
  for (const step of model.steps) {
    const item = stepIds.get(step.id);
    if (!item) {
      add("render-mismatch", `step ${step.id}: missing from the document`);
      continue;
    }
    const text = textOf(item);
    if (!text.includes(step.title)) add("render-mismatch", `step ${step.id}: text does not include the title`);
    for (const nodeId of step.nodeIds) if (!text.includes(labels.get(nodeId) ?? nodeId)) add("render-mismatch", `step ${step.id}: text does not include node "${nodeId}"`);
  }
  for (const id of stepIds.keys()) if (!model.steps.some((step) => step.id === id)) add("render-mismatch", `step ${id}: not in the model`);
  if (stepsList) {
    const documentStepIds: string[] = [];
    for (const child of stepsList.children) {
      if (child.tag !== "li") continue;
      const id = attrOf(child, "data-step-id");
      if (id === null) add("render-mismatch", "step: an li item has no data-step-id");
      else documentStepIds.push(id);
    }
    if (documentStepIds.length !== model.steps.length) add("render-mismatch", `steps: ${documentStepIds.length} items in the document, ${model.steps.length} in the model`);
    const expectedIds = model.steps.map((step) => step.id);
    if (expectedIds.length === documentStepIds.length && expectedIds.some((id, i) => id !== documentStepIds[i])) add("render-mismatch", "steps: item order differs from the model");
  }

  const notesList = checkList(records, "linchpin-flowchart-notes", "ul", add);
  const noteRecords = records.filter((record) => hasAttr(record, "data-note"));
  const noteItems = noteRecords.filter((record) => notesList !== null && record.parent === notesList && record.tag === "li");
  for (const record of noteRecords) {
    if (!notesList || record.parent !== notesList || record.tag !== "li") add("render-mismatch", "note: item is not an li child of the notes list");
  }
  if (notesList) {
    if (noteItems.length !== model.notes.length) add("render-mismatch", `notes: ${noteItems.length} items in the document, ${model.notes.length} in the model`);
    else for (let i = 0; i < noteItems.length; i++) if (textOf(noteItems[i]) !== model.notes[i]) add("render-mismatch", `note ${i + 1}: text differs`);
  }

  const inspector = elementsById(records, "linchpin-flowchart-inspector");
  if (inspector.length !== 1) add("render-mismatch", `inspector: found ${inspector.length} elements`);
  else {
    if (inspector[0].tag !== "aside") add("render-mismatch", `inspector: element is <${inspector[0].tag}>, not aside`);
    if (attrOf(inspector[0], "aria-live") !== "polite") add("render-mismatch", "inspector: aria-live is not polite");
    if (inspector[0].children.length !== 0) add("render-mismatch", "inspector: element has children");
    if (textOf(inspector[0]) !== "Select a node or an edge") add("render-mismatch", "inspector: text is not the served hint");
  }

  const count = model.steps.length || model.nodes.length;
  const unit = model.steps.length ? "step" : "item";
  const controls = checkList(records, "linchpin-flowchart-controls", "div", add);
  const names = ["play", "stop", "replay", "prev", "next"];
  const labelsButton = ["Play", "Stop", "Replay", `Previous ${unit}`, `Next ${unit}`];
  const buttons = records.filter(record => record.tag === "button");
  if (buttons.length !== 5 || controls?.children.length !== 5) add("render-mismatch", "controls: expected exactly five buttons");
  names.forEach((name, i) => {
    const id = `linchpin-flowchart-${name}`;
    const b = checkList(records, id, "button", add);
    if (!b) return;
    if (b.parent !== controls || controls?.children[i] !== b || b.children.length || textOf(b) !== labelsButton[i] || attrOf(b, "type") !== "button" || hasAttr(b, "disabled") !== (count === 0 || name === "stop")) add("render-mismatch", `${id}: invalid control`);
  });
  const plain = (suffix: string, expected: string): Rec | null => {
    const id = `linchpin-flowchart-${suffix}`;
    const r = checkList(records, id, "p", add);
    if (r && (r.children.length || textOf(r) !== expected)) add("render-mismatch", `${id}: invalid text`);
    return r;
  };
  const status = plain("playback-status", `Stopped — item 0 of ${count}${count ? "" : ". No items to play."}`);
  if (status && (attrOf(status, "role") !== "status" || attrOf(status, "aria-live") !== "polite" || attrOf(status, "aria-atomic") !== "true")) add("render-mismatch", "playback-status: accessibility");
  const mode = plain("playback-mode", model.steps.length ? `Model steps — sequence ${model.sequence === null ? "not stated" : "shown above"}` : "Guided walkthrough — reading order, not observed execution");
  const help = plain("playback-help", "Playback needs JavaScript");
  const canvas = checkList(records, "linchpin-flowchart-canvas", "div", add);
  const chartWrap = checkList(records, "linchpin-flowchart-chart", "div", add);
  if (canvas && (attrOf(canvas, "tabindex") !== "0" || attrOf(canvas, "aria-label") !== "Scrollable flowchart")) add("render-mismatch", "canvas: accessibility");
  const workspaces = records.filter(r => (attrOf(r, "class") ?? "").split(/\s+/).includes("flowchart-workspace"));
  const workspace = workspaces[0];
  if (workspaces.length !== 1 || workspace.tag !== "div" || workspace.children.length !== 2 || workspace.children[0] !== canvas || workspace.children[1] !== inspector[0] || canvas?.children.length !== 1 || canvas.children[0] !== chartWrap || chartWrap?.children.length !== 1 || chartWrap.children[0] !== chart) add("render-mismatch", "workspace: invalid nesting");
  const ordered = [source[0], sequence[0], controls, status, mode, help, workspace, stepsList, notesList, nodesTable, edgesTable];
  let previous = -1;
  for (const r of ordered) {
    if (!r || r.parent?.tag !== "body" || records.indexOf(r) <= previous) add("render-mismatch", "workspace: invalid body order");
    if (r) previous = records.indexOf(r);
  }
  const viewport = records.filter(r => r.tag === "meta" && attrOf(r, "name") === "viewport");
  if (viewport.length !== 1 || attrOf(viewport[0], "content") !== "width=device-width, initial-scale=1" || viewport[0].parent?.tag !== "head" || viewport[0].parent.children[1] !== viewport[0]) add("render-mismatch", "viewport: invalid metadata");

}

function phaseF(input: FlowchartInput, result: ModelResult, add: Add): void {
  let projected: FlowchartModel | null = null;
  try {
    projected = toFlowchartModel(input, result.title);
  } catch (error) {
    if (error instanceof FlowchartError) {
      for (const problem of error.problems) add(problem.code, problem.detail);
    } else {
      add("source-invalid", `input: ${error instanceof Error ? error.message : String(error)}`);
    }
    return;
  }
  if (!projected || !result.model || !result.schemaClean || result.missing) return;
  const model = result.model;
  if (model.source !== projected.source) {
    add("source-mismatch", `source: document "${model.source}", input "${projected.source}"`);
    return;
  }

  const documentNodes = new Map(model.nodes.map((node) => [node.id, node]));
  const inputNodes = new Map(projected.nodes.map((node) => [node.id, node]));
  let nodeDiff = false;
  for (const node of model.nodes) {
    const other = inputNodes.get(node.id);
    if (!other) {
      add("source-mismatch", `node ${node.id}: not in the input`);
      nodeDiff = true;
      continue;
    }
    if (node.kind !== other.kind) {
      add("source-mismatch", `node ${node.id}: kind "${node.kind}" in the document, "${other.kind}" in the input`);
      nodeDiff = true;
    }
    if (node.label !== other.label) {
      add("source-mismatch", `node ${node.id}: label "${node.label}" in the document, "${other.label}" in the input`);
      nodeDiff = true;
    }
  }
  for (const node of projected.nodes) {
    if (!documentNodes.has(node.id)) {
      add("source-mismatch", `node ${node.id}: in the input, not in the document`);
      nodeDiff = true;
    }
  }

  const key = (edge: FlowchartEdge): string => JSON.stringify([edge.from, edge.relation, edge.to, edge.basis, edge.verification, edge.evidenceIds, edge.sourceId]);
  const remaining = new Map<string, FlowchartEdge[]>();
  for (const edge of projected.edges) {
    const k = key(edge);
    const list = remaining.get(k) ?? [];
    list.push(edge);
    remaining.set(k, list);
  }
  let edgeDiff = false;
  for (const edge of model.edges) {
    const list = remaining.get(key(edge));
    if (list && list.length > 0) list.pop();
    else {
      add("source-mismatch", `edge ${edge.id} ${edge.from} -${edge.relation}-> ${edge.to}: not in the input`);
      edgeDiff = true;
    }
  }
  for (const list of remaining.values()) {
    for (const edge of list) {
      add("source-mismatch", `edge ${edge.from} -${edge.relation}-> ${edge.to} (${edge.basis ?? "none"}): in the input, not in the document`);
      edgeDiff = true;
    }
  }

  if (!nodeDiff && !edgeDiff) {
    let differs = false;
    try {
      differs = hashFlowchartModel(model) !== hashFlowchartModel(projected);
    } catch {
      differs = false;
    }
    if (differs) add("source-mismatch", "model: differs from the projection of the input");
  }
}

export function validateFlowchartHtml(html: string, input?: FlowchartInput): FlowchartProblem[] {
  const problems: FlowchartProblem[] = [];
  const seen = new Set<string>();
  const add: Add = (code, detail) => {
    if (problems.length >= 200) return;
    const key = `${code}\u0000${detail}`;
    if (seen.has(key)) return;
    seen.add(key);
    problems.push({ code, detail });
  };
  try {
    if (typeof html !== "string") {
      add("document", "document is not a string");
      return problems;
    }
    phaseA(html, add);
    const walk = walkDocument(html, add);
    if (!walk.ok) {
      add("document", "could not walk the document");
      return problems;
    }
    phaseFrame(walk.records, add);
    phaseC(walk.records, add);
    const model = phaseD(walk.records, add);
    if (model.model && !model.missing && model.schemaClean && !model.dangling) phaseE(walk.records, model.model, add);
    if (input !== undefined) phaseF(input, model, add);
  } catch (error) {
    add("document", `validator error: ${error instanceof Error ? error.message : String(error)}`);
  }
  return problems;
}
