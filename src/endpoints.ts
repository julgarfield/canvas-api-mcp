/**
 * Fixed allowlist of Canvas REST endpoints this server may call.
 *
 * Every request is built from one of these definitions. Path parameters are
 * validated (numeric Canvas IDs, or a constrained page slug), and every query
 * parameter must be declared here with a type. `const` parameters are always
 * sent with a fixed value and cannot be overridden by callers. Pagination
 * links returned by Canvas are re-validated against the same definition.
 *
 * Side-effect audit notes come from reading the canvas-lms controllers
 * (instructure/canvas-lms master). "access log" = Canvas usage analytics
 * (page-view / asset-access logging) that every API call can produce and that
 * cannot be disabled; it does not change any read/completion state.
 */
import { CanvasError } from "./errors.js";

export type QuerySpec =
  | { kind: "enum"; values: readonly string[]; multi?: boolean }
  | { kind: "bool" }
  | { kind: "int"; min: number; max: number }
  | { kind: "datetime" }
  | { kind: "string"; maxLength: number; minLength?: number; multi?: boolean }
  | { kind: "id"; multi?: boolean }
  | { kind: "context"; prefixes: readonly string[]; multi: true }
  | { kind: "const"; value: string; multi?: boolean };

export interface EndpointDef {
  path: string;
  paginated: boolean;
  query: Record<string, QuerySpec>;
  audit: string;
}

const perPage: QuerySpec = { kind: "int", min: 1, max: 100 };

