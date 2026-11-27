import { describe, expect, it, vi } from "vitest";
import { staticTokenProvider } from "../src/config.js";
import { CanvasError, redact } from "../src/errors.js";
import { CanvasClient } from "../src/http.js";
import { fakeCanvas, json, ORIGIN, TOKEN } from "./fake-canvas.js";

const mk = (routes: Parameters<typeof fakeCanvas>[0], token: string | null = TOKEN) => {
  const fake = fakeCanvas(routes);
  const sleep = vi.fn(async (_ms: number) => {});
  const client = new CanvasClient({ origin: ORIGIN, tokens: staticTokenProvider(token), fetchImpl: fake.fetchImpl, sleep });
  return { client, sleep, ...fake };
};

async function err(p: Promise<unknown>): Promise<CanvasError> {
  try {
    await p;
  } catch (e) {
    return e as CanvasError;
  }
  throw new Error("expected rejection");
}

describe("pagination", () => {
  const coursesPath = "/api/v1/courses";
  const page = (n: number, next: string | null) => json([{ id: `${n}1` }, { id: `${n}2` }], next ? { link: `<${next}>; rel="next", <${ORIGIN}${coursesPath}?page=1>; rel="first"` } : {});

  it("follows validated Link headers across pages", async () => {
    const { client, calls } = mk({
      [coursesPath]: (u) => {
        const p = u.searchParams.get("page");
        if (!p) return page(1, `${ORIGIN}${coursesPath}?enrollment_type=student&page=bookmark:2&per_page=2`);
        if (p === "bookmark:2") return page(2, `${ORIGIN}${coursesPath}?enrollment_type=student&page=bookmark:3&per_page=2`);
        return page(3, null);
      },
    });
    const r = await client.collect("courses", {}, { per_page: 2 }, { limit: 100 });
    expect(r.items.map((x: any) => x.id)).toEqual(["11", "12", "21", "22", "31", "32"]);
    expect(r.nextCursor).toBeNull();
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.url.searchParams.get("enrollment_type") === "student")).toBe(true);
  });

  it("returns an opaque cursor that resumes on the next page", async () => {
    const { client, calls } = mk({
      [coursesPath]: (u) => (u.searchParams.get("page") ? page(2, null) : page(1, `${ORIGIN}${coursesPath}?enrollment_type=student&page=2&per_page=2`)),
    });
    const first = await client.getPage("courses", {}, { per_page: 2 });
    expect(first.nextCursor).toBeTruthy();
    const second = await client.getPage("courses", {}, {}, first.nextCursor!);
    expect(second.items).toHaveLength(2);
    expect(calls[1].url.searchParams.get("page")).toBe("2");
  });

  it("never skips records when the limit falls mid-page (follows cursors to exhaustion)", async () => {
    // Canvas pages [1,2,3] and [4,5]; request fewer items than the Canvas page size.
    const route = (u: URL) =>
      u.searchParams.get("page") === "2"
        ? json([{ id: "4" }, { id: "5" }])
        : json([{ id: "1" }, { id: "2" }, { id: "3" }], { link: `<${ORIGIN}${coursesPath}?enrollment_type=student&page=2&per_page=3>; rel="next"` });
    for (const limit of [1, 2, 4, 5, 10]) {
      const { client } = mk({ [coursesPath]: route });
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 20; i++) {
        const r = await client.collect<any>("courses", {}, { per_page: 3 }, { limit, cursor });
        seen.push(...r.items.map((x: any) => x.id));
        expect(r.items.length).toBeLessThanOrEqual(limit);
        if (!r.nextCursor) break;
        cursor = r.nextCursor;
      }
      expect(seen, `limit=${limit}`).toEqual(["1", "2", "3", "4", "5"]);
    }
  });

  it("rejects cursors with an invalid mid-page offset", async () => {
    const { client } = mk({});
    for (const bad of [-1, 1.5, 1e9, "3"]) {
      const c = Buffer.from(JSON.stringify({ e: "courses", p: coursesPath, q: "enrollment_type=student", s: bad })).toString("base64url");
      expect((await err(client.getPage("courses", {}, {}, c))).kind).toBe("validation");
    }
  });

  it("rejects off-origin, cross-endpoint, or tampered pagination links", async () => {
    for (const next of [
      "https://evil.example.com/api/v1/courses?page=2",
      `http://canvas.example.edu${coursesPath}?page=2`,
      `${ORIGIN}/api/v1/users/self/profile?page=2`,
      `${ORIGIN}${coursesPath}?page=2&as_user_id=7`,
    ]) {
      const { client } = mk({ [coursesPath]: () => page(1, next) });
      const e = await err(client.getPage("courses", {}, {}));
      expect(e.kind).toBe("security");
    }
  });

  it("rejects a forged cursor for a different endpoint or with forbidden params", async () => {
    const { client } = mk({});
    const forged = Buffer.from(JSON.stringify({ e: "my_submissions", p: "/api/v1/courses/1/students/submissions", q: "student_ids[]=42" })).toString("base64url");
    expect((await err(client.getPage("my_submissions", { course_id: "1" }, {}, forged))).kind).toBe("security");
    expect((await err(client.getPage("courses", {}, {}, forged))).kind).toBe("validation");
    expect((await err(client.getPage("courses", {}, {}, "not-a-cursor"))).kind).toBe("validation");
  });
});

