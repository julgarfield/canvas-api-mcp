# canvas-mcp

A personal, **read-only** [Model Context Protocol](https://modelcontextprotocol.io) server for a Canvas LMS **student** account, defaulting to UW–Madison (`https://canvas.wisc.edu`). It runs locally over stdio, so Codex and Claude Code launch it with the same command.

> **Status:** first working version. The server is fixture-tested, and an MCP smoke test over stdio passes. **It has not been tested against live Canvas yet.** No token was configured when it was built. Run `npm run smoke:live` after you set up your token (see below).

This is a private local project: `"private": true` is set, and nothing is published.

---

## Safety model (enforced in code)

| Guarantee | Where |
|---|---|
| Only `GET` requests, and only to a **fixed allowlist** of 26 documented Canvas endpoints. There is no generic URL, raw API, or write tool. | `src/endpoints.ts`, `src/http.ts` |
| Every path parameter is validated (numeric Canvas IDs or a constrained page slug), and every query parameter is typed and declared per endpoint. | `buildPath` / `buildQuery` |
| Fixed parameters callers can't override: `student_ids[]=self`, `auto_mark_as_read=false`, `enrollment_type=student`, `type=event`. | `const` specs in `ENDPOINTS` |
| Personal grade and submission tools have **no student or user ID parameter**. They always query `self`. | `tools.ts`, tested |
| The `Authorization: Bearer` header is attached **only** when the URL is on the configured `https` Canvas origin. | `CanvasClient.rawGet` |
| `Link: rel="next"` pagination URLs are checked before use: same origin, same endpoint path, and every parameter re-checked against the allowlist. Fixed params are re-applied. Cursors given to the model are opaque and re-checked when used. | `nextCursor`, `validateReturnedQuery` |
| API redirects are **never** followed. File downloads take one narrow path: they start at a Canvas `/files/:id/download` URL and may follow redirects only to allowlisted Instructure storage hosts (`*.inscloudgate.net`, `*.instructure-uploads.com`, `*.canvas-user-content.com`, `*.instructuremedia.com`, Instructure upload S3 buckets), **without** the token. Once a download leaves Canvas, it can't return to Canvas. | `downloadFile` |
| Inbox threads are opened with `auto_mark_as_read=false`. | `ENDPOINTS.conversation` |
| `include[]=read_state` and `read_status` (which mark submissions read) can't be sent. The endpoints that record module progress (`assignments/:id`, `modules/items/:id`) and the file `view` parameter are not used. | allowlist |
| Course content (pages, syllabus, messages, discussions, file text) comes back as **inert text**, labeled untrusted. Scripts are dropped, and links are listed but never fetched. Signed `verifier` and `token` URL parameters are removed from output. | `src/content.ts` |
| Nothing is written to disk. File bytes are downloaded to memory on demand (10 MB by default, 25 MB maximum), and text is extracted locally. | `canvas_get_file_text` |
| The token never appears in tool output, logs, argv, or config files. Known secrets and Canvas token patterns are redacted from every error. stdout is reserved for MCP, and logs go to stderr. | `src/errors.ts`, `src/index.ts` |
| Bounded retries (3) with backoff for timeouts, network errors, HTTP 429, Canvas's `403 Rate Limit Exceeded`, and 502/503/504. `Retry-After` is honored, up to 30 s. Each request times out after 20 s (downloads after 60 s). | `getWithRetry` |

---

## 1. Install and build

Requires Node 20 or later.

```sh
cd /path/to/canvas_mcp     # wherever you cloned this repo
npm install
npm run build
npm test
```

## 2. Configure your token

**UW–Madison students can't generate tokens themselves** (since November 14, 2025). The approved process, from [KB 156712](https://kb.wisc.edu/instructional-resources/156712):

1. **Request a token** using the KB page's *Request Canvas Access Token* button, which opens the "Canvas Access Token Request" form. You can ask for an expiration date earlier than the default.
2. **If approved,** a UW–Madison Canvas admin creates the token for you. You'll get an email with a link to a 1Password secure note. **That link expires 7 days after you receive it**, so copy the token before then. Treat it like a password.
3. **Activate the token in Canvas**, as the email and KB describe. Instructure's guide: [How do I manage API access tokens in my user account?](https://community.canvaslms.com/t5/Canvas-Basics-Guide/How-do-I-manage-API-access-tokens-in-my-user-account/ta-p/615312)
4. **Store it locally** with one of the options below. Don't paste it into chat, config files, or the command line.

Tokens issued this way **expire within 30 days at most**. When yours expires, the server returns `[auth 401]`, and you request a new one through the same form.

For a different Canvas instance (with `CANVAS_BASE_URL` set) where students can create their own tokens, use **Account → Settings → Approved Integrations → + New Access Token**.

### Option A: macOS Keychain (recommended)

```sh
npm run token:setup     # security(1) prompts for the token twice; input is hidden
npm run token:check     # prints only whether a token exists, and where it came from
```

This stores a generic password with service `canvas-mcp` and account `canvas.wisc.edu` in your login keychain. Because the token is typed at the `security` prompt, it never lands in shell history or the process list. The server reads it at the first tool call, using `/usr/bin/security find-generic-password … -w`.

### Option B: environment variable

If `CANVAS_API_TOKEN` is set in the server's environment, it takes precedence over the Keychain. It's handy for a one-off terminal session:

```sh
read -s CANVAS_API_TOKEN && export CANVAS_API_TOKEN   # paste, then Enter; nothing is echoed
npm run smoke:live
```

Don't put the token in client config files. The examples below rely on the Keychain.

### Rotation, revocation, errors

- **Rotate or renew (UW–Madison):** request a new token through the same form, activate it in Canvas, then run `npm run token:setup` again (`-U` replaces the Keychain item). Restart your MCP clients, because the server keeps the token in memory. Plan on doing this at least every 30 days.
- **Revoke early:** if a token is exposed or no longer needed before it expires, the KB says to **contact the [DoIT Help Desk](https://kb.wisc.edu/1)** to have it removed. Also run `npm run token:remove` to delete the local copy.
- **Remove locally:** `npm run token:remove` deletes only the Keychain item. The token stays valid in Canvas until it expires or is revoked.
- **Missing token:** tools return `[config] No Canvas API token is configured … npm run token:setup`.
- **Invalid, expired, or revoked token (HTTP 401):** tools return `[auth 401] Canvas rejected the API token (invalid, expired, or revoked) …` with rotation steps.
- **Restricted content:** `[permission 401|403] …`. Canvas also uses 401 for "user not authorized to perform that action", and the server tells the two apart.

### Optional environment settings

| Variable | Default | Purpose |
|---|---|---|
| `CANVAS_BASE_URL` | `https://canvas.wisc.edu` | Canvas origin. Must be `https`, with no path. |
| `CANVAS_ENABLE_MODULE_TOOLS` | unset | Set to `1` to register module tools. See the side-effect audit. |
| `CANVAS_DOWNLOAD_HOST_SUFFIXES` | none | Extra comma-separated file-storage host suffixes to allow, if a live test shows another Instructure host. |

## 3. Connect the clients (same absolute launch command)

The launch command for both clients:

```
/path/to/node /path/to/canvas_mcp/dist/index.js
```

Replace the placeholders with absolute paths:

- `/path/to/node`: the output of `which node`, e.g. `/opt/homebrew/bin/node` on Apple-silicon Homebrew. Use an absolute path, because GUI clients may not inherit your shell's `PATH`.
- `/path/to/canvas_mcp`: the output of `pwd` in the repo folder.

### Claude Code

```sh
claude mcp add --scope user canvas -- /path/to/node /path/to/canvas_mcp/dist/index.js
claude mcp list        # should show canvas ✓ connected
```

In a session, run `/mcp` to see the tools. Docs: <https://code.claude.com/docs/en/mcp>.

### Codex (CLI, IDE extension, or app; they share `~/.codex/config.toml`)

Either run:

```sh
codex mcp add canvas -- /path/to/node /path/to/canvas_mcp/dist/index.js
```

or add this to `~/.codex/config.toml`:

```toml
[mcp_servers.canvas]
command = "/path/to/node"
args = ["/path/to/canvas_mcp/dist/index.js"]
startup_timeout_sec = 20
tool_timeout_sec = 120
```

Then use `/mcp` in the Codex TUI to confirm. Docs: <https://learn.chatgpt.com/docs/extend/mcp?surface=cli>.

Neither config contains the token. The server process reads it from the Keychain. If your Node path changes (for example, after switching version managers), update both entries.

## 4. Smoke tests

| Command | What it does | Needs a token |
|---|---|---|
| `npm test` | 52 unit and integration tests against a synthetic Canvas (no network) | no |
| `npm run smoke:mcp` | Starts the built server over **real stdio** with the MCP SDK client, lists tools, and calls `canvas_server_info` plus one tool (expected to fail cleanly without a token). It points at `canvas.invalid.example`, so no Canvas traffic happens. | no |
| `npm run smoke:live` | Checks against your real account whether the token, profile, active and concluded courses, course grades, and assignment-level grades are reachable. **Prints only PASS/FAIL and counts**: no names, grades, titles, or IDs. | yes |
| `node dist/scripts/mcp-stdio-smoke.js --live` | Stdio MCP smoke test that also calls `canvas_get_profile` and prints only ok or the error kind | yes |

---

## Tools (25 by default, 27 with modules)

Every tool takes a `course` as either a Canvas ID or a unique part of the course name or code (for example `"COMP SCI 400"`). If a name matches several courses, the tool returns an error listing them instead of guessing. List tools accept `limit` and an opaque `cursor`, and return `next_cursor`.

**Grades first**
- `canvas_get_profile`: profile check (token owner)
- `canvas_list_courses`: active, concluded, pending, or all courses, with Canvas-reported current and final score and letter grade
- `canvas_get_course_grades`: course totals for one course or all courses. `status` is one of `reported`, `hidden_by_course`, `not_reported`, `no_student_enrollment`. Grading-period scores are included when present.
- `canvas_list_assignments`: due date, points, and **my** status and posted score per assignment. Filters: bucket, search, order.
- `canvas_get_assignment_grade`: one assignment, with description, rubric, and my submission: score, grade, attempts, timestamps, late/missing/excused, late-policy deduction, instructor comments with feedback-attachment file IDs, rubric assessment, and submission history with per-attempt attachments
- `canvas_list_my_submissions`: my submissions across a course. Filters: `graded_since`, `submitted_since`, `workflow_state`. Feedback is optional.

`grade_status` values: `graded`, `zero` (an explicit 0, kept separate from everything else), `excused`, `hidden` (graded but not posted), `possibly_hidden` (manual posting and nothing posted, so Canvas doesn't say which), `submitted_ungraded`, `not_submitted`, `not_graded_assignment`, `unavailable` (no submission data). Each comes with a `grade_status_basis`. Scores are never recalculated.

**Rest of the account**
- `canvas_get_course`, `canvas_get_syllabus`, `canvas_list_assignment_groups` (weights, drop rules, and whether weighting is applied)
- `canvas_list_pages`, `canvas_get_page` (text or raw HTML, as data)
- `canvas_list_announcements`, `canvas_list_discussions`, `canvas_get_discussion` (threaded replies)
- `canvas_list_calendar_events`, `canvas_list_planner_items` (to-do items with submission status)
- `canvas_list_inbox`, `canvas_get_inbox_thread` (never marks threads read)
- `canvas_list_files`, `canvas_get_file`, `canvas_get_file_text` (PDF, DOCX, PPTX, HTML, and text/code files, with offset paging). Works for course files and for submission and feedback attachments by file ID.
- `canvas_list_quizzes`, `canvas_get_quiz` (Classic Quiz metadata plus my quiz submission)
- `canvas_list_course_links`: navigation tabs, including external tools, with links
- `canvas_server_info`: origin, whether a token is configured (never the token), policy, and the endpoint allowlist with audit notes
- *(opt-in)* `canvas_list_modules`, `canvas_list_module_items`

---

## Coverage matrix

Legend: ✅ implemented and covered by synthetic-fixture tests · 🟡 implemented, covered only by discovery/schema tests · 🔶 **needs live verification** · ⛔ excluded or restricted.

**Nothing has been verified against live `canvas.wisc.edu` yet**, so every row also needs a live check.

| Area | Tool(s) | Endpoint(s) | Status | Notes |
|---|---|---|---|---|
| Profile check | `canvas_get_profile` | `GET /users/self/profile` | ✅ 🔶 | 401 and missing-token paths tested |
| Current courses + course grades | `canvas_list_courses`, `canvas_get_course_grades` | `GET /courses?include[]=total_scores,current_grading_period_scores` | ✅ 🔶 | Distinguishes a real 0 from `hide_final_grades` and from not reported |
| Concluded courses | same, `enrollment_state=completed` | `GET /courses?enrollment_state=completed` | 🟡 🔶 | Depends on whether UW keeps concluded enrollments visible to students |
| Assignment list with my grades | `canvas_list_assignments` | `GET /courses/:id/assignments?include[]=submission` | ✅ 🔶 | |
| Assignment detail, feedback, rubric, history | `canvas_get_assignment_grade` | `assignments?assignment_ids[]=` + `students/submissions?student_ids[]=self&include[]=submission_history,submission_comments,rubric_assessment` | ✅ 🔶 | Self-only enforced and tested. Media comments are reported but not transcribed. |
| Recent grades and feedback | `canvas_list_my_submissions` | `GET /courses/:id/students/submissions` | 🟡 🔶 | |
| Feedback and submission attachments | `canvas_get_file`, `canvas_get_file_text` | `GET /files/:id` + download | ✅ 🔶 | Whether students can read attachment metadata through `/files/:id` needs a live check |
| Course details and syllabus | `canvas_get_course`, `canvas_get_syllabus` | `GET /courses/:id?include[]=syllabus_body` | 🟡 🔶 | Many UW courses put the syllabus in a file or page. The tool says so when the Syllabus page is empty. |
| Assignment groups and weights | `canvas_list_assignment_groups` | `GET /courses/:id/assignment_groups` | 🟡 🔶 | Weights are reported, not applied |
| Pages | `canvas_list_pages`, `canvas_get_page` | `GET /courses/:id/pages[/:url]` | ✅ 🔶 | Untrusted-content handling tested. The Pages index can be disabled per course. |
| Announcements | `canvas_list_announcements` | `GET /announcements` | 🟡 🔶 | |
| Discussions and replies | `canvas_list_discussions`, `canvas_get_discussion` | `discussion_topics`, `/:id`, `/:id/view`, `/:id/entries` (fallback) | 🟡 🔶 | "Post before seeing replies" topics hide replies. Live check needed that `/view` doesn't change read state. |
| Calendar | `canvas_list_calendar_events` | `GET /calendar_events?type=event` | 🟡 🔶 | Context codes are sent in chunks of 10. Assignment due dates come from the planner instead. |
| Planner / to-do | `canvas_list_planner_items` | `GET /planner/items` | 🟡 🔶 | |
| Inbox | `canvas_list_inbox`, `canvas_get_inbox_thread` | `GET /conversations[/:id]?auto_mark_as_read=false` | ✅ 🔶 | Read-state preservation tested. Confirm live by opening an unread thread. |
| Files: list and metadata | `canvas_list_files`, `canvas_get_file` | `GET /courses/:id/files`, `GET /files/:id` | ✅ 🔶 | Many courses hide Files from students, giving a clear 401/403 permission error (tested) |
| Files: text extraction | `canvas_get_file_text` | `/files/:id/download?preview=1` → Instructure storage | ✅ 🔶 | PDF, DOCX, and PPTX parsers tested. **Live check needed:** the actual redirect host, and that `preview=1` still returns raw bytes. Add hosts with `CANVAS_DOWNLOAD_HOST_SUFFIXES` if needed. |
| Classic Quizzes | `canvas_list_quizzes`, `canvas_get_quiz` | `GET /courses/:id/quizzes[/:id]`, `GET …/quizzes/:id/submission` | 🟡 🔶 | Question-level responses are not fetched. Use `canvas_get_assignment_grade` for the posted score. |
| New Quizzes | via `canvas_list_assignments` (`is_new_quiz`) | - | ⛔ | New Quizzes is an LTI tool, not the Classic Quizzes API. Only the assignment score and link are available. |
| External tools (Gradescope, Top Hat, Piazza, Kaltura, …) | `canvas_list_course_links` | `GET /courses/:id/tabs` | 🟡 🔶 | Links only. Tool content isn't reachable through the Canvas API. |
| Modules and items | `canvas_list_modules`, `canvas_list_module_items` | `GET /courses/:id/modules[/:id/items]` | ⛔ by default | Listing modules as a student creates or refreshes Canvas's module-progression record, and no parameter turns that off. Opt in with `CANVAS_ENABLE_MODULE_TOOLS=1`. |
| Grades of other students, rosters, peer data | - | - | ⛔ | Out of scope; student IDs are not accepted |
| Any write: submit, post, reply, mark read/done, planner overrides | - | - | ⛔ | Not implemented, by design |

## Side-effect audit summary

I audited the `GET` endpoints by reading `instructure/canvas-lms` controller source. "Access log" means Canvas usage analytics (page views and asset access). Canvas records it for API calls, and no parameter turns it off. It doesn't change read, completion, or submission state.

| Endpoint | Finding | Decision |
|---|---|---|
| `GET /conversations/:id` | Marks the thread read unless `auto_mark_as_read=false` | **Used, with `auto_mark_as_read=false` fixed** |
| `GET /courses/:id/assignments/:id` (show) | Records module progress (`context_module_action :read`) | **Not used.** The list endpoint with `assignment_ids[]` is used instead. |
| `include[]=read_state` on submissions | Calls `submission.mark_read` | **Blocked** (`read_status` too) |
| `GET …/submissions/:user_id` (show) | `ensure_submission` before-action may create a row | **Not used.** `students/submissions?student_ids[]=self` is used instead. |
| `GET …/quizzes/:id/submissions` (index) | Queues a grading job for outstanding attempts | **Not used** |
| `GET …/quizzes/:id/submission` | Reads the current user's submission, with no write found | Used |
| `GET /courses/:id/modules`, `…/items` | `evaluate_for` creates or refreshes progression rows | **Gated, off by default** |
| `GET …/modules/:id/items/:id` (show) | Records module progress on some course types | **Not used** |
| `GET /files/:id` | Records progress only with `view` | Used; `view` is never sent |
| `/files/:id/download` | Records progress and access logs unless `preview` is set | Used with `preview=1`; **live check pending** |
| `GET /calendar_events?type=assignment` | May call `mark_submitted_assignments` | **Blocked.** `type=event` is fixed. |
| Pages, discussions, announcements, courses, assignment groups, planner, profile, tabs | Access log only, or none | Used. Tabs was audited from docs only. |

## Known gaps and next steps

1. **Live verification** of every row above. Start with `npm run smoke:live`.
2. Confirm the file-download redirect host for UW and that `preview=1` returns bytes. Then confirm that opening an unread Inbox thread leaves it unread in the web UI.
3. Group files and folders, and the `/users/self/missing_submissions` and `/users/self/todo` endpoints, are not included yet because their side effects weren't audited from source.
4. XLSX, images (OCR), and legacy `.doc`/`.ppt` are metadata only.

## Development

```
src/
  config.ts      origin and token resolution (env → Keychain), download-host allowlist
  endpoints.ts   endpoint allowlist + parameter validation + pagination re-validation
  http.ts        CanvasClient: auth pinning, retries, pagination, narrow download path
  grades.ts      grade-status normalization (no recalculation)
  content.ts     untrusted HTML → text, link listing, URL scrubbing
  extract.ts     in-memory PDF/DOCX/PPTX/text extraction
  tools.ts       MCP tool definitions (zod-typed)
  server.ts      McpServer assembly
  index.ts       stdio entrypoint (stdout reserved for MCP)
  scripts/       live-smoke, mcp-stdio-smoke, token-check
test/            synthetic fixtures and a fake Canvas (no network)
```

References: [Canvas REST API](https://developerdocs.instructure.com/services/canvas) · [UW–Madison KB 156712](https://kb.wisc.edu/instructional-resources/156712) · [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) · [Claude Code MCP](https://code.claude.com/docs/en/mcp)
