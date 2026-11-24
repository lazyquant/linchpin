/**
 * The stand-alone page: a fixed document with the kit stylesheet, the layout of a question box and one answer
 * region, and the page script. It holds no value of a bundle; the script fetches the prepared answers and the
 * protocol names from the same origin. The look of everything drawn is the kit's; the rules here place blocks and
 * give the page's own fields a box in kit tokens.
 */
import { escapeHtml } from "../../ui/html";
import { KIT_CSS } from "../../ui/page";
import { PINNED_LABEL, PREPARED_TITLE } from "../compose";
import { PAGE_STRINGS } from "./strings";

/** The page's own rules: where blocks sit, and a box in kit tokens for the form fields. Colours come from the kit's tokens only. */
export const LAYOUT_CSS = `
.aa-page {
  max-width: 1440px;
  padding: 32px 32px 72px;
}

.aa-masthead {
  display: grid;
  gap: 8px;
  padding-bottom: 20px;
  border-bottom: 1px solid var(--lk-ink);
}

.aa-wordmark {
  color: var(--lk-accent);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

.lk-surface .aa-masthead h1 {
  font-size: 28px;
  line-height: 1.2;
  letter-spacing: -0.01em;
}

.aa-lede {
  max-width: 76ch;
  color: var(--lk-ink-muted);
}

.aa-layout {
  display: grid;
  grid-template-columns: minmax(280px, 340px) minmax(0, 1fr);
  gap: 48px;
  align-items: start;
  padding-top: 28px;
}

.aa-rail {
  position: sticky;
  top: 0;
  display: grid;
  gap: 28px;
  min-width: 0;
  max-height: 100vh;
  margin-left: -4px;
  padding: 4px 4px 24px;
  overflow-y: auto;
}

.aa-ask,
.aa-prepared,
.aa-group,
.aa-field {
  display: grid;
  min-width: 0;
}

.aa-ask {
  gap: 14px;
}

.aa-field {
  gap: 5px;
}

.lk-surface .aa-rail h2 {
  font-size: 19px;
  line-height: 1.3;
}

.aa-field-label,
.lk-surface .aa-group-title,
.aa-origin-kind {
  color: var(--lk-ink-muted);
  font-family: var(--lk-font-sans);
  font-size: 11px;
  font-weight: 500;
  line-height: 1.5;
  letter-spacing: 0.09em;
  text-transform: uppercase;
}

.aa-input {
  width: 100%;
  min-width: 0;
  padding: 8px 10px;
  border: 1px solid var(--lk-ink-muted);
  border-radius: 2px;
  background: var(--lk-paper);
  color: var(--lk-ink);
  font-family: var(--lk-font-sans);
  font-size: 15px;
  line-height: 1.5;
}

textarea.aa-input {
  min-height: 92px;
  resize: vertical;
}

.aa-hint,
.aa-prepared-label,
.aa-status,
.aa-origin {
  color: var(--lk-ink-muted);
  font-size: 13px;
  line-height: 1.5;
}

.aa-button {
  justify-self: start;
  padding: 7px 18px;
  border: 1px solid var(--lk-ink);
  border-radius: 2px;
  background: var(--lk-paper-deep);
  color: var(--lk-ink);
  font-family: var(--lk-font-sans);
  font-size: 14px;
  font-weight: 600;
  line-height: 1.4;
  cursor: pointer;
}

.aa-button:disabled,
.aa-question:disabled {
  color: var(--lk-ink-muted);
  cursor: default;
}

.aa-button:disabled {
  border-style: dashed;
}

.aa-status {
  padding-left: 10px;
  border-left: 2px solid var(--lk-rule);
}

.aa-status:empty {
  display: none;
}

.aa-prepared {
  gap: 6px;
  padding-top: 20px;
  border-top: 1px solid var(--lk-ink);
}

.aa-groups {
  display: grid;
  gap: 20px;
  padding-top: 12px;
}

.aa-group {
  gap: 4px;
}

.aa-questions {
  display: grid;
}

.aa-question {
  display: block;
  width: 100%;
  padding: 8px 8px 8px 12px;
  border: 0;
  border-left: 2px solid transparent;
  border-bottom: 1px solid var(--lk-rule);
  border-radius: 0;
  background: transparent;
  color: var(--lk-ink);
  font-family: var(--lk-font-sans);
  font-size: 14px;
  line-height: 1.45;
  text-align: left;
  overflow-wrap: anywhere;
  cursor: pointer;
}

.aa-question:hover:not(:disabled) {
  border-left-color: var(--lk-ink-muted);
  background: var(--lk-paper-deep);
}

/* The focus ring of a row sits inside the row, so the scrolling rail never cuts it. */
.lk-surface .aa-question:focus-visible {
  outline-offset: -2px;
}

.aa-question[aria-current="true"] {
  border-left-color: var(--lk-accent);
  background: var(--lk-paper-deep);
  font-weight: 600;
}

.aa-answer {
  display: grid;
  gap: 18px;
  min-width: 0;
  min-height: 320px;
  align-content: start;
  scroll-margin-top: 16px;
}

.aa-answer:focus {
  outline: none;
}

.aa-origin {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 12px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--lk-rule);
}

.aa-origin:empty {
  display: none;
}

.aa-region,
.aa-drawn {
  min-width: 0;
}

/* A wide table stays inside the answer: the region scrolls sideways, the page does not. */
.aa-region {
  overflow-x: auto;
}

.aa-drawn {
  display: grid;
  gap: 28px;
}

@media (max-width: 1179px) {
  .aa-page {
    padding: 24px 20px 56px;
  }

  .aa-layout {
    grid-template-columns: minmax(0, 1fr);
    gap: 40px;
  }

  .aa-rail {
    position: static;
    max-height: none;
    margin-left: 0;
    padding: 0;
    overflow: visible;
  }

  .aa-ask {
    max-width: 640px;
  }

  .aa-answer {
    min-height: 0;
  }
}

@media (max-width: 480px) {
  .aa-page {
    padding: 16px 12px 48px;
  }

  .lk-surface .aa-masthead h1 {
    font-size: 24px;
  }

  .aa-button {
    justify-self: stretch;
    padding: 10px 18px;
    text-align: center;
  }

  .aa-question {
    padding: 11px 8px 11px 12px;
  }
}
`;