describe("credentials and errors", () => {
  it("sends Bearer only to the configured origin and requests string IDs", async () => {
    const { client, calls } = mk({ "/api/v1/users/self/profile": () => json({ id: "1" }) });
    await client.get("profile");
    expect(calls[0].url.origin).toBe(ORIGIN);
    expect(calls[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0].headers.accept).toContain("canvas-string-ids");
    expect(calls[0].redirect).toBe("manual");
  });

  it("reports a missing token clearly, without calling Canvas", async () => {
    const { client, calls } = mk({}, null);
    const e = await err(client.get("profile"));
    expect(e.kind).toBe("config");
    expect(e.message).toMatch(/token:setup/);
    expect(calls).toHaveLength(0);
  });

  it("maps 401 invalid token vs 401 not-authorized vs 403 vs 404", async () => {
    const cases: Array<[Response, string]> = [
      [json({ errors: [{ message: "Invalid access token." }] }, { status: 401 }), "auth"],
      [json({ status: "unauthorized", errors: [{ message: "user not authorized to perform that action" }] }, { status: 401 }), "permission"],
      [json({ errors: [{ message: "forbidden" }] }, { status: 403 }), "permission"],
      [json({ errors: [{ message: "The specified resource does not exist." }] }, { status: 404 }), "not_found"],
    ];
    for (const [res, kind] of cases) {
      const { client } = mk({ "/api/v1/users/self/profile": () => res.clone() });
      const e = await err(client.get("profile"));
      expect(e.kind).toBe(kind);
      expect(e.message).not.toContain(TOKEN);
    }
    const { client } = mk({ "/api/v1/users/self/profile": () => json({}, { status: 401 }) });
    expect((await err(client.get("profile"))).message).toMatch(/expired/);
  });

  it("never echoes the token even if Canvas reflects it", async () => {
    const { client } = mk({ "/api/v1/users/self/profile": () => json({ errors: [{ message: `bad Bearer ${TOKEN}` }] }, { status: 400 }) });
    const e = await err(client.get("profile"));
    expect(e.message).not.toContain(TOKEN);
    expect(redact(`x ${TOKEN} y`)).toBe("x [REDACTED] y");
  });

  it("does not follow redirects from API endpoints", async () => {
    const { client, calls } = mk({ "/api/v1/users/self/profile": () => new Response(null, { status: 302, headers: { location: "https://evil.example.com/steal" } }) });
    expect((await err(client.get("profile"))).kind).toBe("security");
    expect(calls).toHaveLength(1);
  });
});

