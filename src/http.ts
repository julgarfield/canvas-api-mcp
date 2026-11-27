import { DEFAULT_DOWNLOAD_HOST_PATTERNS, DEFAULT_DOWNLOAD_HOST_SUFFIXES, type TokenProvider } from "./config.js";
import { CanvasError, invalidTokenMessage, redact } from "./errors.js";
import {
  buildPath,
  buildQuery,
  ENDPOINTS,
  validateReturnedQuery,
  type EndpointId,
  type QueryInput,
} from "./endpoints.js";

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface ClientOptions {
  origin: string;
  tokens: TokenProvider;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  downloadTimeoutMs?: number;
  maxRetries?: number;
  extraDownloadHostSuffixes?: string[];
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Internal page result that also knows how to re-request itself (for mid-page resume). */
interface PageWithSelf<T> extends Page<T> {
  self: CursorPayload;
}

/** Paths on the Canvas origin that may serve file bytes. */
const DOWNLOAD_PATH_RE = /^\/(?:(?:courses|users|groups)\/\d{1,20}\/)?files\/\d{1,20}\/(?:download|preview)$/;
const DOWNLOAD_QUERY_KEYS = new Set(["verifier", "download_frd", "wrap"]);
const MAX_REDIRECTS = 5;
const MAX_RETRY_AFTER_MS = 30_000;

interface CursorPayload {
  e: string; // endpoint id
  p: string; // expected pathname
  q: string; // validated query string for the Canvas page to request
  s?: number; // items of that page already returned (mid-page resume)
}
const MAX_CURSOR_SKIP = 10_000;

function encodeCursor(c: CursorPayload): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}
function decodeCursor(s: string): CursorPayload {
  try {
    if (s.length > 4096) throw new Error();
    const c = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
    if (typeof c?.e !== "string" || typeof c?.p !== "string" || typeof c?.q !== "string") throw new Error();
    if (c.s !== undefined && !(Number.isInteger(c.s) && c.s >= 0 && c.s <= MAX_CURSOR_SKIP)) throw new Error();
    return c;
  } catch {
    throw new CanvasError("validation", "Invalid pagination cursor.");
  }
}

export function parseNextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const m = /<([^>]+)>\s*;\s*(.*)$/.exec(part.trim());
    if (m && /rel="?next"?/.test(m[2])) return m[1];
  }
  return null;
}

async function canvasMessage(res: Response): Promise<string> {
  try {
    const text = (await res.text()).slice(0, 4000);
    try {
      const j = JSON.parse(text);
      const msgs: string[] = [];
      if (Array.isArray(j?.errors)) for (const e of j.errors) if (typeof e?.message === "string") msgs.push(e.message);
      if (j?.errors && typeof j.errors === "object" && !Array.isArray(j.errors)) msgs.push(JSON.stringify(j.errors));
      if (typeof j?.message === "string") msgs.push(j.message);
      if (msgs.length) return redact(msgs.join("; ")).slice(0, 300);
    } catch {
      /* not JSON */
    }
    return redact(text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()).slice(0, 300);
  } catch {
    return "";
  }
}

export class CanvasClient {
  readonly origin: string;
  private readonly tokens: TokenProvider;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly downloadTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly downloadSuffixes: string[];

  constructor(opts: ClientOptions) {
    this.origin = new URL(opts.origin).origin;
    if (!this.origin.startsWith("https://")) throw new CanvasError("config", "Canvas origin must be https.");
    this.tokens = opts.tokens;
    this.fetchImpl = opts.fetchImpl ?? ((i, init) => fetch(i, init));
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.downloadTimeoutMs = opts.downloadTimeoutMs ?? 60_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.downloadSuffixes = [...DEFAULT_DOWNLOAD_HOST_SUFFIXES, ...(opts.extraDownloadHostSuffixes ?? [])];
  }

  /** True iff the host is an allowed off-origin file-content host. */
  isAllowedDownloadHost(host: string): boolean {
    const h = host.toLowerCase();
    if (this.downloadSuffixes.some((s) => h === s || h.endsWith("." + s))) return true;
    return DEFAULT_DOWNLOAD_HOST_PATTERNS.some((re) => re.test(h));
  }

  // ---------------------------------------------------------------- core

