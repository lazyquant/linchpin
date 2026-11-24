import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, symlink } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The public tree includes tests, but intentionally omits these operator scripts.
// Computed imports keep that tree typecheckable without expanding its publish scope.
const hosting = join(import.meta.dir, "../scripts/hosting");
if (existsSync(join(hosting, "static-server.ts"))) await hostingTests();
else test.skip("hosting preparation is private operator tooling, absent from this tree", () => {});

async function hostingTests() {
  const { checkPreparation, EXAMPLE_CONFIG, validateTunnelConfig } = await import(join(hosting, "check.ts"));
  const { checkedSiteRoot, createStaticHandler, parseStaticArgs, REPO_ROOT, SITE_ROOT, STATIC_HOST, STATIC_PORT } = await import(join(hosting, "static-server.ts"));

  const temp = await mkdtemp(join(tmpdir(), "linchpin-hosting-"));
  const root = join(temp, "site");
  await mkdir(root);
  await Bun.write(join(root, "index.html"), "<!doctype html><title>Built site</title>");
  await Bun.write(join(root, "asset.woff2"), new Uint8Array([0, 1, 2, 255]));
  await Bun.write(join(root, "main.css"), "body { color: black }");
  await Bun.write(join(root, "data.json"), '{"public":true}');
  await Bun.write(join(root, "unknown.asset"), "opaque");
  await Bun.write(join(root, "name with space.txt"), "space");
  await Bun.write(join(root, ".hidden"), "must not be served");
  await mkdir(join(root, ".private"));
  await Bun.write(join(root, ".private", "data.json"), "must not be served");
  await mkdir(join(root, "empty"));
  await Bun.write(join(temp, "outside.txt"), "outside root");
  await symlink(join(temp, "outside.txt"), join(root, "outside-link.txt"));
  await symlink(join(root, "data.json"), join(root, "inside-link.json"));
  await symlink(REPO_ROOT, join(root, "repo-link"));
  await symlink(join(temp, "absent"), join(root, "dangling.txt"));

  const handler = await createStaticHandler(root);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  const request = (path: string, method = "GET") => handler(new Request(`http://localhost${path}`, { method }));
  afterAll(async () => { await server.stop(true); await rm(temp, { recursive: true, force: true }); });

  /** Send the wire target directly; Bun may still collapse dot segments before the handler. */
  function rawRequest(path: string, method = "GET"): Promise<{ status: number; text: string }> {
    return new Promise((resolve, reject) => {
      const socket = createConnection({ host: "127.0.0.1", port: server.port! });
      let response = "";
      socket.setEncoding("utf8");
      socket.setTimeout(3000, () => socket.destroy(new Error("HTTP test timeout")));
      socket.on("connect", () => socket.write(`${method} ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`));
      socket.on("data", data => { response += data; });
      socket.on("error", reject);
      socket.on("end", () => resolve({ status: Number(/^HTTP\/1\.1 (\d+)/.exec(response)?.[1]), text: response }));
    });
  }

  describe("restricted static surface", () => {
    test("serves the index and GET/HEAD metadata, with no HEAD body", async () => {
      const get = await request("/?query=.private");
      const head = await request("/", "HEAD");
      expect(get.status).toBe(200);
      expect(head.status).toBe(200);
      expect(await get.text()).toContain("Built site");
      expect(await head.text()).toBe("");
      expect(head.headers.get("content-length")).toBe(get.headers.get("content-length"));
      expect(head.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(head.headers.get("x-content-type-options")).toBe("nosniff");
      expect(head.headers.get("cache-control")).toBe("no-store");
      expect((await rawRequest("/", "HEAD")).text.split("\r\n\r\n")[1]).toBe("");
    });

    test("serves woff2, JSON, CSS and safe unknown MIME without corrupting bytes", async () => {
      for (const [path, mime] of [["/asset.woff2", "font/woff2"], ["/data.json", "application/json; charset=utf-8"], ["/main.css", "text/css; charset=utf-8"], ["/unknown.asset", "application/octet-stream"]]) {
        const response = await request(path!);
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe(mime!);
      }
      expect(new Uint8Array(await (await request("/asset.woff2")).arrayBuffer())).toEqual(new Uint8Array([0, 1, 2, 255]));
      expect(await (await request("/data.json")).json()).toEqual({ public: true });
      expect(await (await request("/name%20with%20space.txt")).text()).toBe("space");
    });

    test("recursively serves future panels created after startup, with directory indexes", async () => {
      const panel = join(root, "panels", "near", "intents");
      await mkdir(panel, { recursive: true });
      await Bun.write(join(panel, "index.html"), "<title>Nested panel</title>");
      await Bun.write(join(panel, "evidence.json"), '{"receipt":"public"}');
      expect(await (await request("/panels/near/intents/")).text()).toContain("Nested panel");
      expect((await request("/panels/near/intents/index.html", "HEAD")).status).toBe(200);
      expect(await (await request("/panels/near/intents/evidence.json")).json()).toEqual({ receipt: "public" });
      expect((await request("/panels/near/intents")).status).toBe(404);
    });

    test("has no directory listing, SPA fallback or private repository routes", async () => {
      for (const path of ["/empty", "/empty/", "/missing", "/missing/", "/README.md", "/package.json", "/src/site/site.ts", "/fixtures/", "/mcp"]) {
        const response = await request(path);
        expect(response.status).toBe(404);
        expect(await response.text()).toBe("");
      }
    });

    test("rejects methods besides GET and HEAD without Allow widening", async () => {
      for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
        for (const path of ["/", "/data.json", "/missing"]) {
          const response = await request(path, method);
          expect(response.status).toBe(405);
          expect(response.headers.get("allow")).toBe("GET, HEAD");
          expect(await response.text()).toBe("");
        }
      }
      expect((await rawRequest("/", "TRACE")).status).toBe(405);
    });

    test("raw HTTP cannot reach outside-root files, encoded separators, dotfiles or malformed escapes", async () => {
      for (const path of [
        "/../outside.txt", "/%2e%2e/outside.txt", "/panels/../../outside.txt", "/panels/%2e%2e/%2e%2e/outside.txt",
        "/%252e%252e/outside.txt", "/%2e%2e%2foutside.txt", "/%2e%2e%5coutside.txt", "/panels%2f..%2fdata.json",
        "/.hidden", "/%2ehidden", "/.private/data.json", "/%2eprivate/data.json", "/.git/config", "/.env",
        "/%00", "/%0a", "/%zz", "/%ff", "//outside.txt", "/empty//index.html",
      ]) {
        const response = await rawRequest(path);
        expect(response.status, path).toBe(404);
        expect(response.text).not.toContain("outside root");
        expect(response.text).not.toContain("must not be served");
      }
    });

    test("rejects file, directory, internal and dangling symlinks on every request", async () => {
      for (const path of ["/outside-link.txt", "/inside-link.json", "/repo-link/package.json", "/repo-link/.git/config", "/dangling.txt"]) {
        expect((await request(path)).status, path).toBe(404);
      }
      const replaced = join(root, "replaced.json");
      await Bun.write(replaced, "public before replacement");
      expect((await request("/replaced.json")).status).toBe(200);
      await rm(replaced);
      await symlink(join(temp, "outside.txt"), replaced);
      expect((await request("/replaced.json")).status).toBe(404);
    });

    test("rejects a root or ancestor replaced with a symlink after startup", async () => {
      const parent = join(temp, "swap-parent");
      await mkdir(join(parent, "site"), { recursive: true });
      await Bun.write(join(parent, "site", "index.html"), "original");
      const handle = await createStaticHandler(join(parent, "site"));
      await rename(parent, `${parent}-old`);
      await symlink(`${parent}-old`, parent);
      expect((await handle(new Request("http://localhost/"))).status).toBe(404);
      await rm(parent);
      await rename(`${parent}-old`, parent);
      await rename(join(parent, "site"), join(parent, "original-site"));
      await symlink(join(parent, "original-site"), join(parent, "site"));
      expect((await handle(new Request("http://localhost/"))).status).toBe(404);
    });

    test("root selection is independent of cwd; public host/port overrides are rejected", async () => {
      expect(STATIC_HOST).toBe("127.0.0.1");
      expect(STATIC_PORT).toBe(8876);
      expect(parseStaticArgs([])).toBe(SITE_ROOT);
      expect(parseStaticArgs(["--root", root])).toBe(root);
      expect(await checkedSiteRoot(root)).toBeTruthy();
      for (const args of [["--host", "0.0.0.0"], ["--port", "80"], ["--root"], ["--root", root, "--root", root], [root]]) {
        expect(() => parseStaticArgs(args)).toThrow();
      }
    });

    test("refuses repo/private roots, whole temp root, files, missing roots and root symlinks", async () => {
      const alias = join(temp, "alias");
      await symlink(root, alias);
      for (const path of [REPO_ROOT, join(REPO_ROOT, "src"), join(REPO_ROOT, "fixtures"), join(REPO_ROOT, "dist/site/../../src"), tmpdir(), "/tmp", "/", alias, join(temp, "absent"), join(root, "data.json")]) {
        await expect(checkedSiteRoot(path)).rejects.toThrow();
      }
    });
  });

  const example = await Bun.file(EXAMPLE_CONFIG).text();
  const parsed = () => structuredClone(Bun.YAML.parse(example)) as { tunnel: string; "credentials-file": string; ingress: Record<string, unknown>[] };

  describe("tunnel preparation, never tunnel activation", () => {
    test("example accepts only selected hostnames and unchanged legacy MCP ingress, denying everything else", () => {
      expect(() => validateTunnelConfig(example)).not.toThrow();
      const rules = parsed().ingress;
      const route = (host: string, path: string) => rules.find(rule =>
        (!rule.hostname || rule.hostname === host) && (!rule.path || new RegExp(String(rule.path)).test(path)))?.service;
      expect(route("linchpin.quantrin.ai", "/")).toBe("http://127.0.0.1:8876");
      expect(route("linchpin.quantrin.ai", "/panels/near/intents/index.html")).toBe("http://127.0.0.1:8876");
      expect(route("mcp.quantrin.ai", "/mcp")).toBe("http://127.0.0.1:8787");
      for (const path of ["/", "/mcp/", "/mcp/anything", "/xmcp"]) expect(route("mcp.quantrin.ai", path)).toBe("http://127.0.0.1:8787");
      expect(route("mcp.linchpin.quantrin.ai", "/mcp")).toBe("http_status:404");
      expect(route("elsewhere.quantrin.ai", "/mcp")).toBe("http_status:404");
      expect(route("", "/")).toBe("http_status:404");
    });

    test("rejects missing, widened, extra or reordered ingress rules and credential values", () => {
      const mutations: ((config: ReturnType<typeof parsed>) => void)[] = [
        c => { c.ingress.pop(); },
        c => { c.ingress[2]!.service = "http://127.0.0.1:8876"; },
        c => { c.ingress[2]!.hostname = "elsewhere.quantrin.ai"; },
        c => { c.ingress[0]!.path = "/mcp"; },
        c => { c.ingress[0]!.path = "^/mcp"; },
        c => { c.ingress[1]!.path = "^/mcp$"; },
        c => { c.ingress[0]!.hostname = "*.quantrin.ai"; },
        c => { c.ingress[1]!.service = "http://0.0.0.0:8876"; },
        c => { c.ingress[1]!.service = "http://192.0.2.1:8787"; },
        c => { c.ingress[0]!.service = "http://127.0.0.1:8876"; },
        c => { c.ingress[0]!.originRequest = { noTLSVerify: true }; },
        c => { c.ingress.unshift({ service: "http://127.0.0.1:8787" }); },
        c => { c.ingress.reverse(); },
        c => { Object.assign(c, { token: "<FORBIDDEN-KEY>" }); },
        c => { c["credentials-file"] = join(REPO_ROOT, "credentials.json"); },
        c => { c["credentials-file"] = "./credentials.json"; },
        c => { c.tunnel = ""; },
      ];
      for (const mutate of mutations) {
        const config = parsed(); mutate(config);
        expect(() => validateTunnelConfig(Bun.YAML.stringify(config))).toThrow();
      }
      for (const text of ["{", "null", "[]", "---\na: b\n---\na: c"]) expect(() => validateTunnelConfig(text)).toThrow();
    });

    test("deferred nested MCP hostname cannot be activated by the checker", () => {
      const config = parsed();
      config.ingress[0]!.hostname = "mcp.linchpin.quantrin.ai";
      expect(() => validateTunnelConfig(Bun.YAML.stringify(config))).toThrow();
      config.ingress[0]!.path = "^/mcp$";
      expect(() => validateTunnelConfig(Bun.YAML.stringify(config))).toThrow();
    });

    test("accepts a named-tunnel UUID without reading the outside credentials file", () => {
      const config = parsed();
      config.tunnel = "00000000-0000-4000-8000-000000000000";
      config["credentials-file"] = join(temp, "operator-only-not-created.json");
      expect(() => validateTunnelConfig(Bun.YAML.stringify(config))).not.toThrow();
    });

    test("preparation check requires a real built index and performs no server start", async () => {
      await expect(checkPreparation(root)).resolves.toBeUndefined();
      await expect(checkPreparation(join(root, "empty"))).rejects.toThrow("index.html");
      await expect(checkPreparation(REPO_ROOT)).rejects.toThrow();
      const badConfig = join(temp, "bad.yml");
      await Bun.write(badConfig, example.replace("http_status:404", "http://127.0.0.1:8876"));
      await expect(checkPreparation(root, badConfig)).rejects.toThrow("catch-all");
    });

    test("test file skips explicitly in a tree without private hosting scripts", async () => {
      const file = join(temp, "published-shape", "tests", "hosting-prep.test.ts");
      await Bun.write(file, await Bun.file(import.meta.filename).text());
      const run = Bun.spawnSync([process.execPath, "--no-env-file", "test", file], { env: {}, timeout: 10000 });
      expect(run.exitCode).toBe(0);
      const output = run.stderr.toString();
      expect(output).toContain("1 skip");
      expect(output).toContain("0 fail");
    }, 30000);
  });
}
