/**
 * The served document: a fixed frame of labels, the stylesheet and the page script, all from this origin. It holds
 * no value of a book, a policy or a snapshot, no address and no token; the script fetches those with the token.
 */
import { escapeHtml, treeToHtml } from "../ui/html";
import { pageTree } from "./chrome";
import { DESK_STRINGS } from "./strings";

/** The same bytes on every call. */
export function deskPage(): string {
  return (
    `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n<meta name="color-scheme" content="light dark">\n` +
    `<meta name="referrer" content="no-referrer">\n<title>${escapeHtml(DESK_STRINGS.pageTitle)}</title>\n` +
    `<link rel="stylesheet" href="/desk.css">\n</head>\n<body class="lk-page">\n${treeToHtml(pageTree())}\n` +
    `<script type="module" src="/desk.js"></script>\n</body>\n</html>\n`
  );
}