  /**
   * Perform a single GET. The bearer token is attached ONLY when the URL is
   * on the configured https origin and `auth` is requested. Redirects are
   * never followed automatically.
   */
  private async rawGet(url: URL, auth: boolean, timeoutMs: number): Promise<Response> {
    const headers: Record<string, string> = { Accept: "application/json+canvas-string-ids, application/json;q=0.9, */*;q=0.1" };
    if (auth) {
      if (url.protocol !== "https:" || url.origin !== this.origin) {
        throw new CanvasError("security", "Refusing to send Canvas credentials to a host other than the configured Canvas origin.");
      }
      headers.Authorization = `Bearer ${await this.tokens.getToken()}`;
    }
    try {
      return await this.fetchImpl(url.toString(), {
        method: "GET",
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const name = (err as { name?: string })?.name;
      if (name === "TimeoutError" || name === "AbortError") throw new CanvasError("timeout", `Request to ${url.host} timed out.`);
      throw new CanvasError("network", `Network error contacting ${url.host}.`);
    }
  }

  private retryDelay(res: Response | null, attempt: number): number {
    const ra = res?.headers.get("retry-after");
    if (ra) {
      const secs = Number(ra);
      if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, MAX_RETRY_AFTER_MS);
      const at = Date.parse(ra);
      if (!Number.isNaN(at)) return Math.min(Math.max(at - Date.now(), 0), MAX_RETRY_AFTER_MS);
    }
    return Math.min(500 * 2 ** attempt + Math.floor(Math.random() * 250), 8_000);
  }

  /** GET with bounded retries for transient failures and rate limiting. */
  private async getWithRetry(url: URL, auth: boolean, timeoutMs: number): Promise<Response> {
    let lastErr: CanvasError | null = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let res: Response | null = null;
      try {
        res = await this.rawGet(url, auth, timeoutMs);
      } catch (err) {
        if (err instanceof CanvasError && (err.kind === "timeout" || err.kind === "network")) {
          lastErr = err;
          if (attempt < this.maxRetries) {
            await this.sleep(this.retryDelay(null, attempt));
            continue;
          }
          throw err;
        }
        throw err;
      }
      if (res.status === 429 || res.status === 403) {
        const remaining = res.headers.get("x-rate-limit-remaining");
        let rateLimited = res.status === 429;
        let body = "";
        if (!rateLimited) {
          body = await res.clone().text().catch(() => "");
          rateLimited = /rate limit exceeded/i.test(body) || (remaining !== null && Number(remaining) <= 0);
        }
        if (rateLimited) {
          lastErr = new CanvasError("rate_limited", "Canvas rate limit exceeded; retries exhausted. Wait a minute and try again.", res.status);
          if (attempt < this.maxRetries) {
            await this.sleep(this.retryDelay(res, attempt));
            continue;
          }
          throw lastErr;
        }
      }
      if ([502, 503, 504].includes(res.status)) {
        lastErr = new CanvasError("http", `Canvas is temporarily unavailable (HTTP ${res.status}).`, res.status);
        if (attempt < this.maxRetries) {
          await this.sleep(this.retryDelay(res, attempt));
          continue;
        }
        throw lastErr;
      }
      return res;
    }
    throw lastErr ?? new CanvasError("http", "Request failed.");
  }

  private async throwForStatus(res: Response): Promise<never> {
    const msg = await canvasMessage(res);
    const detail = msg ? ` Canvas said: "${msg}"` : "";
    if (res.status === 401) {
      // Canvas uses 401 both for bad tokens and for "user not authorized to perform that action".
      if (/not authorized to perform/i.test(msg)) {
        throw new CanvasError(
          "permission",
          "Canvas says your account is not authorized for this resource (it may be hidden, unpublished, or restricted by the instructor or UW–Madison)." + detail,
          401,
        );
      }
      throw new CanvasError("auth", invalidTokenMessage, 401);
    }
    if (res.status === 403) {
      throw new CanvasError(
        "permission",
        "Canvas denied access (403). This content may be restricted by the instructor, course settings, the course having concluded, or school policy." + detail,
        403,
      );
    }
    if (res.status === 404) {
      throw new CanvasError("not_found", "Not found, or not visible to your account (unpublished, deleted, or in a course you can no longer access).", 404);
    }
    throw new CanvasError("http", `Canvas returned HTTP ${res.status}.` + detail, res.status);
  }

