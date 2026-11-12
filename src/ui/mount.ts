/**
 * The drawn tree on a live page. Elements are created one by one and text arrives as text: no markup string is
 * ever parsed. The same elements and attributes are left out as in the string renderer.
 */
import { allowedAttr, allowedTag } from "./html";
import type { SurfaceTree, UiNode } from "./types";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

function build(node: UiNode, doc: Document, inSvg: boolean): Element | null {
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
      const built = build(child, doc, svg);
      if (built) children.push(built);
    }
  }
  if (children.length > 0) element.append(...children);
  return element;
}

/** Replaces the content of `element` with the tree. */
export function mount(tree: SurfaceTree | UiNode, element: Element): void {
  const node = "root" in tree ? tree.root : tree;
  const built = build(node, element.ownerDocument, false);
  if (built) element.replaceChildren(built);
  else element.replaceChildren();
}