export const ENDPOINTS = {
  profile: {
    path: "/api/v1/users/self/profile",
    paginated: false,
    query: {},
    audit: "profile_controller#settings (API branch): read-only; no write in API path.",
  },
  courses: {
    path: "/api/v1/courses",
    paginated: true,
    query: {
      enrollment_type: { kind: "const", value: "student" },
      enrollment_state: { kind: "enum", values: ["active", "invited_or_pending", "completed"] },
      state: { kind: "enum", values: ["available", "completed"], multi: true },
      include: {
        kind: "enum",
        multi: true,
        values: ["term", "total_scores", "current_grading_period_scores", "teachers", "public_description", "concluded", "syllabus_body"],
      },
      per_page: perPage,
    },
    audit: "courses_controller#index (json): read-only.",
  },
  course: {
    path: "/api/v1/courses/:course_id",
    paginated: false,
    query: {
      include: {
        kind: "enum",
        multi: true,
        values: ["syllabus_body", "term", "teachers", "total_scores", "current_grading_period_scores", "public_description", "concluded"],
      },
    },
    audit: "courses_controller#show (API): access log only.",
  },
  tabs: {
    path: "/api/v1/courses/:course_id/tabs",
    paginated: false,
    query: {},
    audit: "tabs_controller#index: navigation listing; documented read. Not source-audited.",
  },
  assignments: {
    path: "/api/v1/courses/:course_id/assignments",
    paginated: true,
    query: {
      // read_state / read_status deliberately NOT allowed (marks submissions read).
      include: { kind: "enum", multi: true, values: ["submission", "all_dates", "score_statistics"] },
      search_term: { kind: "string", maxLength: 200, minLength: 2 },
      bucket: { kind: "enum", values: ["past", "overdue", "undated", "ungraded", "unsubmitted", "upcoming", "future"] },
      assignment_ids: { kind: "id", multi: true },
      order_by: { kind: "enum", values: ["position", "name", "due_at"] },
      per_page: perPage,
    },
    audit:
      "assignments_api_controller#index: access log only. (#show is NOT used: it records module progress via context_module_action.)",
  },
  my_submissions: {
    path: "/api/v1/courses/:course_id/students/submissions",
    paginated: true,
    query: {
      student_ids: { kind: "const", value: "self", multi: true },
      assignment_ids: { kind: "id", multi: true },
      // read_state / read_status deliberately NOT allowed.
      include: {
        kind: "enum",
        multi: true,
        values: ["submission_history", "submission_comments", "rubric_assessment", "assignment"],
      },
      workflow_state: { kind: "enum", values: ["submitted", "unsubmitted", "graded", "pending_review"] },
      graded_since: { kind: "datetime" },
      submitted_since: { kind: "datetime" },
      order: { kind: "enum", values: ["id", "graded_at"] },
      order_direction: { kind: "enum", values: ["ascending", "descending"] },
      per_page: perPage,
    },
    audit:
      "submissions_api_controller#for_students: no write (ensure_submission not applied). student_ids[] is fixed to 'self'. include[]=read_state is excluded because it marks submissions read.",
  },
  assignment_groups: {
    path: "/api/v1/courses/:course_id/assignment_groups",
    paginated: true,
    query: {
      include: { kind: "enum", multi: true, values: ["assignments", "submission", "all_dates"] },
      grading_period_id: { kind: "id" },
      scope_assignments_to_student: { kind: "bool" },
      per_page: perPage,
    },
    audit: "assignment_groups_controller#index: no access log, no writes.",
  },
  modules: {
    path: "/api/v1/courses/:course_id/modules",
    paginated: true,
    query: {
      include: { kind: "enum", multi: true, values: ["items", "content_details"] },
      search_term: { kind: "string", maxLength: 200, minLength: 2 },
      per_page: perPage,
    },
    audit:
      "context_modules_api_controller#index: for students calls ContextModule#evaluate_for, which can create/refresh a ContextModuleProgression row. No parameter disables it → gated behind CANVAS_ENABLE_MODULE_TOOLS=1.",
  },
  module_items: {
    path: "/api/v1/courses/:course_id/modules/:module_id/items",
    paginated: true,
    query: {
      include: { kind: "enum", multi: true, values: ["content_details"] },
      search_term: { kind: "string", maxLength: 200, minLength: 2 },
      per_page: perPage,
    },
    audit:
      "context_module_items_api_controller#index: evaluate_for progression refresh (see modules). Gated. Item #show is NOT used (records module progress on some courses).",
  },
  pages: {
    path: "/api/v1/courses/:course_id/pages",
    paginated: true,
    query: {
      sort: { kind: "enum", values: ["title", "created_at", "updated_at"] },
      order: { kind: "enum", values: ["asc", "desc"] },
      search_term: { kind: "string", maxLength: 200, minLength: 2 },
      include: { kind: "enum", multi: true, values: ["body"] },
      per_page: perPage,
    },
    audit: "wiki_pages_api_controller#index: access log only.",
  },
  page: {
    path: "/api/v1/courses/:course_id/pages/:page_url",
    paginated: false,
    query: {},
    audit: "wiki_pages_api_controller#show: access log only; no module progress or read state.",
  },
  announcements: {
    path: "/api/v1/announcements",
    paginated: true,
    query: {
      context_codes: { kind: "context", prefixes: ["course"], multi: true },
      start_date: { kind: "datetime" },
      end_date: { kind: "datetime" },
      active_only: { kind: "bool" },
      latest_only: { kind: "bool" },
      per_page: perPage,
    },
    audit: "announcements_api_controller#index: no logging or writes.",
  },
  discussions: {
    path: "/api/v1/courses/:course_id/discussion_topics",
    paginated: true,
    query: {
      order_by: { kind: "enum", values: ["position", "recent_activity", "title"] },
      scope: { kind: "enum", values: ["locked", "unlocked", "pinned", "unpinned"] },
      only_announcements: { kind: "bool" },
      filter_by: { kind: "enum", values: ["all", "unread"] },
      search_term: { kind: "string", maxLength: 200, minLength: 2 },
      per_page: perPage,
    },
    audit: "discussion_topics_controller#index (json): access log only.",
  },
  discussion: {
    path: "/api/v1/courses/:course_id/discussion_topics/:topic_id",
    paginated: false,
    query: {},
    audit: "discussion_topics_api_controller#show: access log only; does not change read state (the HTML route does; it is not used).",
  },
  discussion_view: {
    path: "/api/v1/courses/:course_id/discussion_topics/:topic_id/view",
    paginated: false,
    query: { include_new_entries: { kind: "bool" } },
    audit: "discussion_topics_api_controller#view: access log only; read state is only read.",
  },
  discussion_entries: {
    path: "/api/v1/courses/:course_id/discussion_topics/:topic_id/entries",
    paginated: true,
    query: { per_page: perPage },
    audit: "discussion_topics_api_controller#entries: no logging or writes.",
  },
  discussion_replies: {
    path: "/api/v1/courses/:course_id/discussion_topics/:topic_id/entries/:entry_id/replies",
    paginated: true,
    query: { per_page: perPage },
    audit: "discussion_topics_api_controller#replies: no logging or writes.",
  },
  calendar_events: {
    path: "/api/v1/calendar_events",
    paginated: true,
    query: {
      // type=assignment is excluded: that branch calls mark_submitted_assignments (unverified write).
      type: { kind: "const", value: "event" },
      start_date: { kind: "datetime" },
      end_date: { kind: "datetime" },
      undated: { kind: "bool" },
      all_events: { kind: "bool" },
      context_codes: { kind: "context", prefixes: ["course", "user"], multi: true },
      per_page: perPage,
    },
    audit: "calendar_events_api_controller#index with type=event: read-only (metrics only).",
  },
  planner_items: {
    path: "/api/v1/planner/items",
    paginated: true,
    query: {
      start_date: { kind: "datetime" },
      end_date: { kind: "datetime" },
      context_codes: { kind: "context", prefixes: ["course", "user"], multi: true },
      filter: { kind: "enum", values: ["new_activity", "incomplete_items", "complete_items"] },
      per_page: perPage,
    },
    audit: "planner_controller#index: no user-state change (refreshes a server cache only).",
  },
  conversations: {
    path: "/api/v1/conversations",
    paginated: true,
    query: {
      scope: { kind: "enum", values: ["unread", "starred", "archived", "sent"] },
      filter: { kind: "context", prefixes: ["course", "user", "group"], multi: true },
      filter_mode: { kind: "enum", values: ["and", "or", "default"] },
      per_page: perPage,
    },
    audit: "conversations_controller#index (json): read-only.",
  },
  conversation: {
    path: "/api/v1/conversations/:conversation_id",
    paginated: false,
    query: {
      // Canvas defaults auto_mark_as_read to true for API requests. Always disabled.
      auto_mark_as_read: { kind: "const", value: "false" },
      scope: { kind: "enum", values: ["unread", "starred", "archived", "sent"] },
      filter: { kind: "context", prefixes: ["course", "user", "group"], multi: true },
      filter_mode: { kind: "enum", values: ["and", "or", "default"] },
    },
    audit: "conversations_controller#show: only write is mark-as-read, disabled by fixed auto_mark_as_read=false.",
  },
  files: {
    path: "/api/v1/courses/:course_id/files",
    paginated: true,
    query: {
      content_types: { kind: "string", maxLength: 100, minLength: 1, multi: true },
      search_term: { kind: "string", maxLength: 200, minLength: 2 },
      sort: { kind: "enum", values: ["name", "size", "created_at", "updated_at", "content_type"] },
      order: { kind: "enum", values: ["asc", "desc"] },
      per_page: perPage,
    },
    audit: "files_controller#api_index: documented read.",
  },
  file: {
    path: "/api/v1/files/:file_id",
    paginated: false,
    // `view` is deliberately not allowed: with it, api_show records module progress.
    query: {},
    audit: "files_controller#api_show: no write without the `view` param (which is never sent).",
  },
  quizzes: {
    path: "/api/v1/courses/:course_id/quizzes",
    paginated: true,
    query: { search_term: { kind: "string", maxLength: 200, minLength: 2 }, per_page: perPage },
    audit: "quizzes_api_controller#index: access log only.",
  },
  quiz: {
    path: "/api/v1/courses/:course_id/quizzes/:quiz_id",
    paginated: false,
    query: {},
    audit: "quizzes_api_controller#show: access log only.",
  },
  my_quiz_submission: {
    path: "/api/v1/courses/:course_id/quizzes/:quiz_id/submission",
    paginated: false,
    query: {},
    audit:
      "quiz_submissions_api_controller#submission: returns current user's quiz submission; no write. (#index is NOT used: it enqueues a grading job.)",
  },
} as const satisfies Record<string, EndpointDef>;

