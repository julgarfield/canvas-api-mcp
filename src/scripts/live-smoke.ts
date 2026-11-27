/**
 * Live smoke test against your real Canvas account. Prints ONLY reachability
 * and counts — no names, grades, course titles, or IDs.
 *   npm run build && npm run smoke:live
 */
import { createTokenProvider, loadConfig } from "../config.js";
import { CanvasError } from "../errors.js";
import { CanvasClient } from "../http.js";

type Row = { check: string; ok: boolean; detail: string };

async function main() {
  const config = loadConfig();
  const tokens = createTokenProvider(config.origin);
  const rows: Row[] = [];
  const src = await tokens.source().catch(() => null);
  rows.push({ check: "token configured", ok: src !== null, detail: src ? `source: ${src}` : "missing (run npm run token:setup)" });
  if (!src) return finish(rows, config.origin);
  const client = new CanvasClient({ origin: config.origin, tokens });
  const errText = (e: unknown) => (e instanceof CanvasError ? `${e.kind}${e.status ? " " + e.status : ""}` : "error");

  try {
    const p = await client.get<{ id?: unknown }>("profile");
    rows.push({ check: "profile reachable", ok: p?.id != null, detail: p?.id != null ? "ok" : "no id returned" });
  } catch (e) {
    rows.push({ check: "profile reachable", ok: false, detail: errText(e) });
    return finish(rows, config.origin);
  }

  let firstCourse: string | null = null;
  try {
    const page = await client.collect<{ id: unknown; enrollments?: Array<Record<string, unknown>> }>(
      "courses", {}, { enrollment_state: "active", include: ["total_scores"], per_page: 100 }, { limit: 200 });
    rows.push({ check: "active courses reachable", ok: true, detail: `${page.items.length} course(s)` });
    const withScores = page.items.filter((c) => (c.enrollments ?? []).some((e) => e.computed_current_score != null || e.computed_current_grade != null)).length;
    rows.push({ check: "course grades reachable", ok: true, detail: `${withScores}/${page.items.length} course(s) report a current score or grade` });
    firstCourse = page.items[0] ? String(page.items[0].id) : null;
  } catch (e) {
    rows.push({ check: "active courses reachable", ok: false, detail: errText(e) });
  }
  try {
    const page = await client.getPage("courses", {}, { enrollment_state: "completed", per_page: 10 });
    rows.push({ check: "concluded courses reachable", ok: true, detail: `${page.items.length}${page.nextCursor ? "+" : ""} course(s)` });
  } catch (e) {
    rows.push({ check: "concluded courses reachable", ok: false, detail: errText(e) });
  }
  if (firstCourse) {
    try {
      const page = await client.getPage<{ score?: unknown }>("my_submissions", { course_id: firstCourse }, { per_page: 50 });
      const scored = page.items.filter((s) => typeof s.score === "number").length;
      rows.push({ check: "assignment-level grades reachable (1 course)", ok: true, detail: `${page.items.length} submission record(s), ${scored} with a posted score` });
    } catch (e) {
      rows.push({ check: "assignment-level grades reachable (1 course)", ok: false, detail: errText(e) });
    }
  }
  finish(rows, config.origin);
}

function finish(rows: Row[], origin: string) {
  process.stdout.write(`Canvas live smoke test (${origin}) — no personal data is printed\n`);
  for (const r of rows) process.stdout.write(`  ${r.ok ? "PASS" : "FAIL"}  ${r.check}: ${r.detail}\n`);
  process.exitCode = rows.every((r) => r.ok) ? 0 : 1;
}

main().catch((e) => {
  process.stderr.write(`smoke test failed: ${e instanceof CanvasError ? e.message : "unexpected error"}\n`);
  process.exitCode = 1;
});
