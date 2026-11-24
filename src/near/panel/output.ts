import { constants } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import type { EvidenceStore } from "../../engine/queries/snapshot";
import { loadNearSnapshots, liveSnapshotIds, nearSnapshotDir, readNearManifest } from "../reader/load";
import { NEAR_BANNED_WORDS } from "../private/render";
import { NEAR_REGISTRY } from "../subjects/registry";
import { instantiate } from "../../ui/templates";
import { standalonePage } from "../../ui/page";
import type { ResultSet } from "../../ui/types";
import { buildPanel, createPanelReadStore, type BuildPanelOptions } from "./build";
import { panelSurface, panelKitPage } from "./surface";
import { composePanelDocument, serializePanelData } from "./document";
import { panelChart } from "./chart";
import { PanelRejected, type PanelData } from "./types";

export const PANEL_REPO_ROOT=resolve(import.meta.dir,"../../..");
const hasAdviceWord=(text:string):boolean=>NEAR_BANNED_WORDS.some(word=>new RegExp("\\b"+word+"\\b","i").test(text));
export interface RenderedPanel { data:PanelData; html:string; json:string; chart:string; kitHtml:string; messages:ReturnType<typeof panelSurface> }
export function renderPanel(data:PanelData):RenderedPanel {
  serializePanelData(data);
  if (data.sections.some(s=>s.id === "identity" && s.rows.length)) throw new PanelRejected("invalid-document",data.subject);
  const messages=panelSurface(data),kitHtml=panelKitPage(data,messages);
  const document=composePanelDocument(kitHtml,data.account,data);
  const chart=panelChart(data);
  if (hasAdviceWord(document.html) || hasAdviceWord(document.json) || hasAdviceWord(chart)) throw new PanelRejected("invalid-surface",data.subject,["advice-word"]);
  if (/https?:|@import|url\(/i.test(document.html)) throw new PanelRejected("invalid-surface",data.subject,["remote-load"]);
  return {data,html:document.html,json:document.json,chart,kitHtml,messages};
}
export function preparePanel(store:EvidenceStore,snapshotId:string,subject:string,opts:BuildPanelOptions={}):RenderedPanel {
  return renderPanel(buildPanel(store,snapshotId,subject,opts));
}
export interface PanelIndexEntry { account:string; subject:string; kind:string; html:string; json:string; chart:string; sha256:string }
const hash=(text:string):string=>createHash("sha256").update(text).digest("hex");
export function panelFiles(panel:RenderedPanel):Map<string,string> {
  const a=panel.data.account;
  return new Map([[a+".html",panel.html],[a+".json",panel.json],[a+".chart.html",panel.chart]]);
}
export function preparePanels(inputStore:EvidenceStore,snapshotId:string,opts:BuildPanelOptions={}):Map<string,string> {
  const store=createPanelReadStore(inputStore);
  const snapshot=store.snapshot(snapshotId);
  if (!snapshot) throw new PanelRejected("missing-subject");
  const registry=opts.registry ?? NEAR_REGISTRY;
  const entries:PanelIndexEntry[]=[],files=new Map<string,string>();
  const subjects=[...registry].filter(e=>snapshot.subjects.includes(e.subject)).sort((a,b)=>a.account < b.account ? -1 : a.account > b.account ? 1 : 0);
  if (new Set(subjects.map(e=>e.account)).size !== subjects.length) throw new PanelRejected("invalid-document");
  for (const entry of subjects) {
    const panel=preparePanel(store,snapshotId,entry.subject,opts);
    if (entry.account !== panel.data.account || entry.subject !== panel.data.subject || entry.account === "index") throw new PanelRejected("invalid-document",entry.subject);
    for (const [name,bytes] of panelFiles(panel)) files.set(name,bytes);
    entries.push({account:entry.account,subject:entry.subject,kind:panel.data.kind,
      html:entry.account+".html",json:entry.account+".json",chart:entry.account+".chart.html",sha256:hash(panel.json)});
  }
  files.set("index.json",serializePanelData(entries));
  const result:ResultSet={resultId:"panels-index",shape:"table",coverage:"mapped",coverageNotes:[],truncated:false,
    columns:[{name:"account",role:"address"},{name:"subject",role:"subject"},{name:"kind",role:"label"},{name:"html",role:"value"},{name:"json",role:"value"},{name:"chart",role:"value"},{name:"sha256",role:"value"}],
    rows:entries.map((entry,i)=>({rowKind:"scope",key:String(i),values:{...entry},factIds:[],bases:[],evidenceIds:[],blockOrSlot:null,asOf:snapshot.observedTo,snapshotIds:[snapshotId],scopeSource:snapshotId+" · subject registry"}))};
  const messages=instantiate("subject-panel",{surfaceId:"near-panels-index",meta:{
    title:"NEAR panels",kind:"Captured subject registry",snapshotIds:[snapshotId],
    fromBlockOrSlot:snapshot.fromBlockOrSlot,toBlockOrSlot:snapshot.toBlockOrSlot,capturedAt:snapshot.observedTo,constructed:snapshot.constructed,
  },results:[result],titles:{"panels-index":"Panels"}});
  files.set("index.html",standalonePage(messages,{title:"NEAR panels",lang:"en",resolveEvidence:ids=>({missing:ids})}));
  if ([...files.values()].some(hasAdviceWord)) throw new PanelRejected("invalid-surface",null,["advice-word"]);
  return files;
}
function within(parent:string,child:string):boolean {
  const r=relative(parent,child);return r === "" || r !== ".." && !r.startsWith(".."+sep) && !isAbsolute(r);
}
/** Permit OS-managed temporary-directory aliases; other symlink substitutions are refused. */
async function outputRoot(input:string):Promise<string> {
  const selected=resolve(input);
  let ancestor=selected; const suffix:string[]=[];
  for (;;) {
    const s=await lstat(ancestor).catch((e:NodeJS.ErrnoException)=>{if(e.code === "ENOENT") return null;throw e;});
    if (s) {
      if (!s.isDirectory() && !s.isSymbolicLink()) throw new PanelRejected("invalid-document");
      if (!(await lstat(await realpath(ancestor))).isDirectory()) throw new PanelRejected("invalid-document");
      break;
    }
    suffix.unshift(basename(ancestor));const p=dirname(ancestor);if(p === ancestor) throw new PanelRejected("invalid-document");ancestor=p;
  }
  const canonical=resolve(await realpath(ancestor),...suffix);
  let expected=selected;
  for (const temp of [tmpdir(),"/tmp","/var/tmp"]) {
    const actual=await realpath(temp).catch(()=>null);
    if (actual && within(resolve(temp),selected)) {expected=resolve(actual,relative(resolve(temp),selected));break;}
  }
  if (canonical !== expected) throw new PanelRejected("invalid-document");
  for (const name of ["src","fixtures","tests","docs","scripts",".git"]) {
    const input=resolve(PANEL_REPO_ROOT,name);
    if (within(canonical,input) || within(input,canonical)) throw new PanelRejected("invalid-document");
  }
  return canonical;
}
/** All document validation completes before this writer creates the destination or opens any file. */
export async function writePanelFiles(outDir:string,files:ReadonlyMap<string,string>):Promise<string[]> {
  const root=await outputRoot(outDir),names=[...files.keys()].sort();
  for (const name of names) {
    if (!/^[a-z0-9]+(?:[-_.][a-z0-9]+)*\.(?:html|json)$/.test(name) || name.includes("..") || typeof files.get(name) !== "string") throw new PanelRejected("invalid-document");
    const st=await lstat(join(root,name)).catch((e:NodeJS.ErrnoException)=>{if(e.code === "ENOENT") return null;throw e;});
    if (st && (!st.isFile() || st.isSymbolicLink())) throw new PanelRejected("invalid-document");
  }
  await mkdir(root,{recursive:true});
  for (const name of names) {
    if (await realpath(root) !== root) throw new PanelRejected("invalid-document");
    const f=await open(join(root,name),constants.O_WRONLY|constants.O_CREAT|constants.O_TRUNC|constants.O_NOFOLLOW,0o644);
    try {await f.writeFile(files.get(name)!,"utf8");} finally {await f.close();}
  }
  return names;
}
export async function writePanel(store:EvidenceStore,snapshotId:string,subject:string,outDir:string,opts:BuildPanelOptions={}):Promise<string[]> {
  return writePanelFiles(outDir,panelFiles(preparePanel(store,snapshotId,subject,opts)));
}
export interface SitePanelPreparation { files:Map<string,string>; warnings:string[] }
/** The site's selected directory remains the only source; normalized copies still pass the reader's hash checks. */
export async function prepareSitePanels(directory:string,allowConstructed=false):Promise<SitePanelPreparation> {
  const source=resolve(directory),manifest=await Bun.file(join(source,"manifest.json")).json();
  // Earlier landing-only constructed fixtures have no evidence-store contract to project.
  if (allowConstructed && manifest.constructed === true && manifest.version === undefined && manifest.readerVersion === undefined) {
    return {files:new Map(),warnings:["Constructed landing fixture has no evidence store; subject panels were not built."]};
  }
  if (manifest.constructed && !allowConstructed) throw new PanelRejected("invalid-document");
  const id=manifest.snapshotId;
  if (typeof id !== "string") throw new PanelRejected("invalid-document");
  const candidate=id.startsWith("near-constructed-") ? dirname(dirname(source)) : dirname(source);
  let root=candidate,temp:string|null=null;
  try {
    if (resolve(nearSnapshotDir(id,candidate)) !== source) {
      temp=await mkdtemp(join(tmpdir(),"near-panel-input-"));root=temp;
      await cp(source,nearSnapshotDir(id,root),{recursive:true,errorOnExist:true,force:false});
    }
    readNearManifest(id,{root});
    const earlier=!manifest.constructed ? liveSnapshotIds(root).filter(s=>s < id).at(-1) : undefined;
    const ids=earlier ? [earlier,id] : [id];
    return {files:preparePanels(loadNearSnapshots(ids,{root}),id,earlier ? {beforeSnapshotId:earlier} : {}),warnings:[]};
  } finally {if(temp) await rm(temp,{recursive:true,force:true});}
}

