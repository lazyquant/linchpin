/** The drawn tree as an HTML string. Every text and attribute value is escaped; nothing that runs is ever emitted. */
import type { SurfaceTree, UiNode } from "./types";

const NAME = /^[a-zA-Z][a-zA-Z0-9:-]*$/;
/** Elements that are never drawn, whoever built the tree. */
const DROPPED_TAGS = new Set(["script", "style", "iframe", "frame", "frameset", "object", "embed", "link", "meta", "base", "form", "template"]);
/** Attributes that carry a URL or a document. The kit builds no link and loads nothing. */
const DROPPED_ATTRS = new Set(["style", "href", "xlink:href", "src", "srcset", "srcdoc", "action", "formaction", "poster", "background", "ping", "data"]);
const VOID_TAGS = new Set(["area", "br", "col", "hr", "img", "input", "source", "track", "wbr"]);

/** Whether an element with this tag may be drawn. Shared by the string renderer and the live one. */
export function allowedTag(tag: unknown): tag is string {
  return typeof tag === "string" && NAME.test(tag) && !DROPPED_TAGS.has(tag.toLowerCase());
}

/** Whether an attribute with this name may be drawn: no `style`, no event handler, no URL-bearing attribute. */
export function allowedAttr(name: unknown): name is string {
  if (typeof name !== "string" || !NAME.test(name)) return false;
  const lower = name.toLowerCase();
  return !lower.startsWith("on") && !DROPPED_ATTRS.has(lower);
}

export function escapeHtml(text: string): string {
  return String(text).replace(/[&<>"']/g, (char) => (char === "&" ? "&amp;" : char === "<" ? "&lt;" : char === ">" ? "&gt;" : char === '"' ? "&quot;" : "&#39;"));
}

function nodeToHtml(node: UiNode, out: string[]): void {
  if (node === null || typeof node !== "object" || !allowedTag(node.tag)) return;
  out.push("<", node.tag);
  const attrs = node.attrs !== null && typeof node.attrs === "object" ? node.attrs : {};
  for (const name of Object.keys(attrs)) {
    if (!allowedAttr(name)) continue;
    out.push(" ", name, '="', escapeHtml(attrs[name]), '"');
  }
  out.push(">");
  if (VOID_TAGS.has(node.tag.toLowerCase())) return;
  if (typeof node.text === "string" && node.text !== "") out.push(escapeHtml(node.text));
  if (Array.isArray(node.children)) for (const child of node.children) nodeToHtml(child, out);
  out.push("</", node.tag, ">");
}

/** Serialises a surface tree, or one node. The same tree gives the same bytes. */
export function treeToHtml(tree: SurfaceTree | UiNode): string {
  const node = "root" in tree ? tree.root : tree;
  const out: string[] = [];
  nodeToHtml(node, out);
  return out.join("");
}
