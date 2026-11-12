import { mkdir, readdir, rm, lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { loadFacts, SiteFactError, type SiteFact, type SiteFacts } from "./facts";
import * as content from "./content";

const root = resolve(import.meta.dir, "../..");
const defaultOut = join(root, "dist/site");
const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const copy: Record<string, string> = { ...content.copy };
const configurations: Record<string, string | null> = { siteUrl: content.siteUrl, demoVideoUrl: content.demoVideoUrl, xPostUrl: content.xPostUrl };

export type BuildSiteOptions = {
  nearSnapshotDir?: string; solanaFixturesDir?: string; samplesDir?: string;
  outDir?: string; strict?: boolean; allowConstructed?: boolean;
};
export type BuildSiteResult = { outDir: string; files: string[]; factsUsed: string[]; warnings: string[] };

/** Display variants share the original fact's receipt. */
export function factDisplay(fact: SiteFact, variant: string | undefined, data: SiteFacts): string {
  if (!variant) return fact.value;
  const stem = basename(fact.receiptId);
  switch (variant) {
    case "block": return fact.block.toLocaleString("en-US");
    case "receipt": return `${(stem.match(/[a-f0-9]{8,}$/i)?.[0] ?? stem).slice(0, 8)}…`;
    case "sha256": return `${fact.responseSha256.slice(0, 8)}…`;
    case "explorer": return fact.chain === "near"
      ? `https://nearblocks.io/address/${encodeURIComponent(fact.account)}`
      : `https://solscan.io/tx/${encodeURIComponent(data.facts.get("solana.mip14.signature")!.value)}`;
    case "file": return `https://github.com/lazyquant/linchpin/blob/${content.githubRef}/fixtures/${fact.chain === "near" ? "near/" : ""}${fact.receiptId}.json`;
    default: throw new SiteFactError(fact.key, fact.file, `unknown fact display ${variant}`);
  }
}
async function rewrite(html: string, configure: (rewriter: HTMLRewriter) => HTMLRewriter): Promise<string> {
  return configure(new HTMLRewriter()).transform(new Response(html)).text();
}
function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}
async function checkedOutDir(path: string, inputs: string[]): Promise<string> {
  const out = resolve(path);
  // Resolve the nearest existing ancestor before allowing recursive removal.
  let ancestor = out;
  const suffix: string[] = [];
  for (;;) {
    try { await lstat(ancestor); break; }
    catch (error: any) {
      if (error.code !== "ENOENT") throw error;
      suffix.unshift(basename(ancestor)); ancestor = dirname(ancestor);
    }
  }
  const canonical = resolve(await realpath(ancestor), ...suffix);
  const temp = await realpath(tmpdir());
  const systemTemp = await realpath("/tmp").catch(() => temp);
  const normalDefault = resolve(await realpath(root), "dist/site");
  if (!(out === defaultOut && canonical === normalDefault) && !inside(temp, canonical) && !inside(systemTemp, canonical)) {
    throw new Error("output directory must be dist/site or a child of the OS temporary directory");
  }
  for (const input of inputs) {
    const actual = await realpath(input).catch(() => resolve(input));
    if (actual === canonical || inside(canonical, actual)) throw new Error("output directory contains build inputs");
  }
  if ((await lstat(out).catch(() => null))?.isSymbolicLink()) throw new Error("output directory cannot be a symbolic link");
  return out;
}

