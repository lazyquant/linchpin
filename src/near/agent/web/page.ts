import { escapeHtml } from "../../../ui/html";
import { LABELS, SCRIPTED_LABEL } from "./strings";

/** Layout of the native request control only; evidence styling belongs to the kit. */
export const CONTROL_CSS = "#request select { max-width: 100%; }";

/** Request controls collect finite inputs. Every answer value is mounted by the kit. */
export function agentPage(subjects: Iterable<string>): string {
  const options = [...subjects].sort().map(s => `<option value="${escapeHtml(s)}"${s === "near:mainnet:intents.near" ? " selected" : ""}>${escapeHtml(s)}</option>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${LABELS.title}</title><link rel="stylesheet" href="/kit.css"><link rel="stylesheet" href="/controls.css"><script type="module" src="/client.js"></script></head>
<body class="lk-page"><main><section class="lk-surface" aria-labelledby="page-title"><h1 id="page-title">${LABELS.title}</h1><p>Recorded public evidence, deterministic tools and model-report metadata.</p>
<form id="request"><p><label for="kind">Task</label> <select id="kind" name="kind"><option value="control">${LABELS.control}</option><option value="preflight">${LABELS.preflight}</option><option value="policy">${LABELS.policyTask}</option></select></p>
<p><label for="subject">${LABELS.subject}</label> <select id="subject" name="subject">${options}</select></p>
<p id="preflight-intent" hidden>Preflight reads the recorded contract call to contract.main.burrow.near under quantrin-near-v1. It executes nothing.</p>
<p id="policy-intent" hidden>Policy reads quantrin-near-v1 over the loaded public snapshot.</p>
<p><label><input id="offline" type="checkbox"> Use a prepared answer</label></p><button type="submit">${LABELS.ask}</button></form>
<p id="status" role="status" aria-live="polite"></p><p id="mode-label"></p>
<nav aria-label="Prepared requests"><p>${LABELS.prepared}</p><button type="button" data-prepared="control">${LABELS.control}</button> <button type="button" data-prepared="preflight">${LABELS.preflight}</button> <button type="button" data-prepared="policy">${LABELS.policyTask}</button><p>${SCRIPTED_LABEL}</p></nav></section>
<div id="answer" aria-label="Evidence answer"></div></main></body></html>`;
}
