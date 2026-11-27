/** Synthetic Canvas: a fetch implementation that routes by method+path and records every request. */
export const ORIGIN = "https://canvas.example.edu";
export const TOKEN = "1234~SYNTHETICtokenSYNTHETICtokenSYNTHETICtoken0000";

export interface Recorded { url: URL; headers: Record<string, string>; method: string; redirect?: RequestRedirect }
export type Handler = (url: URL, call: number) => Response | Promise<Response>;

export function json(body: unknown, init: ResponseInit & { link?: string } = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (init.link) headers.set("link", init.link);
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
}

export function fakeCanvas(routes: Record<string, Handler>) {
  const calls: Recorded[] = [];
  const counts = new Map<string, number>();
  const fetchImpl = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k.toLowerCase()] = v));
    calls.push({ url, headers, method: init?.method ?? "GET", redirect: init?.redirect });
    const key = url.host === new URL(ORIGIN).host ? url.pathname : `${url.host}${url.pathname}`;
    const h = routes[key];
    if (!h) return json({ errors: [{ message: `no fake route for ${key}` }] }, { status: 404 });
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    return h(url, n);
  };
  return { fetchImpl, calls };
}
