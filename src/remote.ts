/**
 * One page over several machines. Every instance provides the bus capability `ops`
 * (`POST /api/remote`): a request for one of its own page routes, sent by the same app on another
 * space through ai-space's bus. The instance whose ai-space has peers running this app lists them
 * (`GET /api/machines`) and forwards the page's requests for them (`/api/m/<peer>/<route>`) as
 * `POST /api/call/<peer>/<app>/ops`. Each machine's jobs stay on that machine and run there; the
 * write is made by that machine's instance with that machine's credential.
 */

export const CAPABILITY = "ops";

type Method = "GET" | "POST" | "PATCH";

/** The page routes a remote request may reach: the page's own, nothing else. */
const ROUTES: [Method[], RegExp][] = [
  [["GET"], /^\/api\/meta$/],
  [["GET"], /^\/api\/overview$/],
  [["GET"], /^\/api\/rows\/[^/]+\/runs$/],
  [["GET", "POST"], /^\/api\/jobs$/],
  [["GET", "PATCH"], /^\/api\/jobs\/\d+$/],
  [["POST"], /^\/api\/jobs\/\d+\/(pause|resume|run|archive|restore)$/],
  [["POST"], /^\/api\/reconcile$/],
  [["POST"], /^\/api\/schedule\/preview$/],
  [["GET", "POST"], /^\/api\/assistant$/],
  [["POST"], /^\/api\/assistant\/(new|confirm)$/],
];

export interface RemoteRequest { method: Method; path: string; body?: unknown }

/** The request in a call's body, or null when it names no allowed route. `path` keeps its query. */
export function readRemote(v: unknown): RemoteRequest | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const method = typeof o.method === "string" ? o.method.toUpperCase() : "";
  const path = typeof o.path === "string" ? o.path : "";
  if (!path.startsWith("/api/") || path.includes("..") || path.includes("\\")) return null;
  let pathname: string;
  try { pathname = new URL(path, "http://x").pathname; } catch { return null; }
  if (!ROUTES.some(([methods, re]) => (methods as string[]).includes(method) && re.test(pathname))) return null;
  return { method: method as Method, path, ...(o.body !== undefined ? { body: o.body } : {}) };
}

/** Only this app calls `ops`: here (`task-shelf`) or on a hub (`<hub>/task-shelf`). */
export function callerAllowed(caller: string | null, app: string): boolean {
  return Boolean(caller) && (caller === app || caller!.endsWith(`/${app}`));
}

export interface Machines {
  /** This machine's SPACE_NAME. */
  local: string;
  /** Peers of this space whose ai-space lists this app's `ops`: the names to call them by. */
  peers: string[];
  error: string | null;
}

/** A peer's app appears as `<peer>/<app>` with `peer` set. */
type CapabilityList = { apps?: { app?: string; peer?: string; provides?: unknown }[] };

const provides = (p: unknown, name: string): boolean =>
  Array.isArray(p) ? p.some((x) => (typeof x === "string" ? x : (x as { name?: string })?.name) === name) : Boolean(p && typeof p === "object" && name in (p as object));

/** The peers running this app, read from ai-space's catalogue; kept for 30 s. */
export function machineFinder(o: { apiUrl: string; app: string; local: string; token: string; fetch?: typeof fetch; now?: () => number }) {
  const f = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  let cache: { at: number; value: Machines } | null = null;
  return async (): Promise<Machines> => {
    if (cache && now() - cache.at < 30_000) return cache.value;
    let value: Machines;
    try {
      const res = await f(`${o.apiUrl}/api/capabilities`, { headers: o.token ? { authorization: `Bearer ${o.token}` } : {}, signal: AbortSignal.timeout(8_000) });
      if (!res.ok) throw new Error(`ai-space answered HTTP ${res.status}`);
      const d = (await res.json()) as CapabilityList;
      const peers = [...new Set((d.apps ?? []).filter((a) => a.peer && (a.app === o.app || a.app === `${a.peer}/${o.app}`) && provides(a.provides, CAPABILITY)).map((a) => a.peer!))].sort();
      value = { local: o.local, peers, error: null };
    } catch (e) {
      // Keep the last good list through a short outage; the local machine always works.
      value = cache?.value ?? { local: o.local, peers: [], error: (e as Error).message };
    }
    cache = { at: now(), value };
    return value;
  };
}

/** Forward one page request to a peer's instance through ai-space's bus; the answer comes back as is. */
export function forwarder(o: { apiUrl: string; app: string; token: string; fetch?: typeof fetch }) {
  const f = o.fetch ?? fetch;
  return async (peer: string, req: RemoteRequest): Promise<Response> => {
    let res: Response;
    try {
      res = await f(`${o.apiUrl}/api/call/${encodeURIComponent(peer)}/${encodeURIComponent(o.app)}/${CAPABILITY}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(o.token ? { authorization: `Bearer ${o.token}` } : {}) },
        body: JSON.stringify(req),
        signal: AbortSignal.timeout(170_000),
      });
    } catch (e) {
      return Response.json({ ok: false, code: "peer-unreachable", error: `${peer}: ${(e as Error).message}` }, { status: 502 });
    }
    const text = await res.text();
    // An answer from the peer's instance is JSON with `ok`; anything else came from a bus on the way.
    let parsed: { ok?: unknown; error?: unknown } | null = null;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    if (parsed && typeof parsed === "object" && "ok" in parsed) {
      return new Response(text, { status: res.status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
    }
    const error = parsed && typeof parsed.error === "string" ? parsed.error : text.slice(0, 300) || `HTTP ${res.status}`;
    return Response.json({ ok: false, code: "peer-unreachable", error: `${peer}: ${error}` }, { status: res.ok ? 502 : res.status });
  };
}
