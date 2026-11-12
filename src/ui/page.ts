/** One self-contained HTML document for a surface: the kit stylesheet inline, the static tree, the messages as inert data. */
import css from "./kit.css" with { type: "text" };
import { escapeHtml, treeToHtml } from "./html";
import { interpret } from "./interpret";
import { UiRejected } from "./types";
import type { CoverageInput, ResolveEvidence } from "./types";
import { validateSurface } from "./validate";

/** The kit stylesheet as text. */
export const KIT_CSS: string = css;

const LANG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/** JSON that can sit inside a script element of type application/json: no character that could end the element. */
const UNSAFE_IN_SCRIPT = new RegExp("[<>&" + String.fromCharCode(0x2028, 0x2029) + "]", "g");
function inertJson(value: unknown): string {
  return JSON.stringify(value).replace(UNSAFE_IN_SCRIPT, (char) => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"));
}

/**
 * The document around a drawn body. `bodyHtml` must come from `treeToHtml`. With `messages`, they are added as one
 * `application/json` block that nothing on the page reads or runs.
 */
export function pageShell(opts: { title: string; lang: string; bodyHtml: string; messages?: unknown }): string {
  if (typeof opts.lang !== "string" || !LANG.test(opts.lang)) throw new UiRejected("bad-lang");
  const data = opts.messages === undefined ? "" : `<script type="application/json" id="lk-messages">${inertJson(opts.messages)}</script>\n`;
  return (
    `<!doctype html>\n<html lang="${escapeHtml(opts.lang)}">\n<head>\n<meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n<meta name="color-scheme" content="light dark">\n` +
    `<title>${escapeHtml(opts.title)}</title>\n<style>${KIT_CSS}</style>\n</head>\n<body class="lk-page">\n${opts.bodyHtml}\n${data}</body>\n</html>\n`
  );
}

/**
 * Validates the surface, then returns its page. A surface that fails validation is refused with
 * `UiRejected("invalid-surface", codes)` and nothing is returned. The same input gives the same bytes.
 */
export function standalonePage(
  messages: unknown,
  opts: { title: string; lang: string; resolveEvidence: ResolveEvidence; coverage?: CoverageInput },
): string {
  if (typeof opts.lang !== "string" || !LANG.test(opts.lang)) throw new UiRejected("bad-lang");
  const verdict = validateSurface(messages, { resolveEvidence: opts.resolveEvidence, coverage: opts.coverage });
  if (!verdict.ok) throw new UiRejected("invalid-surface", verdict.codes);
  return pageShell({ title: String(opts.title), lang: opts.lang, bodyHtml: treeToHtml(interpret(messages)), messages });
}