  private async apiRequest(url: URL): Promise<Response> {
    const res = await this.getWithRetry(url, true, this.timeoutMs);
    if (res.status >= 300 && res.status < 400) {
      // API endpoints in the allowlist do not redirect; never follow blindly.
      throw new CanvasError("security", `Canvas returned an unexpected redirect (HTTP ${res.status}); it was not followed.`);
    }
    if (!res.ok) await this.throwForStatus(res);
    return res;
  }

  private async json(res: Response): Promise<unknown> {
    const text = await res.text();
    // Canvas may prefix JSON with `while(1);` as CSRF protection.
    const body = text.startsWith("while(1);") ? text.slice(9) : text;
    try {
      return JSON.parse(body);
    } catch {
      throw new CanvasError("http", "Canvas returned a non-JSON response.");
    }
  }

  // ---------------------------------------------------------------- API

  private endpointUrl(id: EndpointId, pathParams: Record<string, string>, query: URLSearchParams): URL {
    const url = new URL(buildPath(id, pathParams), this.origin);
    url.search = query.toString();
    return url;
  }

  /** GET a single (non-paginated) allowlisted endpoint. */
  async get<T = unknown>(id: EndpointId, pathParams: Record<string, string> = {}, query: QueryInput = {}): Promise<T> {
    const url = this.endpointUrl(id, pathParams, buildQuery(id, query));
    return (await this.json(await this.apiRequest(url))) as T;
  }

  /**
   * GET one page of a paginated allowlisted endpoint. If `cursor` is given it
   * must have been produced by this server for the same endpoint and path; it
   * is re-validated (origin, path, and every query parameter).
   */
  async getPage<T = unknown>(
    id: EndpointId,
    pathParams: Record<string, string> = {},
    query: QueryInput = {},
    cursor?: string,
  ): Promise<Page<T>> {
    const { items, nextCursor } = await this.getPageWithSelf<T>(id, pathParams, query, cursor);
    return { items, nextCursor };
  }

  private async getPageWithSelf<T>(
    id: EndpointId,
    pathParams: Record<string, string>,
    query: QueryInput,
    cursor?: string,
  ): Promise<PageWithSelf<T>> {
    const def = ENDPOINTS[id];
    if (!def.paginated) throw new CanvasError("validation", "Endpoint is not paginated.");
    const expectedPath = buildPath(id, pathParams);
    let url: URL;
    let skip = 0;
    if (cursor) {
      const c = decodeCursor(cursor);
      if (c.e !== id || c.p !== expectedPath) throw new CanvasError("validation", "Pagination cursor does not belong to this request.");
      url = new URL(expectedPath, this.origin);
      url.search = validateReturnedQuery(id, new URLSearchParams(c.q)).toString();
      skip = c.s ?? 0;
    } else {
      url = this.endpointUrl(id, pathParams, buildQuery(id, query));
    }
    const res = await this.apiRequest(url);
    const data = await this.json(res);
    if (!Array.isArray(data)) throw new CanvasError("http", "Canvas returned an unexpected (non-list) response.");
    const nextCursor = this.nextCursor(id, expectedPath, res.headers.get("link"));
    // A resumed page whose remaining items are all consumed continues with the next page.
    return {
      items: (data as T[]).slice(skip),
      nextCursor,
      self: { e: id, p: expectedPath, q: url.searchParams.toString(), s: skip },
    };
  }

  /** Validate a Link: rel=next URL from Canvas and convert it to an opaque cursor. */
  private nextCursor(id: EndpointId, expectedPath: string, linkHeader: string | null): string | null {
    const next = parseNextLink(linkHeader);
    if (!next) return null;
    let u: URL;
    try {
      u = new URL(next, this.origin);
    } catch {
      throw new CanvasError("security", "Rejected malformed pagination link from Canvas.");
    }
    if (u.protocol !== "https:" || u.origin !== this.origin) {
      throw new CanvasError("security", "Rejected pagination link pointing outside the configured Canvas origin.");
    }
    if (u.pathname !== expectedPath) {
      throw new CanvasError("security", "Rejected pagination link pointing to a different endpoint.");
    }
    const q = validateReturnedQuery(id, u.searchParams);
    return encodeCursor({ e: id, p: expectedPath, q: q.toString() });
  }

