import { describe, expect, it } from "vitest";
import { buildPath, buildQuery, ENDPOINTS, validateReturnedQuery } from "../src/endpoints.js";

describe("endpoint allowlist", () => {
  it("only declares GET-style read paths under /api/v1", () => {
    for (const d of Object.values(ENDPOINTS)) expect(d.path.startsWith("/api/v1/")).toBe(true);
  });

  it("rejects non-numeric and traversal path params", () => {
    expect(() => buildPath("course", { course_id: "../users/1" })).toThrow(/Invalid course_id/);
    expect(() => buildPath("course", { course_id: "12a" })).toThrow();
    expect(() => buildPath("page", { course_id: "1", page_url: "../../x" })).toThrow();
    expect(buildPath("page", { course_id: "1", page_url: "week-1-notes" })).toBe("/api/v1/courses/1/pages/week-1-notes");
    expect(buildPath("page", { course_id: "1", page_url: "page_id:55" })).toBe("/api/v1/courses/1/pages/page_id%3A55");
  });

  it("rejects undeclared query params, including read_state includes", () => {
    expect(() => buildQuery("my_submissions", { include: ["read_state"] })).toThrow();
    expect(() => buildQuery("my_submissions", { include: ["read_status"] })).toThrow();
    expect(() => buildQuery("assignments", { include: ["read_state"] })).toThrow();
    expect(() => buildQuery("file", { view: "true" } as never)).toThrow(/not allowed/);
    expect(() => buildQuery("calendar_events", { type: "assignment" })).not.toThrow(); // const ignored, then forced
    expect(buildQuery("calendar_events", { type: "assignment" }).get("type")).toBe("event");
  });

  it("forces student_ids[]=self and auto_mark_as_read=false", () => {
    const q = buildQuery("my_submissions", { student_ids: ["999"] } as never);
    expect(q.getAll("student_ids[]")).toEqual(["self"]);
    expect(buildQuery("conversation", {}).get("auto_mark_as_read")).toBe("false");
    expect(buildQuery("conversation", { auto_mark_as_read: "true" } as never).get("auto_mark_as_read")).toBe("false");
  });

  it("re-validates returned pagination queries and restores fixed params", () => {
    const ok = validateReturnedQuery("my_submissions", new URLSearchParams("student_ids[]=self&page=bookmark:abc&per_page=50"));
    expect(ok.getAll("student_ids[]")).toEqual(["self"]);
    expect(() => validateReturnedQuery("my_submissions", new URLSearchParams("student_ids[]=12345&page=2"))).toThrow(/invalid value/);
    expect(() => validateReturnedQuery("courses", new URLSearchParams("as_user_id=5&page=2"))).toThrow(/unexpected parameter/);
    const conv = validateReturnedQuery("conversation", new URLSearchParams("page=2"));
    expect(conv.get("auto_mark_as_read")).toBe("false");
  });
});