export type EndpointId = keyof typeof ENDPOINTS;

export type QueryValue = string | number | boolean | Array<string | number>;
export type QueryInput = Record<string, QueryValue | undefined>;

const ID_RE = /^\d{1,20}$/;
const PAGE_URL_RE = /^(?:page_id:\d{1,20}|[A-Za-z0-9][A-Za-z0-9._~-]{0,254})$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

export function isCanvasId(v: unknown): boolean {
  return typeof v === "string" && ID_RE.test(v);
}

/** Build the concrete pathname for an endpoint, validating every path parameter. */
export function buildPath(id: EndpointId, params: Record<string, string>): string {
  const def: EndpointDef = ENDPOINTS[id];
  return def.path.replace(/:([a-z_]+)/g, (_m, name: string) => {
    const v = params[name];
    if (v === undefined) throw new CanvasError("validation", `Missing path parameter ${name}.`);
    const ok = name === "page_url" ? PAGE_URL_RE.test(v) : ID_RE.test(v);
    if (!ok) throw new CanvasError("validation", `Invalid ${name}: expected a Canvas ID${name === "page_url" ? " or page URL slug" : " (digits)"}.`);
    return encodeURIComponent(v);
  });
}

function validateScalar(name: string, spec: QuerySpec, v: string): string {
  switch (spec.kind) {
    case "enum":
      if (!spec.values.includes(v)) throw new CanvasError("validation", `Invalid value for ${name}.`);
      return v;
    case "bool":
      if (v !== "true" && v !== "false") throw new CanvasError("validation", `${name} must be true or false.`);
      return v;
    case "int": {
      if (!/^\d+$/.test(v)) throw new CanvasError("validation", `${name} must be an integer.`);
      const n = Number(v);
      if (n < spec.min || n > spec.max) throw new CanvasError("validation", `${name} out of range.`);
      return String(n);
    }
    case "datetime":
      if (!DATETIME_RE.test(v) || Number.isNaN(Date.parse(v))) throw new CanvasError("validation", `${name} must be an ISO 8601 date/time.`);
      return v;
    case "string":
      if (v.length > spec.maxLength || v.length < (spec.minLength ?? 0) || /[\u0000-\u001f]/.test(v))
        throw new CanvasError("validation", `Invalid length or characters for ${name}.`);
      return v;
    case "id":
      if (!ID_RE.test(v)) throw new CanvasError("validation", `${name} must be a Canvas ID (digits).`);
      return v;
    case "context": {
      const m = /^([a-z]+)_(\d{1,20})$/.exec(v);
      if (!m || !spec.prefixes.includes(m[1])) throw new CanvasError("validation", `Invalid context code for ${name}.`);
      return v;
    }
    case "const":
      if (v !== spec.value) throw new CanvasError("validation", `${name} is fixed and cannot be changed.`);
      return v;
  }
}