/** Everything inside the page's one style element: the kit stylesheet, then the layout. */
export const PAGE_STYLE: string = `${KIT_CSS}\n${LAYOUT_CSS}`;

const S = PAGE_STRINGS;
const text = escapeHtml;

/** The document. The same bytes on every call. */
export function answersPage(): string {
  return (
    `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n<meta name="color-scheme" content="light dark">\n` +
    `<meta name="referrer" content="no-referrer">\n<title>${text(S.title)}</title>\n<style>${PAGE_STYLE}</style>\n</head>\n` +
    `<body class="lk-page">\n<div class="lk-surface aa-page">\n` +
    `<header class="aa-masthead">\n<p class="aa-wordmark">${text(S.wordmark)}</p>\n<h1>${text(S.heading)}</h1>\n<p class="aa-lede">${text(S.lede)}</p>\n</header>\n` +
    `<div class="aa-layout">\n<div class="aa-rail">\n` +
    `<form class="aa-ask" id="aa-form" autocomplete="off">\n<h2>${text(S.askHeading)}</h2>\n` +
    `<div class="aa-field"><label class="aa-field-label" for="aa-protocol">${text(S.protocol)}</label>` +
    `<select class="aa-input" id="aa-protocol" name="protocol" required disabled></select></div>\n` +
    `<div class="aa-field"><label class="aa-field-label" for="aa-question">${text(S.question)}</label>` +
    `<textarea class="aa-input" id="aa-question" name="question" rows="3" maxlength="600" required aria-describedby="aa-hint"></textarea>` +
    `<p class="aa-hint" id="aa-hint">${text(S.questionHint)}</p></div>\n` +
    `<button class="aa-button" id="aa-submit" type="submit" disabled>${text(S.ask)}</button>\n` +
    `<p class="aa-status" id="aa-status" role="status" aria-live="polite"></p>\n</form>\n` +
    `<section class="aa-prepared" aria-labelledby="aa-prepared-heading">\n<h2 id="aa-prepared-heading">${text(PREPARED_TITLE)}</h2>\n` +
    `<p class="aa-prepared-label">${text(PINNED_LABEL)}</p>\n<div class="aa-groups" id="aa-prepared"></div>\n</section>\n` +
    `</div>\n` +
    `<section class="aa-answer" id="aa-answer" aria-label="${text(S.answerLabel)}" tabindex="-1">\n<p class="aa-origin" id="aa-origin"></p>\n` +
    `<div class="aa-region" id="aa-region"><p class="lk-empty">${text(S.waiting)}</p></div>\n</section>\n` +
    `</div>\n</div>\n<script type="module" src="/answers.js"></script>\n</body>\n</html>\n`
  );
}