export async function buildSite(opts: BuildSiteOptions = {}): Promise<BuildSiteResult> {
  const nearSnapshotDir = resolve(opts.nearSnapshotDir ?? join(root, "fixtures/near", content.snapshotId));
  const solanaFixturesDir = resolve(opts.solanaFixturesDir ?? join(root, "fixtures"));
  const sampleDirectory = (config: { directory: string }) => resolve(opts.samplesDir ?? join(root, config.directory));
  const data = await loadFacts({ nearSnapshotDir, solanaFixturesDir, allowConstructed: opts.allowConstructed });
  const warnings: string[] = [];
  if (opts.allowConstructed) warnings.push("--allow-constructed is set; this build is for fixture validation.");
  const factsUsed = new Set<string>();
  function lookup(key: string): { fact: SiteFact; value: string } {
    const [base, variant, extra] = key.split("#");
    const fact = data.facts.get(base!);
    if (!fact || extra !== undefined) throw new SiteFactError(key, "page template", `missing fact ${key}`);
    factsUsed.add(key);
    return { fact, value: factDisplay(fact, variant, data) };
  }
  const receipts = new Map<string, { id: string; key: string; fact: SiteFact }>();
  for (const key of content.receiptRailKeys) {
    const { fact } = lookup(key);
    if (!receipts.has(fact.receiptId)) receipts.set(fact.receiptId, { id: `r${receipts.size + 1}`, key, fact });
  }
  const factHTML = (key: string) => {
    const { fact, value } = lookup(key);
    return `<span class="fact" data-fact="${escape(key)}" data-receipt="${escape(fact.receiptId)}">${escape(value)}</span>`;
  };
  function expand(text: string): string {
    return text.replace(/\{([^{}]+)\}/g, (_whole, token: string) => {
      const split = token.indexOf(":"), kind = token.slice(0, split), key = token.slice(split + 1);
      if (kind === "fact") return factHTML(key);
      if (kind === "ref") {
        const { fact } = lookup(key), receipt = receipts.get(fact.receiptId);
        if (!receipt) throw new SiteFactError(key, fact.file, "missing receipt rail entry");
        return `<a class="ref" href="#${receipt.id}" aria-label="Receipt ${receipt.id}">${receipt.id}</a>`;
      }
      throw new Error(`unknown copy token ${token}`);
    });
  }
  const expandedCopy = Object.fromEntries(Object.entries(copy).map(([key, value]) => [key, expand(value)]));
  if (content.ironclawDemonstrated) {
    expandedCopy["reviews.risk.ask"] = expandedCopy["reviews.risk.ask"]!.replace("MCP server.", "MCP server, for example from an IronClaw agent.");
    expandedCopy["diagram.outputs"] = "CLI · report · MCP for IronClaw";
  }
  const sampleOutput = new Map<string, { text: string; first: string; pending: boolean; sample: string }>();
  for (const [name, config] of Object.entries(content.excerpts)) {
    const file = join(sampleDirectory(config), config.sample);
    let problem: string | undefined;
    let lines: string[] = [], start = 0;
    if (!(await Bun.file(file).exists())) problem = "missing sample";
    else {
      lines = (await Bun.file(file).text()).replaceAll("\r\n", "\n").replace(/\n$/, "").split("\n");
      start = config.from == null ? 0 : lines.findIndex(line => line.startsWith(config.from!));
      if (start < 0) problem = "absent sample prefix";
      else if (config.maxLines < 6 || config.maxLines > 10 || lines.slice(start, start + config.maxLines).length < 6) problem = "sample requires 6–10 excerpt lines";
    }
    if (problem) {
      if (opts.strict) throw new Error(`${problem}: ${file}`);
      warnings.push(`${problem}: ${file}`);
      sampleOutput.set(name, { text: content.pendingExcerpt, first: content.pendingExcerpt, pending: true, sample: config.sample });
    } else sampleOutput.set(name, { text: lines.slice(start, start + config.maxLines).join("\n"), first: lines[0]!, pending: false, sample: config.sample });
  }
  const template = await Bun.file(join(import.meta.dir, "index.html")).text();
  const slots = new Set<string>();
  await rewrite(template, r => r.on("[data-slot]", { element(e) {
    const key = e.getAttribute("data-slot")!;
    if (!(key in expandedCopy)) throw new Error(`missing copy for slot ${key}`);
    slots.add(key);
  } }).on("[data-fact]", { element(e) { lookup(e.getAttribute("data-fact")!); } })
    .on("[data-fact-link]", { element(e) { lookup(e.getAttribute("data-fact-link")!); } }));
  for (const key of Object.keys(copy)) if (!slots.has(key)) throw new Error(`copy key has no slot: ${key}`);
  const outDir = await checkedOutDir(opts.outDir ?? defaultOut, [import.meta.dir, nearSnapshotDir, solanaFixturesDir, ...Object.values(content.excerpts).map(sampleDirectory)]);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "index.html")], outdir: outDir, minify: true,
    plugins: [{ name: "local-font-files", setup(build) {
      build.onResolve({ filter: /\.woff2$/ }, async args => {
        const source = resolve(args.resolveDir, args.path);
        if (!inside(join(import.meta.dir, "fonts"), source)) throw new Error("font must be vendored locally");
        const bytes = await Bun.file(source).arrayBuffer();
        const file = `${basename(source, ".woff2")}-${Bun.hash(bytes).toString(16)}.woff2`;
        await Bun.write(join(outDir, file), bytes);
        return { path: `./${file}`, external: true };
      });
    } }],
    naming: { asset: "[name]-[hash].[ext]", chunk: "[name]-[hash].[ext]", entry: "[name].[ext]" },
  });
  if (!result.success) throw new Error(`Bun build failed: ${result.logs.map(String).join("\n")}`);
  // Bun emits an empty entry module even for a stylesheet-only HTML entry.
  const emptyModules = new Set<string>();
  for (const file of await readdir(outDir)) if (file.endsWith(".js")) {
    if ((await Bun.file(join(outDir, file)).text()).trim()) throw new Error("unexpected client module in static build");
    emptyModules.add(file);
    await rm(join(outDir, file));
  }
  let html = await Bun.file(join(outDir, "index.html")).text();
  html = await rewrite(html, r => r.on("script", { element(e) {
    const src = e.getAttribute("src");
    if (!src || !emptyModules.has(src.replace(/^\.\//, ""))) throw new Error("unexpected script in static build");
    e.remove();
  } }));
  html = await rewrite(html, r => r
    .on("[data-slot]", { element(e) { e.setInnerContent(expandedCopy[e.getAttribute("data-slot")!]!, { html: true }); } })
    .on("[data-config]", { element(e) {
      const key = e.getAttribute("data-config")!;
      if (!(key in configurations)) throw new Error(`unknown configuration ${key}`);
      const value = configurations[key];
      if (value == null) e.remove(); else e.setAttribute("href", value);
    } })
    .on("[data-ironclaw]", { element(e) { if (!content.ironclawDemonstrated) e.remove(); } })
    .on("[data-excerpt], [data-excerpt-line]", { element(e) {
      const name = e.getAttribute("data-excerpt") ?? e.getAttribute("data-excerpt-line")!;
      const sample = sampleOutput.get(name);
      if (!sample) throw new Error(`unknown excerpt ${name}`);
      e.setAttribute("data-sample", sample.sample);
      e.setAttribute("data-excerpt-status", sample.pending ? "pending" : "ready");
      e.setInnerContent(e.hasAttribute("data-excerpt") ? sample.text : sample.first);
    } })
    .on("[data-rail]", { element(e) {
      if (e.getAttribute("data-rail") !== "problem") throw new Error("unknown receipt rail");
      e.setInnerContent([...receipts.values()].map(({ id, key, fact }) =>
        `<li id="${id}"><span class="rid">${id}</span><span><code>${escape(fact.account)}</code><br><code>${escape(fact.method)}</code><br>block ${factHTML(`${key}#block`)} · <a href="${escape(factDisplay(fact, "file", data))}">${factHTML(`${key}#receipt`)}</a></span></li>`
      ).join(""), { html: true });
    } })
    .on("body", { element(e) { if (data.snapshot.constructed) e.prepend(`<p class="constructed" data-constructed>${escape(content.constructedNotice)}</p>`, { html: true }); } }));
  // A second pass also visits the fact tokens and links inserted from copy.
  html = await rewrite(html, r => r
    .on("[data-fact]", { element(e) {
      const { fact, value } = lookup(e.getAttribute("data-fact")!);
      e.setAttribute("data-receipt", fact.receiptId); e.setInnerContent(value);
    } })
    .on("[data-fact-link]", { element(e) { e.setAttribute("href", lookup(e.getAttribute("data-fact-link")!).value); } }));
  let currentSlot: { key: string; text: string } | null = null;
  await rewrite(html, r => r.on("[data-slot]", {
    element(e) {
      const slot = { key: e.getAttribute("data-slot")!, text: "" }; currentSlot = slot;
      e.onEndTag(() => { if (!slot.text.trim()) throw new Error(`empty copy slot ${slot.key}`); currentSlot = null; });
    }, text(t) { if (currentSlot) currentSlot.text += t.text; },
  }));
  await Bun.write(join(outDir, "index.html"), html);
  return { outDir, files: (await readdir(outDir)).sort(), factsUsed: [...factsUsed].sort(), warnings };
}

async function main() {
  const [command = "build", ...args] = Bun.argv.slice(2);
  if (command !== "build" && command !== "serve") throw new Error(`unknown command ${command}`);
  const opts: BuildSiteOptions = {};
  let port = 8876;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--strict") opts.strict = true;
    else if (flag === "--allow-constructed") opts.allowConstructed = true;
    else if (["--snapshot", "--samples", "--out", "--port"].includes(flag!)) {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`missing value for ${flag}`);
      if (flag === "--snapshot") opts.nearSnapshotDir = value;
      else if (flag === "--samples") opts.samplesDir = value;
      else if (flag === "--out") opts.outDir = value;
      else {
        port = Number(value);
        if (command !== "serve" || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port requires serve and a port from 1 to 65535");
      }
    } else throw new Error(`unknown option ${flag}`);
  }
  const result = await buildSite(opts);
  for (const warning of result.warnings) console.warn(`site:build warning: ${warning}`);
  console.log(`Built ${result.files.length} files in ${result.outDir}`);
  if (command === "serve") {
    const allowed = new Set(result.files);
    const server = Bun.serve({ hostname: "127.0.0.1", port, async fetch(req) {
      const path = new URL(req.url).pathname;
      const file = path === "/" ? "index.html" : path.slice(1);
      if ((req.method !== "GET" && req.method !== "HEAD") || !allowed.has(file)) return new Response("Not found", { status: 404 });
      return new Response(req.method === "HEAD" ? null : Bun.file(join(result.outDir, file)), { headers: { "Content-Type": Bun.file(join(result.outDir, file)).type } });
    } });
    console.log(`Serving ${server.url}`);
  }
}
if (import.meta.main) main().catch(error => { console.error(`site:build failed: ${error instanceof Error ? error.message : error}`); process.exitCode = 1; });