  /**
   * Follow pagination up to `limit` items. If the limit falls inside a Canvas
   * page, the returned cursor resumes at the first unreturned item of that
   * page (so no record is skipped); otherwise it points at the next page.
   */
  async collect<T = unknown>(
    id: EndpointId,
    pathParams: Record<string, string>,
    query: QueryInput,
    opts: { limit: number; cursor?: string; maxPages?: number },
  ): Promise<Page<T>> {
    const items: T[] = [];
    const maxPages = opts.maxPages ?? 20;
    let cursor: string | undefined = opts.cursor;
    for (let pages = 1; ; pages++) {
      const page = await this.getPageWithSelf<T>(id, pathParams, query, cursor);
      const room = opts.limit - items.length;
      if (page.items.length > room) {
        items.push(...page.items.slice(0, room));
        return { items, nextCursor: encodeCursor({ ...page.self, s: (page.self.s ?? 0) + room }) };
      }
      items.push(...page.items);
      cursor = page.nextCursor ?? undefined;
      if (!cursor || items.length >= opts.limit || pages >= maxPages) break;
    }
    return { items, nextCursor: cursor ?? null };
  }

  // ---------------------------------------------------------------- downloads

  /**
   * Download file bytes for a Canvas file. `downloadUrl` must be the `url`
   * field Canvas returned for the file (on the configured origin, a
   * /files/:id/download path). Off-origin redirects are followed only to
   * allowlisted Instructure file-storage hosts and never carry the token.
   */
  async downloadFile(downloadUrl: string, maxBytes: number): Promise<{ data: Buffer; contentType: string | null }> {
    let url: URL;
    try {
      url = new URL(downloadUrl, this.origin);
    } catch {
      throw new CanvasError("security", "Invalid file download URL.");
    }
    if (url.protocol !== "https:" || url.origin !== this.origin || !DOWNLOAD_PATH_RE.test(url.pathname)) {
      throw new CanvasError("security", "File download URL is not an allowed Canvas file path.");
    }
    safeDownloadQuery(url);

    let leftOrigin = false;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const onOrigin = url.origin === this.origin && !leftOrigin;
      const res = await this.getWithRetry(url, onOrigin, this.downloadTimeoutMs);
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        await res.body?.cancel().catch(() => {});
        if (!loc) throw new CanvasError("http", "Download redirect without a location.");
        let next: URL;
        try {
          next = new URL(loc, url);
        } catch {
          throw new CanvasError("security", "Malformed download redirect.");
        }
        if (next.protocol !== "https:") throw new CanvasError("security", "Refused non-HTTPS download redirect.");
        if (next.username || next.password) throw new CanvasError("security", "Refused download redirect containing credentials.");
        if (next.origin === this.origin) {
          if (leftOrigin || !DOWNLOAD_PATH_RE.test(next.pathname)) {
            throw new CanvasError("security", "Refused unexpected download redirect within Canvas.");
          }
          // A Canvas-origin redirect may drop preview=1; re-apply the safe query on every hop.
          safeDownloadQuery(next);
        } else if (this.isAllowedDownloadHost(next.hostname)) {
          leftOrigin = true; // never send the token again for this download
        } else {
          throw new CanvasError("security", `Refused download redirect to non-allowlisted host ${next.hostname}.`);
        }
        url = next;
        continue;
      }
      if (!res.ok) {
        if (onOrigin) await this.throwForStatus(res);
        throw new CanvasError("http", `File storage returned HTTP ${res.status}.`, res.status);
      }
      const len = Number(res.headers.get("content-length") ?? "NaN");
      if (Number.isFinite(len) && len > maxBytes) {
        await res.body?.cancel().catch(() => {});
        throw new CanvasError("too_large", `File is ${len} bytes, over the ${maxBytes}-byte limit.`);
      }
      const data = await readCapped(res, maxBytes);
      return { data, contentType: res.headers.get("content-type") };
    }
    throw new CanvasError("security", "Too many download redirects.");
  }
}

/**
 * Keep only documented download parameters and force preview=1, which (per
 * canvas-lms files_controller#send_stored_file) suppresses module-progress
 * recording and access logging. Applied to every Canvas-origin download hop.
 */
function safeDownloadQuery(url: URL): void {
  const clean = new URLSearchParams();
  for (const [k, v] of url.searchParams) if (DOWNLOAD_QUERY_KEYS.has(k)) clean.append(k, v);
  clean.set("preview", "1");
  url.search = clean.toString();
}

async function readCapped(res: Response, maxBytes: number): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new CanvasError("too_large", `File exceeds the ${maxBytes}-byte limit.`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
