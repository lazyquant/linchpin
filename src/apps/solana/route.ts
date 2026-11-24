/** The address fragment as a route, and back. A position is named by its place in the list, never by its id. */
import { PREFIX, TABS, type TabId } from "./model";

export type ReadSource = "recorded" | "constructed" | "live";
export type Route =
  | { view: "protocols" }
  | { view: "protocol"; pack: string; series: string | null; tab: TabId; focus: string | null }
  | { view: "positions"; read: ReadSource | null; ordinal: number | null }
  | { view: "ask" }
  | { view: "preflight" }
  | { view: "token"; token: string }
  | { view: "not-found" };

const READS: readonly string[] = ["recorded", "constructed", "live"];
const SEGMENT = /^[A-Za-z0-9._-]+$/;

function decode(text: string): string | null {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

export function parseRoute(hash: string): Route {
  const token = /^#token=([0-9a-f]{64})$/.exec(hash);
  if (token) return { view: "token", token: token[1] };
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (raw === "" || raw === "/") return { view: "protocols" };
  const [path, query = ""] = raw.split("?");
  const parts = path.split("/");
  if (parts[0] !== "" || parts.slice(1).some((part) => !SEGMENT.test(part))) return { view: "not-found" };
  const [, head, a, b, c, ...rest] = parts;
  if (rest.length > 0) return { view: "not-found" };
  if (head === "protocols") {
    if (a === undefined) return { view: "protocols" };
    const tab = c === undefined ? "overview" : (TABS as readonly string[]).includes(c) ? (c as TabId) : null;
    if (tab === null) return { view: "not-found" };
    let focus: string | null = null;
    const match = /^focus=([^&]+)$/.exec(query);
    if (match && tab === "dependencies") {
      const account = decode(match[1]);
      if (account === null || account === "") return { view: "not-found" };
      focus = account.includes(":") ? account : `${PREFIX}${account}`;
    } else if (query !== "") return { view: "not-found" };
    return { view: "protocol", pack: a, series: b ?? null, tab, focus };
  }
  if (query !== "") return { view: "not-found" };
  if (head === "positions") {
    if (c !== undefined) return { view: "not-found" };
    if (a === undefined) return { view: "positions", read: null, ordinal: null };
    if (!READS.includes(a)) return { view: "not-found" };
    if (b === undefined) return { view: "positions", read: a as ReadSource, ordinal: null };
    if (!/^[1-9][0-9]{0,3}$/.test(b)) return { view: "not-found" };
    return { view: "positions", read: a as ReadSource, ordinal: Number(b) };
  }
  if (a !== undefined) return { view: "not-found" };
  if (head === "ask") return { view: "ask" };
  if (head === "preflight") return { view: "preflight" };
  return { view: "not-found" };
}

export function formatRoute(route: Route): string {
  switch (route.view) {
    case "protocols": return "#/protocols";
    case "protocol": {
      if (route.series === null) return `#/protocols/${route.pack}`;
      const base = `#/protocols/${route.pack}/${route.series}/${route.tab}`;
      if (route.tab !== "dependencies" || route.focus === null) return base;
      return `${base}?focus=${encodeURIComponent(route.focus.startsWith(PREFIX) ? route.focus.slice(PREFIX.length) : route.focus)}`;
    }
    case "positions": return route.read === null ? "#/positions" : route.ordinal === null ? `#/positions/${route.read}` : `#/positions/${route.read}/${route.ordinal}`;
    case "ask": return "#/ask";
    case "preflight": return "#/preflight";
    case "token": return `#token=${route.token}`;
    default: return "#/not-found";
  }
}
