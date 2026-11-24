/**
 * The document of the app: one self-contained file. The stylesheet (fonts as data, the kit's rules, the shell's
 * rules), the fixed frame, the data as an inert block and the page script are all inline, so the file opens from
 * disk and from the loopback server alike and loads nothing else. Bun only.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { escapeHtml, treeToHtml } from "../../ui/html";
import { KIT_CSS } from "../../ui/page";
import appCss from "./app.css" with { type: "text" };
import { IDS, frameTree } from "./chrome";
import type { AppData } from "./model";
import { APP_STRINGS } from "./strings";

export interface Assets { script: string; css: string }

const FONTS: readonly { family: string; weight: string; file: string }[] = [
  { family: "Source Serif 4", weight: "600", file: "source-serif-4-600-latin.woff2" },
  { family: "IBM Plex Sans", weight: "400", file: "ibm-plex-sans-400-latin.woff2" },
  { family: "IBM Plex Sans", weight: "500", file: "ibm-plex-sans-500-latin.woff2" },
  { family: "IBM Plex Mono", weight: "400", file: "ibm-plex-mono-400-latin.woff2" },
  { family: "IBM Plex Mono", weight: "500", file: "ibm-plex-mono-500-latin.woff2" },
];

/** The five font files of the site as `@font-face` rules with the bytes inline. No file is requested at run time. */
export function fontFaces(): string {
  return FONTS.map(({ family, weight, file }) => {
    const bytes = readFileSync(fileURLToPath(new URL(`../../site/fonts/${file}`, import.meta.url)));
    return `@font-face{font-family:"${family}";font-style:normal;font-weight:${weight};font-display:swap;src:url(data:font/woff2;base64,${bytes.toString("base64")}) format("woff2")}`;
  }).join("\n");
}

let built: Promise<Assets> | null = null;
/** The page script and the stylesheet, built once per process. */
export function buildAssets(): Promise<Assets> {
  built ??= (async () => {
    const result = await Bun.build({ entrypoints: [fileURLToPath(new URL("./client.ts", import.meta.url))], target: "browser", format: "iife", minify: true });
    if (!result.success || result.outputs.length !== 1) throw new Error("the page script was not built");
    // Inside a script element no text may read as the end of the element or as the start of a comment.
    const script = (await result.outputs[0].text()).replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");
    return { script, css: `${fontFaces()}\n${KIT_CSS}\n${appCss}` };
  })();
  return built;
}

/** JSON that can sit inside a script element of type application/json: no character that could end the element. */
const UNSAFE_IN_SCRIPT = new RegExp("[<>&" + String.fromCharCode(0x2028, 0x2029) + "]", "g");
export function inertJson(value: unknown): string {
  return JSON.stringify(value).replace(UNSAFE_IN_SCRIPT, (char) => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"));
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("base64");

/** The content policy of the document: its own inline script and stylesheet by hash, fonts as data, requests to its own origin only. */
export function contentPolicy(assets: Assets): string {
  return `default-src 'none'; script-src 'sha256-${sha256(assets.script)}'; style-src 'sha256-${sha256(assets.css)}'; font-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'`;
}

/** The whole document. The same data and assets give the same bytes. */
export function buildDocument(data: AppData, assets: Assets): string {
  return (
    `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n<meta name="color-scheme" content="light dark">\n` +
    `<meta name="referrer" content="no-referrer">\n<meta http-equiv="content-security-policy" content="${escapeHtml(contentPolicy(assets))}">\n` +
    `<title>${escapeHtml(APP_STRINGS.pageTitle)}</title>\n<style>${assets.css}</style>\n</head>\n<body class="lk-page">\n${treeToHtml(frameTree())}\n` +
    `<script type="application/json" id="${IDS.data}">${inertJson(data)}</script>\n<script>${assets.script}</script>\n</body>\n</html>\n`
  );
}
