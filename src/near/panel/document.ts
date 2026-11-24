import { isNearAccountId } from "../reader/types";
import { KIT_CSS } from "../../ui/page";
import { PanelRejected } from "./types";

const reject=():never=>{throw new PanelRejected("invalid-document");};
const scriptChars=/[<>&\u2028\u2029]/g;
/** Canonical JSON, without invoking getters or toJSON, suitable for an inert script element. */
export function serializePanelData(input:unknown):string {
  const stack=new Set<object>();
  const encode=(value:unknown,depth:number):string=>{
    if (depth>512) return reject();
    if (value === null) return "null";
    if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
    if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : reject();
    if (typeof value !== "object") return reject();
    if (stack.has(value)) return reject();
    const proto=Object.getPrototypeOf(value);
    if (Array.isArray(value) ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) return reject();
    const keys=Reflect.ownKeys(value);
    if (keys.some(k=>typeof k !== "string")) return reject();
    const properties=new Map<string,PropertyDescriptor>();
    for (const key of keys as string[]) {
      const d=Object.getOwnPropertyDescriptor(value,key)!;
      if (Array.isArray(value) && key === "length") continue;
      if (!d.enumerable || !("value" in d)) return reject();
      properties.set(key,d);
    }
    stack.add(value);
    let result:string;
    if (Array.isArray(value)) {
      if (properties.size !== value.length) return reject();
      const parts:string[]=[];
      for (let i=0;i<value.length;i++) {
        const d=properties.get(String(i)); if (!d) return reject();
        parts.push(encode(d.value,depth+1));
      }
      result="["+parts.join(",")+"]";
    } else {
      result="{"+[...properties.keys()].sort().map(k=>JSON.stringify(k)+":"+encode(properties.get(k)!.value,depth+1)).join(",")+"}";
    }
    stack.delete(value);return result;
  };
  try { return encode(input,0).replace(scriptChars,c=>"\\u"+c.charCodeAt(0).toString(16).padStart(4,"0")); }
  catch (e) { if (e instanceof PanelRejected) throw e; return reject(); }
}
export interface PanelLinks { chartHref:string; indexHref:string }
export function validatePanelLinks(account:string,links:PanelLinks):void {
  if (!isNearAccountId(account) || !links || links.chartHref !== account + ".chart.html" || links.indexHref !== "index.html" ||
      /[\\/%?#:\u0000-\u0020]/.test(links.chartHref) || links.chartHref.includes("..") || /[\\/%?#:\u0000-\u0020]/.test(links.indexHref)) reject();
}
const count=(s:string,needle:string):number=>s.split(needle).length-1;
/** Compose only the two bounded additions around an already validated kit document. */
export function composePanelDocument(kitHtml:string,account:string,data:unknown,links:PanelLinks={chartHref:account+".chart.html",indexHref:"index.html"}):{html:string;json:string} {
  validatePanelLinks(account,links);
  const json=serializePanelData(data);
  if (typeof kitHtml !== "string" || !kitHtml.startsWith("<!doctype html>\n<html lang=") ||
      !kitHtml.endsWith("</body>\n</html>\n") || count(kitHtml,'<body class="lk-page">\n') !== 1 ||
      count(kitHtml,'<main class="lk-surface">') !== 1 || count(kitHtml,"</main>") !== 1 ||
      (kitHtml.match(/<main\b/gi) ?? []).length !== 1 || (kitHtml.match(/<body\b/gi) ?? []).length !== 1 ||
      count(kitHtml,"</body>") !== 1 || count(kitHtml,"<style>") !== 1 || count(kitHtml,"</style>") !== 1 ||
      !kitHtml.includes("<style>"+KIT_CSS+"</style>") ||
      count(kitHtml,'<script type="application/json" id="lk-messages">') !== 1 ||
      (kitHtml.match(/<script\b/gi) ?? []).length !== 1 ||
      /\bid\s*=\s*(?:"lk-panel-(?:data|links)"|'lk-panel-(?:data|links)'|lk-panel-(?:data|links)(?=[\s>]))/i.test(kitHtml)) reject();
  const nav='<nav id="lk-panel-links" class="lk-row" aria-label="Panel files"><a href="'+links.chartHref+'" style="color:inherit">Chart</a> · <a href="'+links.indexHref+'" style="color:inherit">Index</a></nav>';
  const block='<script type="application/json" id="lk-panel-data">'+json+'</script>\n';
  const html=kitHtml.replace("</main>",()=>nav+"</main>").replace("</body>",()=>block+"</body>");
  return {html,json};
}

