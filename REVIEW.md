# Canvas MCP code review

The local stdio architecture, Keychain-backed token handling, student-scoped grade and submission queries, and explicit Inbox read-state handling are a solid foundation. Fix the pagination and download redirect behavior before relying on the connector for complete, read-only access.

## [P2] Pagination silently skips records

[`src/http.ts:328`](src/http.ts#L328) · `CanvasClient.collect()`

When a Canvas response contains more items than the remaining requested limit, `collect()` slices the accumulated items but returns a cursor for the next Canvas page. That cursor skips the unread part of the current page. I reproduced this with synthetic pages `[1, 2, 3]` and `[4, 5]`. Requesting two items at a time returned `[1, 2]` and then `[4, 5]`, losing item `3`. This can silently omit assignments or grades from a review.

Preserve the position within the partially consumed page in the continuation cursor. Add a regression test that follows cursors to exhaustion and verifies every record appears once, including when the requested limit is smaller than the Canvas page size.

## [P2] Preserve read-only behavior across file download redirects

[`src/http.ts:379`](src/http.ts#L379) · `CanvasClient.downloadFile()`

The first download request sets `preview=1` to suppress Canvas module-progress updates. The client follows an allowed same-origin redirect with its query untouched. If the redirect drops `preview=1`, the follow-up request can register the file as read for module progression. This is a code-path finding. It has yet to be observed on UW–Madison’s Canvas. [Canvas file controller](https://github.com/instructure/canvas-lms/blob/master/app/controllers/files_controller.rb#L858)

Reapply the safe query on every Canvas-origin download hop or reject redirects that omit the flag. Test a same-origin redirect without `preview` and retain coverage for stripping the bearer token on off-origin storage requests.

## [P3] Document UW–Madison’s approved token flow

[`README.md:44`](README.md#L44) · Initial setup and rotation

The README directs students to create a token directly in Canvas. UW–Madison students must request a token through the school and activate the issued token in Canvas. Update both setup and rotation to reflect that process. [UW–Madison student token instructions](https://kb.wisc.edu/instructional-resources/156712)

## Verification

- `npm test` passed all 49 tests.
- `npm run build` passed.
- `npm run smoke:mcp` passed and discovered 25 tools over stdio.
- The review used synthetic data and did not use a Canvas token. Live grade and file access remain unverified.

## Resolution (2026-11-27)

- **[P2] Pagination**: fixed. Continuation cursors now carry a validated mid-page offset (`s`, an integer from 0 to 10000), so `collect()` resumes at the first unreturned item of a partly read Canvas page. Regression test: pages `[1,2,3]` and `[4,5]` are followed to exhaustion with limits 1, 2, 4, 5 and 10, and every record appears exactly once. A second test rejects malformed offsets.
- **[P2] Download redirects**: fixed. `safeDownloadQuery()` runs on the first request and again on every Canvas-origin redirect hop. It keeps only `verifier`, `download_frd` and `wrap`, and forces `preview=1`. Off-origin storage URLs keep their own signed query and never receive the bearer token. Regression test: a same-origin redirect that drops `preview` and adds an extra parameter.
- **[P3] Token flow**: fixed. The README setup, rotation and revocation steps, the 401 error message, and `token:remove` now follow KB 156712: request through the form, get the token from a 1Password link that expires in 7 days, activate it in Canvas, expect a maximum lifetime of 30 days, and contact the DoIT Help Desk to revoke early.
- Verification: `npm test` passes 52/52, and `npm run build` and `npm run smoke:mcp` pass. Live Canvas access is still unverified.
