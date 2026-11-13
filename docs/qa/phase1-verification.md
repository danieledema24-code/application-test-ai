# Phase 1 verification: Autonomous AI QA Analyst Platform (P1-16)

**Current verdict (Round 2): PASS WITH NOTES.** No blockers or majors remain. Five minor issues are listed below. Round 1 (FAIL) is kept underneath for history.

---

## Round 3 (lead check, 2026-11-13): minor fixes R2-1 to R2-4

- Backend suite: 153 passed (up from 146); ruff and mypy --strict clean.
- R2-1: verified live against the demo shop. Exactly one gap, "Signed-in area behind /login — Needs credentials", and the "Some pages need a sign-in…" limitation is back. Covered by `test_discovery_variants.py::test_login_form_only_site_has_one_signed_in_area_gap`.
- R2-2: completeness advice follows the stop reason; covered by `test_discovery_rules.py::test_cancelled_completeness_does_not_mention_page_limit`.
- R2-3: verified live. The URL check for `192.168.1.1.nip.io` returned a DNS-timeout message after 10.0 s (was 30 s), with no connection.
- R2-4: `ScanDetail.partial` consistency is covered by the backend tests; not re-checked in the UI.
- Still open (cosmetic): R2-5. The Live card shows "Launching an isolated browser…" next to "Now visiting /" for about a second; the focus-ring colour still needs a manual keyboard check.

**Phase 1 verdict: PASS WITH NOTES.**

## Round 2 (13 Nov 2026, after developer fixes)

Stack: backend restarted with the fixes at 08:41 on :8200 (`/health` reports `allow_private_targets: true`), web :3002, demo shop :4100. Not restarted by QA. The UI journey ran directly against **http://localhost:4100/** (no nip.io workaround).

### R2.1 Suite results (re-run by QA)