describe("retries and rate limits", () => {
  it("retries Canvas 403 Rate Limit Exceeded, honoring backoff", async () => {
    const { client, sleep, calls } = mk({
      "/api/v1/users/self/profile": (_u, n) => (n < 3 ? new Response("403 Forbidden (Rate Limit Exceeded)", { status: 403, headers: { "x-rate-limit-remaining": "0" } }) : json({ id: "1" })),
    });
    expect(await client.get("profile")).toEqual({ id: "1" });
    expect(calls).toHaveLength(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("honors Retry-After on 429 and gives up after bounded retries", async () => {
    const { client, sleep, calls } = mk({ "/api/v1/users/self/profile": () => new Response("slow down", { status: 429, headers: { "retry-after": "2" } }) });
    const e = await err(client.get("profile"));
    expect(e.kind).toBe("rate_limited");
    expect(calls).toHaveLength(4); // 1 + 3 retries
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it("retries 503 and network timeouts, then fails with a clear error", async () => {
    const { client } = mk({ "/api/v1/users/self/profile": (_u, n) => (n === 1 ? new Response("", { status: 503 }) : json({ id: "1" })) });
    expect(await client.get("profile")).toEqual({ id: "1" });

    const sleep = vi.fn(async () => {});
    const timeouts = new CanvasClient({
      origin: ORIGIN,
      tokens: staticTokenProvider(TOKEN),
      sleep,
      fetchImpl: async () => {
        throw Object.assign(new Error("t"), { name: "TimeoutError" });
      },
    });
    const e = await err(timeouts.get("profile"));
    expect(e.kind).toBe("timeout");
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it("does not retry a plain permission 403", async () => {
    const { client, calls } = mk({ "/api/v1/users/self/profile": () => json({ errors: [{ message: "nope" }] }, { status: 403 }) });
    expect((await err(client.get("profile"))).kind).toBe("permission");
    expect(calls).toHaveLength(1);
  });
});

describe("file downloads", () => {
  const dl = `${ORIGIN}/files/77/download?download_frd=1&verifier=SECRETVERIFIER&evil=1`;

  it("follows an allowlisted off-origin redirect without forwarding the token", async () => {
    const { client, calls } = mk({
      "/files/77/download": () => new Response(null, { status: 302, headers: { location: "https://inst-fs-iad-prod.inscloudgate.net/files/abc?token=signed" } }),
      "inst-fs-iad-prod.inscloudgate.net/files/abc": () => new Response("hello file", { status: 200, headers: { "content-type": "text/plain" } }),
    });
    const r = await client.downloadFile(dl, 1024);
    expect(r.data.toString()).toBe("hello file");
    expect(calls[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0].url.searchParams.get("preview")).toBe("1");
    expect(calls[0].url.searchParams.get("verifier")).toBe("SECRETVERIFIER");
    expect(calls[0].url.searchParams.has("evil")).toBe(false);
    expect(calls[1].url.host).toBe("inst-fs-iad-prod.inscloudgate.net");
    expect(calls[1].headers.authorization).toBeUndefined();
  });

  it("re-applies preview=1 (and strips extra params) on same-origin download redirects", async () => {
    const { client, calls } = mk({
      "/files/77/download": () => new Response(null, { status: 302, headers: { location: "/courses/5/files/77/download?download_frd=1&verifier=V2&other=x" } }),
      "/courses/5/files/77/download": () => new Response(null, { status: 302, headers: { location: "https://x.inscloudgate.net/blob?sig=abc" } }),
      "x.inscloudgate.net/blob": () => new Response("bytes", { status: 200 }),
    });
    const r = await client.downloadFile(dl, 1024);
    expect(r.data.toString()).toBe("bytes");
    const hop2 = calls[1];
    expect(hop2.url.pathname).toBe("/courses/5/files/77/download");
    expect(hop2.url.searchParams.get("preview")).toBe("1");
    expect(hop2.url.searchParams.get("verifier")).toBe("V2");
    expect(hop2.url.searchParams.has("other")).toBe(false);
    expect(hop2.headers.authorization).toBe(`Bearer ${TOKEN}`);
    // Off-origin storage keeps its own signed query and never gets the token.
    expect(calls[2].url.searchParams.get("sig")).toBe("abc");
    expect(calls[2].url.searchParams.has("preview")).toBe(false);
    expect(calls[2].headers.authorization).toBeUndefined();
    expect(calls.filter((c) => c.url.origin === ORIGIN).every((c) => c.url.searchParams.get("preview") === "1")).toBe(true);
  });

  it("refuses redirects to non-allowlisted hosts, http, or back to Canvas after leaving", async () => {
    for (const location of ["https://evil.example.com/x", "http://inst-fs-iad-prod.inscloudgate.net/x"]) {
      const { client, calls } = mk({ "/files/77/download": () => new Response(null, { status: 302, headers: { location } }) });
      expect((await err(client.downloadFile(dl, 1024))).kind).toBe("security");
      expect(calls).toHaveLength(1);
    }
    const { client, calls } = mk({
      "/files/77/download": () => new Response(null, { status: 302, headers: { location: "https://x.inscloudgate.net/a" } }),
      "x.inscloudgate.net/a": () => new Response(null, { status: 302, headers: { location: `${ORIGIN}/files/77/download` } }),
    });
    expect((await err(client.downloadFile(dl, 1024))).kind).toBe("security");
    expect(calls.filter((c) => c.headers.authorization)).toHaveLength(1);
  });

  it("only accepts Canvas file download paths on the configured origin", async () => {
    const { client, calls } = mk({});
    for (const u of ["https://evil.example.com/files/1/download", `${ORIGIN}/api/v1/courses`, `${ORIGIN}/files/1/../../login`]) {
      expect((await err(client.downloadFile(u, 1024))).kind).toBe("security");
    }
    expect(calls).toHaveLength(0);
  });

  it("enforces the byte limit", async () => {
    const { client } = mk({ "/files/77/download": () => new Response("x".repeat(5000), { status: 200 }) });
    expect((await err(client.downloadFile(dl, 100))).kind).toBe("too_large");
  });
});
