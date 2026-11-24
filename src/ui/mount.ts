/**
 * The drawn tree on a live page. Elements are created one by one and text arrives as text: no markup string is
 * ever parsed. The same elements and attributes are left out as in the string renderer.
 */
import { allowedAttr, allowedTag } from "./html";
import { CLASSES, SELECT_ATTR, SELECT_ID_ATTR } from "./strings";
import type { SurfaceTree, UiNode } from "./types";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/** What a reader can select on a mounted tree: an evidence id, or a node, an edge or a group of an explorer. */
export type SelectKind = "evidence" | "node" | "edge" | "group";
export interface MountOptions {
  /** Called when a reader activates a selectable element by click, Enter or Space. The page's code supplies it; data never does. */
  onSelect?: (kind: SelectKind, id: string) => void;
}
type OnSelect = (kind: SelectKind, id: string) => void;
const SELECT_KINDS: readonly string[] = ["node", "edge", "group"];

/** What activating this node selects, or `null`. */
function selection(node: UiNode, attrs: Record<string, string>): { kind: SelectKind; id: string } | null {
  const kind = attrs[SELECT_ATTR];
  const id = attrs[SELECT_ID_ATTR];
  if (typeof kind === "string" && SELECT_KINDS.includes(kind) && typeof id === "string" && id !== "") return { kind: kind as SelectKind, id };
  const classes = typeof attrs.class === "string" ? attrs.class.split(/\s+/) : [];
  if (node.tag === "code" && classes.includes(CLASSES.evidenceId) && typeof node.text === "string" && node.text !== "") return { kind: "evidence", id: node.text };
  return null;
}

function makeSelectable(element: Element, selected: { kind: SelectKind; id: string }, onSelect: OnSelect): void {
  element.setAttribute("tabindex", "0");
  element.setAttribute("role", "button");
  const stop = (event: Event): void => {
    if (typeof event.stopPropagation === "function") event.stopPropagation();
  };
  element.addEventListener("click", (event: Event) => {
    stop(event);
    onSelect(selected.kind, selected.id);
  });
  element.addEventListener("keydown", (event: Event) => {
    const key = (event as KeyboardEvent).key;
    if (key !== "Enter" && key !== " " && key !== "Spacebar") return;
    if (typeof event.preventDefault === "function") event.preventDefault();
    stop(event);
    onSelect(selected.kind, selected.id);
  });
}

function build(node: UiNode, doc: Document, inSvg: boolean, onSelect: OnSelect | undefined): Element | null {
  if (node === null || typeof node !== "object" || !allowedTag(node.tag)) return null;
  const svg = inSvg || node.tag.toLowerCase() === "svg";
  const element = svg ? doc.createElementNS(SVG_NAMESPACE, node.tag) : doc.createElement(node.tag);
  const attrs = node.attrs !== null && typeof node.attrs === "object" ? node.attrs : {};
  for (const name of Object.keys(attrs)) {
    if (allowedAttr(name)) element.setAttribute(name, String(attrs[name]));
  }
  if (typeof node.text === "string" && node.text !== "") element.textContent = node.text;
  const children: Element[] = [];
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      const built = build(child, doc, svg, onSelect);
      if (built) children.push(built);
    }
  }
  if (children.length > 0) element.append(...children);
  if (onSelect) {
    const selected = selection(node, attrs);
    if (selected) makeSelectable(element, selected, onSelect);
  }
  return element;
}

/**
 * Replaces the content of `element` with the tree. With `options.onSelect`, evidence ids and the nodes, edges and
 * groups of an explorer can be focused and activated; without it the elements are exactly those of the tree.
 */
export function mount(tree: SurfaceTree | UiNode, element: Element, options?: MountOptions): void {
  const node = "root" in tree ? tree.root : tree;
  const built = build(node, element.ownerDocument, false, options?.onSelect);
  if (built) element.replaceChildren(built);
  else element.replaceChildren();
}