| Suite | Result |
|---|---|
| Backend pytest | **146 passed** (includes QA's 2 tenant regression tests, unchanged and now passing) |
| ruff / mypy strict | clean / no issues in 83 files |
| Web tsc / lint | clean / clean |
| Web unit + ui-mocked | **65/65** (37 + 28) |
| Real-stack `e2e/auth.spec.ts` | **4/4** |
| Real-stack `e2e/discovery-journey.spec.ts` | **2/2** (journey ran in 15 s against localhost:4100) |
| QA `e2e/phase1-full-journey.spec.ts`, Part 1 (fresh UI sign-up → Gate 1 → live → done) | **passed**, 0 soft failures |
| QA `e2e/phase1-full-journey.spec.ts`, Part 2 (views, UI-vs-API comparison, evidence, reports, default-policy G2 by keyboard, duplicate + pause, re-scan with live feed, required-policy G2, downloads, other org, sign out) | **passed**, 0 soft failures |
| axe (serious/critical) | **0** on 19 screen states (register, login, dashboard empty/with project/other-org empty, new project, overview completed/G2 waiting, 6 discovery views, G2 panel, report draft/approved, Coming-in-Phase) |
| QA API checks (`p1_api_checks.py`, round-2 vectors) | Cross-tenant **25/25 → 404**; all security checks as in round 1 |

Note on test design: `discovery-journey.spec.ts` now signs in with a shared account (to stay under the 5/hour sign-up limit). It no longer registers or checks the first-run dashboard. Sign-up through the UI is covered by `auth.spec` test 1 and QA's Part 1.

### R2.2 Round-1 bugs re-tested

| Bug | Status | Evidence |
|---|---|---|
| BUG-1 dashboard cross-tenant counts / safety net | **Fixed** | Other-org `GET /dashboard` health all zeros. UI "Welcome, Rowan · 0 projects" with "What happens next". Both QA regression tests pass. Queue position now filters by `organisation_id` (`serialize.py:298`, BUG-13 fixed). |
| BUG-2 G2 not approvable under the default policy | **Fixed** | Default ("recommended") policy shows "Ready for review" with Comment, Approve and Request changes. Approved **keyboard-only** (Tab from comment to Approve, Enter). Focus moves to the approved line. Report shows "✓ Approved by Quinn Analyst"; the scan-1 PDF was re-downloaded approved. |
| BUG-3 SSE blocked by CORS | **Fixed** | Part 1: the feed filled on the running scan with no reload (7 rows within about 1 s, indicator "Live"). Part 2: during a re-scan on Overview the feed grew 45 → 52 rows in 1.0 s without reload; lifecycle "Running, step 4 of 8". **0 CORS errors**; the only console error in the whole run is the expected 409 from the duplicate check. |
| BUG-4 client blocked localhost | **Fixed** | `http://localhost:4100/` gives "Reachable" on the dashboard and new-project page; both journeys used it directly. |
| Private LAN targets (dev flag scope) | **Fixed** | URL check refuses without connecting (10–30 ms, no HTTP status): `10.0.0.1`, `192.168.1.1`, `172.16.0.1`, `100.64.0.1`, `0.0.0.0`, `[fd00::1]`, `[fe80::1]` give `private_address`; `10.0.0.1.nip.io` (DNS → 10.0.0.1) gives `private_address` (0.2 s); metadata forms give `metadata`. Loopback (`localhost`, `127.0.0.1`) is still allowed, as intended for dev. |
| BUG-5 journey step labels | **Fixed** | UI step labels equal the API's per-step `label` for all 3 journeys (programmatic comparison, 0 mismatches) |
| BUG-6 access gaps double count / evidence | **Fixed** | Tab "Access gaps 4" = API 4 = stats 4 = report 4. Reasons from the fixed vocabulary, "Evidence (2)" per row, 0 "Evidence missing". *See R2-1 for a side effect.* |
| BUG-7 Responsive blank | **Fixed** | "0 of 6 pages show a difference between desktop and mobile." plus 6 per-page desktop/mobile rows |
| BUG-8 cancel reported as page limit | **Fixed (limitations / checks)** | After cancel at 2 pages: "Discovery was cancelled after 2 pages; 4 more links were not visited." and "Discovery was cancelled; 4 pages found were not visited; results are partial". *Gate 2 panel leftovers: R2-2.* |
| BUG-9 Live card after Pause | **Fixed** | "Discovery is paused. 1 page visited so far." with Resume; scan selector "paused"; frame frozen on the Home capture |
| BUG-10 375 px | **Fixed** | Document width 375 px on dashboard, overview, summary, functionality, sitemap, report, new project. Functionality map shows per-page cards (screenshot r2/36). |
| BUG-11 older-scan marker | **Fixed** | Reports list: "Application Discovery Report v1 · Scan 1 · Based on an older scan" |
| BUG-12 `/login` marked needs-credentials | **Fixed** | Sitemap "/login · Visited"; `auth_boundaries` has `/login (login_form)` |
| BUG-14 raw validator text | **Fixed** | "This email domain can't be used. Enter your work email address." |
| BUG-15 plurals / repeated line | **Fixed** | "1 page visited so far."; Gate 2 lines no longer triplicated |

Regression sweep, all still correct: Gate 1 (unticked error, focus, button enabled), duplicate warning + Create anyway, pause/resume mid-run (resume finishes with 6 unique pages, no revisits), cancel (409 on second cancel), re-scan versions (Scan 1 read-only, v1 report downloadable), G1/G7 locks, signed evidence URLs (tamper/expiry/extension/reuse 403), login throttle 429 `Retry-After: 600`, logout revocation 401, forgot-password indistinguishable, evidence drawer focus contract and inert DOM, PDFs (DRAFT band before approval, none after), unbuilt sections honest, other org gets "Project not found", no tokens in 800+ request URLs.

### R2.3 Remaining issues (all minor)

**R2-1 Minor (regression from the BUG-6/12 fixes): The signed-in area behind a login form is no longer an access gap.** For a site whose only sign-in signal is a login form, `access_gaps` contains no "Needs credentials → Add credentials and re-scan" row. The report limitation "Some pages need a sign-in…" is also gone. Meanwhile the Gate 2 panel on the same screen says "1 area needs credentials (/login)", and the summary says "signed-in pages were not observed". P1-10 ("access_gaps suggests providing test credentials") is now met only when a 401/403 area is found. The backend test was changed to assert the gap is absent (`backend/tests/integration/test_discovery_e2e.py:111-114`). Round 1 asked to remove the *duplicate*, not the gap. **Expected:** one "Needs credentials" gap for the signed-in area (e.g. "Signed-in area (via /login)"), deduplicated against the boundary.

**R2-2 Minor: Cancelled-scan Gate 2 panel contradicts itself and gives page-limit advice.** It shows both "2 of 6 pages found were visited (page limit 30)" (reasons) and "2 of 2 pages found were visited (page limit 30)" (checks), and recommends "Consider re-scanning with a higher page limit" after a cancel at 2/30. Suspected `backend/app/agents/discovery/completeness.py:45-50` (`total` excludes the unvisited frontier) and `:132-133` (`recommend()` defaults to page-limit advice whatever the cause).

**R2-3 Minor: The URL check's DNS lookup isn't bounded by the 10 s check timeout.** `http://192.168.1.1.nip.io/` took **30.0 s** to return `dns_failure`; the local resolver alone also takes 30 s. Contract: "10 s timeout". Suspected `backend/app/security/ssrf.py:259-261` (`loop.getaddrinfo` without `asyncio.wait_for`). It returned `allowed: true` because nothing resolved, and no connection was made.

**R2-4 Minor (carried over from Round 1): `ScanDetail.partial` is `null` on a cancelled scan,** while the report summary has `partial: true`. UI banners are correct; API consumers get inconsistent data.

**R2-5 Minor (cosmetic):** In the first second of a scan the Live card shows "Launching an isolated browser…" in the frame while "Now visiting /" is already displayed. The §14 #2 focus-ring colour still measures navy `rgb(14,23,48)` on a sidebar link focused after a mouse click. That's inconclusive; check keyboard focus by hand.

### R2.4 Design §14 changes since Round 1
#6, #9, #18, #21, #23, #28, #32: now **PASS**. #16: **PASS** live ("Running, step 4 of 8"). #19: API replay PASS; a real network drop/reconnect in the UI is still **not tested**. #20, #26: still not tested. #14: N/A (no credential fields in Phase 1). All other checks unchanged from Round 1.

### R2.5 Artefacts
- Screenshots: `/private/tmp/claude-501/-Users-danieledema-football-predictor/716cc19a-68a4-4b9a-b61c-cb2d9406cfc3/scratchpad/p1-shots-r2/`
- Downloads: `…/scratchpad/p1-downloads-r2/`
- Raw results: `…/scratchpad/p1-results-part1.json`, `p1-results-part2.json`, `p1-api-results-r2.json`, `p1-adhoc-r2.json`
- QA spec updated for round 2 (localhost target, default-policy keyboard approval, live-stream assertion, UI-vs-API comparisons, CORS console check): `web/e2e/phase1-full-journey.spec.ts`

---

# Round 1 (historical)

**Round 1 verdict: FAIL**

Date: 13 Nov 2026 · Branch `qa-analyst-rebuild` (uncommitted working tree) · Verified independently by QA against the running stack:
backend http://localhost:8200 (`ALLOW_PRIVATE_TARGETS=true`, AI disabled), web http://localhost:3002, demo shop http://localhost:4100.

The backend is in good shape: SSRF, signed URLs, throttling, session revocation, cross-tenant 404s on every resource endpoint, pause/resume/cancel, re-scan versioning and the reports all behave as specified. The discovery output is accurate for the demo shop. Phase 1 can't close yet because of:

1. **A cross-tenant data leak** on the dashboard. The tenant safety net misses aggregate queries.
2. **Gate 2 can't be approved in the UI** under the default policy. The report stays "Draft" forever.
3. **The live activity feed never works in a real browser.** The SSE stream is blocked by CORS.
4. Several UI views misreport findings: journey step labels, access gaps and the Responsive view.

None of these show up in the mocked UI tests. They only appear against the real backend.

---

## 1. Suite results (re-run by QA)

| Suite | Command | Result |
|---|---|---|
| Backend tests | `cd backend && uv run pytest` | Developer claim confirmed: **125 passed**. With the 2 QA regression tests added: **125 passed, 2 failed** (both reproduce BUG-1). |
| Backend lint | `uv run ruff check` | All checks passed |
| Backend types | `uv run mypy app` | Success: no issues in 83 source files |
| Web types | `npx tsc --noEmit` | Clean |
| Web lint | `npm run lint` | Clean |
| Web unit + mocked UI | `npx playwright test --project=unit --project=ui-mocked` | **53/53.** First run: 49 passed, 4 failed with `browserType.launch: Timeout 180000ms` while the host had load average ≈ 52. The 4 re-run alone: 7/7 passed. Environmental, but flaky under load. |
| Web e2e, real backend: `e2e/auth.spec.ts` | `E2E_SITE_URL=… npx playwright test --project=e2e e2e/auth.spec.ts` | First run: **1/4.** All `register()` calls got 422 because the helper used `@example.test`, a special-use TLD the backend rejects. QA fixed the helper. Re-run: **2/4.** Test 1 fails on "Good morning, Erin" instead of "Welcome, Erin" (caused by BUG-1). Test 4 hit the 5/hour register throttle (QA's sign-up budget, not a product bug). |
| Web e2e, real backend: `e2e/discovery-journey.spec.ts` | same | **0/2** (1 failed, 1 skipped). The dashboard live check never appears for `http://localhost:4100/` because the client blocks localhost (BUG-4). Even past that, the spec waits for "Waiting for your approval", which never appears under the default G2 policy (BUG-2). **This spec, the P1-16 acceptance journey, can't pass against a real stack.** |
| QA full journey: `e2e/phase1-full-journey.spec.ts` (new) | `P1_PART=1` / `P1_PART=2` | Part 1 (sign up → Gate 1 → discovery done): passed. Part 2 (results, evidence, report, re-scan, G2, downloads, cross-org, sign out): **1 soft failure** ("Approve discovery" missing under default policy). Every other assertion passed, including axe on 16 screens. |
| QA API checks | `scratchpad/p1_api_checks.py`, `p1_sse_check.py` | See §3. |

Target note: the web client refuses `localhost` and `127.0.0.1` (BUG-4), so the UI journey used `http://127.0.0.1.nip.io:4100/`. That is a public DNS name resolving to 127.0.0.1, which reaches the same demo shop.

---

## 2. Story acceptance (P1-01 … P1-15)

| Story | Result | Evidence |
|---|---|---|
| P1-01 Backend scaffold | PASS | `GET /health` returns `status, db, worker, ai, browser`. `test_unhandled_error_returns_500_envelope_without_internals`. Unknown route gives the `{"error":{"code":"not_found",…}}` envelope. ruff, mypy and pytest are green. |
| P1-02 DB and tenant scoping | **FAIL** | Migrations up/down/up pass (pytest). Entity reads are scoped and cross-org ids give 404 (25/25 live probes). **But `select(func.count()).select_from(Project)` is neither scoped nor refused** (BUG-1). New failing test: `tests/integration/test_db_queue.py::test_aggregate_queries_are_tenant_scoped_or_refused`. |
| P1-03 Security core | PASS | Live url-check blocks `169.254.169.254`, `[::ffff:a9fe:a9fe]`, `metadata.google.internal`, `2852039166` and `0251.0376.0251.0376` (all "metadata"), plus `file:`, `javascript:` and `user:pass@`. Signed evidence URL: valid 200; tampered sig, expired, extended `exp`, and sig reused for another id all **403**; missing sig 422. TTL 900 s. Headers `CSP: sandbox`, `nosniff`. Redaction, redirect-hop and IPv6-embedding vectors are covered by pytest. |
| P1-04 Auth and organisations | PASS | Register creates org + owner. 10 failed logins then **429 `Retry-After: 600`**. After logout the old token gets **401** on `/auth/me`. Forgot-password returns the same shape (and a dev link) for known and unknown emails. Generic "Incorrect email or password". Reset single-use is covered by pytest. |
| P1-05 LLM interface | PASS (pytest) | AI disabled: every summary, feature, journey and recommendation is labelled "Generated by rules (AI not configured)" in UI, PDF and JSON. Repair, wrapper and redaction are pytest only. |
| P1-06 Queue, worker, events | PASS (API) | Event list is in id order. SSE `Last-Event-ID: 22` returns exactly ids 23–42, ordered, no duplicates. Other org on the stream gets 404. Atomic claim and reaper are pytest only. *Browser consumption is broken by CORS: see BUG-3 under P1-14.* |
| P1-07 Orchestrator | PASS | Re-scan creates Scan 2 (v2); Scan 1 stays readable. **Pause on a running scan** stopped after page 1, held for 5 s+, and resume finished with 6 visits / 6 unique pages (no revisits). Second run while queued/running gives **409**. G1/G7 → `auto` gives **422**. With G2 `required` the stage reaches `awaiting_approval`. Cancel twice gives 409. |
| P1-08 URL submission and Gate 1 | PASS | url-check returns normalised URL, status, final URL and title. No attestation (`attested:false` or missing) gives **422** with project count unchanged (1→1). Metadata gives 422 `url_blocked`. Unreachable gives 422 `url_unreachable`. Duplicate gives **409 `DUPLICATE_PROJECT`** with `{project_id, project_name, primary_url, field}`. G1 is recorded with user and time (Overview "Gate 1: Authorised by Quinn Analyst…", report `gate1`). |
| P1-09 Browser worker | PASS (pytest) / NOT TESTED live | Network policy, password masking and context isolation are pytest only. Live: 12 screenshots for 6 pages × 2 viewports; evidence images load via signed URLs. |
| P1-10 Discovery agent | PASS WITH NOTES | Demo shop ground truth (6 pages; Contact form with 3 fields, Name and Email required; Sign-in form with 2 fields; 2 "Add to basket" buttons) matched exactly, with no invented pages or features. Auth boundary `/login` and an access gap suggesting credentials are present. Features are `observed` (catalogue `inferred`); journeys are `inferred`, with step labels correct in the API. `page.discovered` events carry a screenshot link. Notes: BUG-8 (cancel reported as "page limit"), BUG-12 (`/login` marked `requires_auth`). 404/401 fixture pages, logout/pdf skipping, injection and max_pages=5 are pytest only. |
| P1-11 Discovery report | PASS WITH NOTES | Report has HTML/PDF/JSON. JSON `counts.access_gaps=5` equals `stats.access_gaps=5`. HTML has no `<script>`, a strict CSP meta and data-URI images. Old report v1 is still downloadable (302) after re-scan. **The Reports list doesn't mark v1 as based on an older scan** (BUG-11). |
| P1-12 Web foundation | PASS | Register and login land on `/dashboard`. axe found 0 serious/critical violations on 16 screens. `validation_error` shows field messages (auth.spec test 3 passed). Note BUG-14 (raw validator text). |
| P1-13 Dashboard | **FAIL** | Live check shows "Reachable · HTTP 200 · Final URL". Start goes to the workspace. Activity shows milestones with project names. **Health tiles count other organisations' data** (BUG-1). A new org sees "Active projects 2" and "12 pages discovered", and loses the first-run welcome. Under the default policy the dashboard says "Waiting for approval" while the project says "Not reached" (BUG-2). |
| P1-14 Workspace shell and live activity | **FAIL** | Lifecycle, 21 steps, Gate 1 record and the 12-section nav are correct. **The activity feed is empty and stuck on "Reconnecting… Missed events will catch up."** on every project page. Each page logs about 75 CORS errors (BUG-3). After Pause, the header shows Resume, but the Live card still shows "Exploring…", a Pause button and the scan as "running" (BUG-9). |
| P1-15 Discovery workspace | **FAIL** | Features show provenance, confidence and openable evidence (screenshot + escaped DOM). The version switcher lists Scan 1 and 2; Scan 1 is read-only with a banner. Approval with comment works and focus moves to the approved line, **but only after QA switched G2 to `required` through the API**. Under the default policy there is no Approve control (BUG-2). Journey labels are wrong (BUG-5). Access gaps misreported (BUG-6). Responsive view is blank (BUG-7). |

## 3. Design §14 acceptance checks (34)

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | Light theme, navy primary, no dark/orange | PASS | Screenshots 01, 08, 15 |
| 2 | 2px #2F6FED focus ring, first Tab "Skip to content" | PASS WITH NOTE | Tab order on `/projects/new` reaches "Skip to content" first after the document. The ring measured on a sidebar link after a mouse click was navy `rgb(14,23,48)`; `:focus-visible` in globals.css uses `#2f6fed`. Verify by hand. |
| 3 | 12 sections, phase badges, accessible names | PASS | Nav names e.g. "Requirements, coming in Phase 2". AI QA Analyst is "Phase 2" (open question 2). |
| 4 | Unbuilt sections honest | PASS | All 9 show "{Section}: coming in Phase N", 0 tables. Screenshot 18. |
| 5 | <1024 px drawer focus trap/Escape | PASS (mocked only) | `ui-mocked` "mobile drawer traps focus…" |
| 6 | Register lands on "Welcome, {firstName}", org in sidebar | **FAIL** | Passes only for the first org in the DB. Later orgs get "Good morning" (BUG-1; auth.spec test 1) |
| 7 | Wrong credentials message, password cleared/focused | PASS | auth.spec test 2 |
| 8 | Sign out → "You've signed out.", Back shows no data | PASS | Back goes to `/login?next=…`; old token 401. Screenshot 19 |
| 9 | 0 projects: welcome, Start, "What happens next", no tiles | **FAIL** | First org: PASS (screenshot 01). User B, another org with 0 projects: tiles "Active projects 2" (BUG-1) |
| 10 | `example.com` hint and proceed | PASS | "We'll analyse https://example.com"; Enter goes to `/projects/new?url=https%3A%2F%2Fexample.com` |
| 11 | C1–C5, S1–S7, S12–S17 exact copy + aria-invalid | PARTIAL | C2, C3, C5 (metadata, 10.0.0.1, localhost) exact copy + `aria-invalid` on the dashboard. S-rows checked as API codes only (dns_failure, connection_failed, http_404); their UI copy is only in mocked tests. |
| 12 | Metadata / 10.x blocked, no continue | PASS | Client blocks both (screenshot 02); server blocks metadata in all literal forms. |
| 13 | Unticked: message, focus to checkbox, button enabled | PASS | Screenshot 04; spec asserts focus and enabled |
| 14 | Partial credentials → S16 | NOT TESTED | Phase 1 Gate 1 settings have no credential fields (credentials are Phase 2) |
| 15 | Lands on Live + toast; Overview shows G1 record | PASS | Toast "Project created. Discovery has started."; Overview "Gate 1: Authorised by Quinn Analyst, Nov 13, 08:02 AM" |
| 16 | Running: "Step n of 8", stages 2–8 "Phase n" | PASS (mocked) / NOT TESTED live | Real scans finish in about 8 s and the live feed is broken |
| 17 | 21 steps with gates | PASS | Overview "Show all 21 steps" (screenshot 09) |
| 18 | SSE event row appears at top | **FAIL** | Feed shows "No activity yet." on a project with 42+ events (BUG-3) |
| 19 | Disconnect/reconnect replay, no duplicates | **FAIL (UI)** / PASS (API) | UI is permanently "Reconnecting…"; API replay is correct |
| 20 | "Show {n} new events" when scrolled | NOT TESTED | Feed never populates (BUG-3) |
| 21 | Pause: "Pausing…", Paused, Resume, announcement | PARTIAL | Header Resume and toast correct; Live card stale (BUG-9) |
| 22 | Reduced motion | PASS (limited) | 0 animating elements at 375 px with `reducedMotion: reduce`; nothing was running |
| 23 | Every finding labelled + evidence or "Evidence missing" | **FAIL** | Labels present, but journey labels wrong (BUG-5), 5 access-gap rows "Evidence missing" although evidence exists (BUG-6), Responsive shows nothing (BUG-7) |
| 24 | DOM evidence as literal text | PASS | Drawer `pre` contains the contact page HTML as text; 0 `a/script/form/input/button` elements inside. Screenshot 13 |
| 25 | Sitemap tree keys + List mode | PASS | End/Home move focus, Enter opens page detail; List mode table |
| 26 | Desktop-only scan → Responsive message | NOT TESTED | |
| 27 | Cancelled: banner, Partial report/PDF, G2 not "Complete" | PASS | "Discovery was cancelled after 2 pages. Results below are partial."; report "Partial results…"; assessment "Partially complete" (screenshots 32, 33). False page-limit wording: BUG-8 |
| 28 | G2 approve with comment → approved line, Done, report Approved, focus | **FAIL** | Works when G2=`required` (screenshot 15, keyboard-only, focus on approved line, PDF "Approved by…"). Impossible under the default policy (BUG-2) |
| 29 | Re-scan → Scan n+1, Scan n read-only | PASS | Scan selector lists both; "You're viewing Scan 1… Older scans are read-only." |
| 30 | Report sections 1–8, A–B, UI-only sentence | PASS | In-app headings and PDF text |
| 31 | PDF: name, selectable text, cover, page numbers, evidence ids, DRAFT band | PASS | `127.0.0.1.nip.io-discovery-report-scan2-2026-11-13.pdf`, 7 pages, tagged, `lang=en`, title set, "Page x of y" on 7/7, 24–27 EV ids. **DRAFT on 7/7 pages before approval, 0/7 after.** "Preparing PDF…" too fast to observe |
| 32 | 375 px: no horizontal scroll, vertical lifecycle, per-page cards | **FAIL** | Sitemap document is 503 px wide at 375 px; Functionality map still a table (BUG-10) |
| 33 | 200% zoom | PASS (approx.) | 640 px viewport: no overflow on dashboard, overview, summary, report |
| 34 | axe: 0 serious/critical | PASS (states tested) | 0 on register, login, dashboard empty/with project, new project, overview (completed, G2 waiting), 6 discovery views, G2 panel, report draft/approved, Coming-in-Phase. Running/paused live states not scanned |

---

## 4. Bugs (most severe first)

### BUG-1 Blocker (security, T10): Dashboard health counts every organisation's data; tenant safety net skips aggregate queries
- **Steps:** Org A has projects. Register user B in a new org. Open `/dashboard` or `GET /api/v1/dashboard` as B.
- **Expected:** `health.projects_total=0`, `pages_discovered_30d=0`, first-run "Welcome, {name}" with no tiles.
- **Actual:** `{"projects_total": 2, "pages_discovered_30d": 12, …}` (org A's numbers); UI shows "Other Tenant Org · 2 projects", "Active projects 2" and "Good morning, Rowan". `recent_projects` and `activity` are correctly empty.
- **Root cause:** the `do_orm_execute` listener returns early when `state.all_mappers` has no tenant model (`backend/app/db/tenant.py:67-68`). `select(func.count()).select_from(Project)` has none, so it gets neither the org criteria nor `TenantScopeMissing`. Affected: `backend/app/api/routers/dashboard.py:35-80` (projects_total, scans_running, awaiting_approval, failed_stages, pages_30d) and `backend/app/services/serialize.py:290-298` (`_queue_position` counts other orgs' queued scans; low impact).
- **Failing tests added:** `backend/tests/integration/test_db_queue.py::test_aggregate_queries_are_tenant_scoped_or_refused` (count with org B scope returns 2; unscoped count doesn't raise) and `backend/tests/integration/test_discovery_e2e.py::test_dashboard_health_numbers_are_tenant_scoped`. The existing cross-tenant test checks `recent_projects`/`activity` but not `health`.

### BUG-2 Blocker: Gate 2 can't be approved in the UI under the default policy; the report stays Draft forever
- **Steps:** Create a project with defaults (G2 = `recommended`, per architecture.md §159). Wait for discovery. Open Discovery → Summary.
- **Expected (design §8.4, §14 #28, P1-15, P1-16):** Gate 2 panel offers Comment + Approve discovery. Approving marks the report Approved and drops the DRAFT band.
- **Actual:** Panel status "**Not reached**", no comment field or buttons. Report and PDF stay "Draft — awaiting Gate 2". Meanwhile the dashboard says "Waiting for approval · Awaiting your approval 1 · Gate waiting". The backend would accept the decision (`orchestrator.py:660` allows `completed`).
- **Suspected:** `web/src/components/domain/GateReviewPanel.tsx:132` (`waiting = stage.status === "awaiting_approval"`), `:184-191` (falls through to "Not reached"), and the form guard `{waiting && !readOnly && (…)}` (~line 266). It should key off the gate status (`recommended`/`pending`), not only the stage status.
- The developers' `e2e/discovery-journey.spec.ts` waits for "Waiting for your approval", so it can't pass against the real backend.

### BUG-3 Blocker: Live activity (SSE) is blocked by CORS in every real browser
- **Steps:** Open any project page and watch the console or the "AI agent activity" card.
- **Expected:** Events stream in; "Live" indicator.
- **Actual:** `Access to fetch at '…/events/stream?after=0' … blocked by CORS policy: Response to preflight request doesn't pass access control check`. Feed shows "No activity yet." under "Reconnecting… Missed events will catch up." indefinitely, on a project with 42+ events. About 75 console errors per page view. Live view counters and status don't update (see BUG-9).
- **Root cause (confirmed):** the client sends `Cache-Control: no-cache` (`web/src/lib/sse.ts:112`). The backend CORS `allow_headers` is `["Authorization","Content-Type","Last-Event-ID","X-Request-ID"]` (`backend/app/main.py:162`), so the preflight returns **400 "Disallowed CORS headers"**. The polling fallback doesn't take over either. Mocked UI tests stub the network and can't catch this.

### BUG-4 Major: The web client refuses localhost/private targets even when the backend allows them, so the P1-16 e2e journey can't run locally
- **Steps:** Backend with `ALLOW_PRIVATE_TARGETS=true`. Enter `http://localhost:4100` or `http://127.0.0.1:8765/` (the spec default) on the dashboard or `/projects/new`.
- **Expected:** In dev/test, the server check decides, as the roadmap's e2e against a local fixture site requires.
- **Actual:** "localhost resolves to a private or internal address…". No server check runs, and submit returns early.
- **Suspected:** `web/src/lib/url.ts:97` (`isObviouslyPrivateHost` in `checkUrlClientSide`), `web/src/app/(app)/projects/new/page.tsx:96` (`if (!client.ok) return`). Production behaviour is correct; this needs a dev/test switch.

### BUG-5 Major: Journey step labels in the UI contradict the evidence (Observed/Inferred principle)
- **Steps:** Discovery → User journeys.
- **Expected:** Use the backend's per-step `label`. API: "Fill in the contact form" is **inferred**; "Go to Sign in" is **observed**.
- **Actual:** UI shows "Fill in the contact form" as **Observed** (it was never performed) and "Go to Sign in · DemoShop" as **Inferred**, with "Why inferred: steps 1–1 were navigated".
- **Suspected:** `web/src/components/discovery/JourneyCard.tsx:19` uses `stepIsInferred(s.action)`, a keyword regex (`web/src/lib/discovery.ts:147-149`) where "sign in" in a page title counts as an action, instead of `s.label`.

### BUG-6 Major: Access gaps are double-counted and lose their reason and evidence in the UI
- **Steps:** Discovery → Access gaps; compare the Summary tile, the tab badge and Overview "Discovery at a glance" with the report and JSON.
- **Expected:** 5 gaps (API `access_gaps`, `stats.access_gaps=5`, report/JSON `counts.access_gaps=5`), each with its fixed-vocabulary reason, `area` and `evidence_refs`.
- **Actual:** UI shows **6**: `/login` appears once from `auth_boundaries` and again from `access_gaps`. The 5 server gaps render with reason "Couldn't observe", the long description as Area, and "**Evidence missing**", although each has 1–2 evidence refs.
- **Suspected:** `web/src/lib/discovery.ts:87-91` (`accessGapRows`): `rows.push({ area: g.description, reason: "Couldn't observe", …, evidence: [] })`.

### BUG-7 Major: The Responsive view is blank
- **Steps:** Discovery → Responsive on a completed desktop+mobile scan.
- **Expected:** Per-page desktop/mobile comparison or an explicit empty state.
- **Actual:** Only the "Only pages with differences" checkbox. Nothing else, no message. It's on by default and no differences were found.
- **Suspected:** `web/src/components/discovery/ResponsiveCompare.tsx:25` (`if (onlyDiffs && obs.length === 0) return null`) with no empty state at `:81-86`.

### BUG-8 Major: Cancelled scans are reported as "page limit reached" (false claim in the report)
- **Steps:** Run discovery (limit 30), cancel after 2 pages.
- **Expected:** Not-visited pages attributed to the cancellation.
- **Actual:** Completeness check "4 pages not visited: page limit reached" and limitation "**Stopped at the limit of 30 pages**; 4 more links were not visited." Next to it: "2 of 2 pages found were visited".
- **Suspected:** `backend/app/agents/discovery/agent.py:1137-1141`, `backend/app/agents/discovery/completeness.py:70`. Any non-empty `not_visited` is attributed to the limit.

### BUG-9 Minor: Live card stays "Exploring / running" after Pause (likely a symptom of BUG-3)
After Pause, the header correctly shows "Discovery paused" and "Resume analysis". The Live card still shows the spinner, "Exploring 127.0.0.1.nip.io", a Pause button, "Launching an isolated browser…", and the scan selector "Scan 1 · running". The design's paused banner ("Discovery is paused. {n} pages visited so far.") doesn't appear. Screenshot 23. Re-check after fixing BUG-3.

### BUG-10 Minor: 375 px layout (§14 #32)
The Sitemap view's document is 503 px wide at a 375 px viewport (horizontal scroll). The Functionality map still renders the full table instead of per-page cards below `md`. Suspected: `web/src/components/discovery/SitemapTree.tsx`, `FunctionalityMatrix.tsx`.

### BUG-11 Minor: The Reports list doesn't mark older reports (P1-11)
After a re-scan, "Application Discovery Report v1 · Scan 1" shows no "based on an older scan" marker, although the API returns `is_latest_scan`. Suspected: `web/src/app/(app)/projects/[id]/reports/page.tsx`.

### BUG-12 Minor: The public sign-in page is marked as needing credentials
`/login` was visited publicly but has `requires_auth: true` and shows "Needs credentials" in the Sitemap. The boundary is *behind* the form, not the form page itself. Suspected: page typing in `backend/app/agents/discovery/`.

### BUG-13 Minor: Queue position counts other organisations' queued scans
`backend/app/services/serialize.py:290-298`. Same root cause as BUG-1; low information value, but it crosses tenants.

### BUG-14 Minor: Register shows raw validator text
With a reserved-TLD email, the field shows "value is not a valid email address: The part after the @-sign is a special-use or reserved name that cannot be used with email." Map it to product copy.

### BUG-15 Minor (copy)
"Discovery paused. 1 pages visited so far." (pluralisation). The Gate 2 panel repeats "1 area needs credentials (/login)" three times (reasons list, checklist, recommendation).

### Test-infrastructure findings (not product bugs)
- `web/e2e/helpers.ts` generated `@example.test` emails, which the real backend rejects, so every real-backend e2e failed at sign-up. **Fixed by QA** (now `@example.com`).
- The real-backend specs need ≥5 sign-ups per run against a 5/hour/IP register limit, so the suite can't run twice an hour against one server.
- `ui-mocked` tests time out on browser launch under heavy host load. A 180 s launch timeout with no retries locally makes them flaky.

---

## 5. UX notes
- Gate 2 status "Not reached" on a completed, recommended-to-proceed scan reads as an error, even setting BUG-2 aside.
- Access-gap rows for un-submitted forms carry an "Observed" label. The gap is real, but "Observed" next to "Couldn't observe" is confusing.
- The `/products` page is typed "other" rather than a listing page.
- The full-page screenshots show the Next.js dev "N" badge over the sidebar footer note (dev only).
- What works well: Gate 1 copy and behaviour (button never disabled, focus to checkbox, host named in the attestation), the duplicate warning ("Open project / Create anyway"), the re-scan dialog, the evidence drawer focus contract, honest Coming-in-Phase pages, and PDF quality (tagged, DRAFT band, evidence ids, disclaimer).

## 6. Spec principles in the actual outputs
- **No invented functionality:** confirmed. Pages, forms, fields, required flags, buttons and link counts (/ 5, /products 6, others 4) match the demo shop exactly. No injection flags, nothing skipped, nothing unvisited.
- **Observed vs Inferred:** correct in API, PDF and JSON. **Wrong in the UI** for journey steps (BUG-5).
- **Limitations stated:** the "Discovery observes the user interface only…" sentence is in the Summary, the report §7, the PDF and the JSON. Read-only, sign-out-link and mobile-emulation limitations are listed. The cancelled-scan limitation text is false (BUG-8).
- **Access gaps for /login:** sensible in the API ("Needs credentials → Add credentials and re-scan", plus un-submitted forms and buttons as "Not performed: destructive or transactional action"). Misrendered in the UI (BUG-6).

## 7. Not covered (check by hand)
- UI copy for server-side states S1, S3–S8, S12–S14, S18. API codes were verified; the UI copy only in mocked tests.
- The live running-state UI (lifecycle "Step n of 8", counters ticking, "Show n new events", reconnect banner). Demo-shop scans take about 8 s and SSE is broken. Re-test on a larger site after BUG-3.
- Private addresses (10.x, 192.168.x) being blocked on the running server. They are allowed by `ALLOW_PRIVATE_TARGETS=true`. QA's url-check probe of `192.168.1.1` reached a real device on the LAN (HTTP 200), which shows the dev flag opens the whole private range. Blocking is covered by pytest only.
- Concurrency/rate-limit copy (S12/S13), offline banner, password-reset UI, screen-reader announcements, real 200% browser zoom, PDF reading order with assistive tech, a real public website, Postgres, the `ENV=production` refusal of `ALLOW_PRIVATE_TARGETS` (pytest only).
- Mobile drawer (§14 #5) and running-state lifecycle (#16) were verified only by the developers' mocked tests.

## 8. Artefacts
- New/changed tests: `web/e2e/phase1-full-journey.spec.ts` (new), `web/e2e/helpers.ts` (email domain fix), `backend/tests/integration/test_db_queue.py` (+1 failing test), `backend/tests/integration/test_discovery_e2e.py` (+1 failing test).
- Screenshots: `/private/tmp/claude-501/-Users-danieledema-football-predictor/716cc19a-68a4-4b9a-b61c-cb2d9406cfc3/scratchpad/p1-shots/`.
- Downloads (PDF/HTML/JSON, draft and approved): `/private/tmp/claude-501/-Users-danieledema-football-predictor/716cc19a-68a4-4b9a-b61c-cb2d9406cfc3/scratchpad/p1-downloads/`.
- Raw results: `p1-results-run1.json`, `p1-results-part2.json`, `p1-api-results.json`, `p1-adhoc.json` in the same scratchpad. Test-account credentials are in `p1-accounts.local.txt` (not printed).