const isMulti = (spec: QuerySpec) => "multi" in spec && spec.multi === true;

/**
 * Validate a caller-supplied query against the endpoint spec and produce
 * URLSearchParams. Const params are always applied.
 */
export function buildQuery(id: EndpointId, input: QueryInput = {}): URLSearchParams {
  const def: EndpointDef = ENDPOINTS[id];
  const qs = new URLSearchParams();
  for (const [name, raw] of Object.entries(input)) {
    if (raw === undefined) continue;
    const spec = def.query[name];
    if (!spec) throw new CanvasError("validation", `Query parameter ${name} is not allowed for this endpoint.`);
    if (spec.kind === "const") continue; // applied below
    const multi = isMulti(spec);
    const values = Array.isArray(raw) ? raw : [raw];
    if (!multi && values.length !== 1) throw new CanvasError("validation", `${name} takes a single value.`);
    if (values.length > 50) throw new CanvasError("validation", `Too many values for ${name}.`);
    for (const v of values) qs.append(multi ? `${name}[]` : name, validateScalar(name, spec, String(v)));
  }
  for (const [name, spec] of Object.entries(def.query)) {
    if (spec.kind === "const") qs.set(isMulti(spec) ? `${name}[]` : name, spec.value);
  }
  return qs;
}

/**
 * Validate a query string that came back from Canvas (pagination Link header)
 * against the same endpoint spec. Allows Canvas' own `page` cursor.
 */
export function validateReturnedQuery(id: EndpointId, qs: URLSearchParams): URLSearchParams {
  const def: EndpointDef = ENDPOINTS[id];
  const out = new URLSearchParams();
  const seenConst = new Set<string>();
  for (const [key, value] of qs) {
    if (key === "page") {
      if (value.length > 512 || /[\u0000-\u001f]/.test(value)) throw new CanvasError("security", "Rejected malformed pagination cursor from Canvas.");
      out.append(key, value);
      continue;
    }
    const multi = key.endsWith("[]");
    const name = multi ? key.slice(0, -2) : key;
    const spec = def.query[name];
    if (!spec || isMulti(spec) !== multi) throw new CanvasError("security", `Rejected pagination link with unexpected parameter "${key}".`);
    try {
      out.append(key, validateScalar(name, spec, value));
    } catch {
      throw new CanvasError("security", `Rejected pagination link with invalid value for "${key}".`);
    }
    if (spec.kind === "const") seenConst.add(name);
  }
  // Ensure fixed parameters (e.g. auto_mark_as_read=false, student_ids[]=self) are still present.
  for (const [name, spec] of Object.entries(def.query)) {
    if (spec.kind === "const" && !seenConst.has(name)) out.set(isMulti(spec) ? `${name}[]` : name, spec.value);
  }
  return out;
}
