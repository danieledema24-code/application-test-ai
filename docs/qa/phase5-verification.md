# Phase 5 verification (P5-08)

- **Date:** 2026-11-14 to 2026-11-15
- **Branch:** `phase-5`, uncommitted working tree on top of `6cbb152`/Phase 4. Migrations `0017` and `0018` are applied to `backend/data/qa.db`.
- **Stack:** API on :8200 (AI off, `ALLOW_PRIVATE_TARGETS=true`, no `--reload`), web dev server on :3002, demo shop on :4100. QA started, stopped and restarted none of them. Postgres and Redis were not used.
- **Tester:** QA agent, independent of the developers. Developer notes were treated as claims and re-checked.
- **Projects under test:**
  - **J** = `370b290d…`: a fresh demo-shop project in "E2E Shared Org". `phase5-journey.spec.ts` took it through the real UI with AI off:
    - discovery and G2 to G4
    - A11Y-0001 and SEC-0001
    - PRF-01 with PERF-0001 to PERF-0009
    - the reports
    - G8
    - the assistant
  - **O** = `680993a3…`: in QA's own second organisation "QA P5 Other Org" (`9176bcce…`). Used for the cross-tenant checks and, only there, for retention.
  - **D** = `b52e0582…`: a project created only to test archive and scheduled deletion.
  - Accounts. All except the other-org owner were added to the shared organisation through real invitation links:
    - a QA viewer
    - a QA admin
    - a QA approver (member with `can_approve`)
    - a QA member
    - the owner of the other organisation, created through register

    Their credentials are only in `p5/accounts.local.txt` (mode 0600) in the session scratchpad. The shared owner was used only through `useSharedAccount` (read-only).
- **Database:** backed up before anything that could change it (`p5/qa.db.bak-230839` and `p5/qa.db.bak-before-retention` in the scratchpad). QA made one direct DB edit, in its own organisation only: it moved the `captured_at` of 12 screenshot evidence rows back 40 days, so that retention had something to remove.
- **Shared e2e account file:** `web/playwright/.auth/e2e-account.json` md5 `c69df44680deeb88ceb8b00096085368` at the start and at the end (never written).
- **Load tests:** only against `localhost:4100`, each approved separately with the typed host, inside the organisation limits (at most 10 users, 20 rps, 45 s). k6 was never run.
- **Secrets:** no password, token or demo login appears in this report or in any QA log.

## Round 1 verdict: FAIL

**Much of Phase 5 works and is safe on the real stack, AI off:**

- **Accessibility:** the demo flaws are found exactly: `image-alt` and `color-contrast` on `/products/1` and `/products/2`, one grouped draft per rule ("Product images have no text alternative (2 pages)", "Text has too little contrast (2 pages)"). Triage needs a reason, and keyboard results never draft a defect.
- **Security:**
  - A member starts the check with no approval, and exactly the 7 expected rules fail.
  - The transport rules read "Not applicable" with the loopback reason.
  - No cookie value appears in the DOM.
  - "Raise defect" makes one grouped draft per rule.
  - The fixed statement appears everywhere it should.
- **Load-test approvals:**
  - A member requests; only an approver with the exact typed host approves.
  - Approvals are single use, and a wrong host or an off-host target is refused.
  - The org ceiling and the server's hard cap are enforced when saving, requesting and approving.
  - Stop now ends a run within 0.3 s with no draft.
  - An edited profile blocks the old request.
- **The live view polls without a reload:** 14 polls in about 12 s. The developers' suspected SWR polling bug does not occur.
- **Tenancy and roles:** the other organisation gets 404 on about 46 Phase 5 endpoints. Viewers get 403 on every write and the k6 script. Members get 403 on owner/admin endpoints. Admins get 403 on purge.
- **Reports:** the Performance, Accessibility and Security reports in HTML, PDF, CSV, XLSX and JSON contain no emails and no formulas.
- **Earlier journeys:** the Phase 2, 3 and 4 journeys still pass.

**It fails on four major points:**

1. **The UI promises a permanent deletion that never happens** (P5-BUG-01). The job that performs the deletion was cut, but the copy still says "will be deleted permanently on …".
2. **The demo thread's performance failure doesn't happen on a real project** (P5-BUG-02):
   - The rule-generated, *assumed* requirement "Pages load within 3 seconds" becomes a locked 3000 ms threshold.
   - `/products/2` at p95 1.2–2.3 s is therefore "Met", the run passes, and no draft is created.
   - The developers' tests seed fixtures instead of the real path.
3. **Evidence removed by retention shows as broken images** on every screen except the evidence drawer (P5-BUG-03, design check 37).
4. **Two D23(a) items are neither built nor declared cut** (P5-BUG-04): the egress proxy (P5-05a) and CI with the dependency audit (P5-05d). P5-08 requires the journeys to pass with the proxy on.

## Suite counts

| Suite | Command | Result |
|---|---|---|
| Backend tests | `cd backend && ~/.local/bin/uv run pytest -q` | **543 passed**, 0 failed (7 min 59 s). Rerun by QA after the developers' last fix, which they had not rerun. |
| Backend lint and types | `ruff check .`, `ruff format --check .`, `mypy --strict app` | clean |
| `automation/` | `npm test`, `npm run typecheck`, `npm run lint` | **31 passed**; typecheck and lint clean |
| Web types and lint | `npx tsc --noEmit`, `npm run lint` | clean, including QA's two new specs |
| Web unit | `npx playwright test --project=unit` | **181 passed** |
| Web ui-mocked | `npx playwright test --project=ui-mocked --workers=2` | <ul><li>**172 passed, 1 failed** (3.4 min, no timeouts or memory trouble).</li><li>The failure is `phase5.spec.ts:558`, the assistant v4 load-test proposal (check 32). Run alone with `--repeat-each=3`, it failed 2 of 3 times, twice.</li><li>The failure snapshot shows the thread empty, "Connection lost. Reconnecting." and History "Plan a load test" selected. This is a race in the test between the mocked thread reload and the posted message (P5-BUG-11).</li><li>The same flow works live: the journey's proposal created PERF-0008 `awaiting_approval`.</li><li>The developers' report that this suite "never ran clean" is therefore down to this one flaky test.</li></ul> |
| Real-stack `phase5-journey` (QA, new) | `P5_PROJECT=… P5QA_STATE=… npx playwright test e2e/phase5-journey.spec.ts --project=e2e --workers=1` | Every step passed on J (§16.1–16.4, G8 and the assistant). The project was resumed across 10 sessions while QA fixed selectors in its own spec; every step was green at the end. |
| QA UI and API spec (new) | `P5QA_STATE=… P5QA_ACCOUNTS=… P5QA_SHOTS=… npx playwright test e2e/phase5-qa-verification.spec.ts --project=e2e --workers=1` | <ul><li>Q0, Q1, Q2, Q3, Q4, Q5, Q6a, Q6b, Q8, Q9 and Q10 pass.</li><li>Q7 fails with a soft failure only for the 320 px overflow on SEC-0001 (P5-BUG-05).</li><li>Q6b records the broken images as soft observations (P5-BUG-03).</li><li>Q2 and Q4 change state, so they were run once each.</li></ul> |
| Real-stack `phase4-journey` | same, `--workers=1` | **9/9 passed** (2.0 min) |
| Real-stack `phase3-journey` | same | **8/8 passed** (1.7 min) |
| Real-stack `phase2-journey` | same | **8/8 passed** (55 s) |

## Story acceptance (P5-00 to P5-08)

| Story | Result | Evidence |
|---|---|---|
| P5-00 Foundation, migration `0017` | PASS | <ul><li>On J, after G2, nothing started by itself: the accessibility, security and performance rows read "Not run yet" (journey G2 check).</li><li>`/performance` redirects to `?tab=performance`.</li><li>`/health.tools` lists axe-core 4.14.0, the load generator and k6 "scripts but doesn't run them".</li><li>The Phase 2, 3 and 4 journeys pass.</li><li>The migration upgrade is pytest only (`test_p5_foundation.py`).</li></ul> |
| P5-01a Load generator (D17) | PASS | <ul><li>31 `automation` tests (GET only, token bucket, refusing configs over the limits, kill switch, SIGTERM) and `test_loadgen.py`.</li><li>Live: PERF-0007 Stop now finished in 0.3 s.</li><li>The kill switch cannot be changed through a profile: `ProfilePatch` is `extra="forbid"`.</li><li>k6 script: a viewer gets 403. It was downloaded for the member and parsed, but never run.</li></ul> |
| P5-02 Accessibility | PASS | <ul><li>A11Y-0001: exactly `image-alt` (Critical) and `color-contrast` (Serious) on both product pages.</li><li>Grouped drafts DEF-0002 and DEF-0001.</li><li>Triage without a reason is refused. No keyboard finding was drafted.</li><li>A second check while one runs returns 409 "An accessibility check is already running (A11Y-0002)."</li><li>A re-check keeps accepted risk and adds occurrences, with no new drafts (Q8).</li><li>axe is clean on 21 Phase 5 pages.</li></ul> |
| P5-03 Passive security (D19) | PASS WITH NOTES | <ul><li>SEC-0001 was started by a member with no approval dialog. It failed exactly these 7 rules: `csp-missing`, `nosniff`, `clickjacking`, `referrer-policy`, `permissions-policy`, `version-disclosure` (X-Powered-By) and `cookie-samesite` (recently_viewed).</li><li>The transport rules read "Not applicable" with the loopback reason.</li><li>The cookie value is not in the DOM.</li><li>One grouped draft: DEF-0003 "Responses disclose the server version (X-Powered-By) (6 pages)".</li><li>The statement is first on the tab, in the report and in the assistant answer, verbatim.</li><li>Note: the results page scrolls sideways at 320 px (P5-BUG-05).</li></ul> |
| P5-01b Performance agent, approvals, runs | **FAIL** | <ul><li>Approvals, limits, single use, stop and the stale-profile check all pass (see Safety).</li><li>**But** "demo `/products/2` fails p95" does not happen on a real project (P5-BUG-02). It only failed after QA lowered the thresholds to 800 ms through the API: PERF-0004 then drafted DEF-0004 "/products/2 slows down under load (p95 952 ms with 10 users; threshold 800 ms)".</li><li>Note: P5-BUG-06 and P5-BUG-08.</li></ul> |
| P5-01c Performance workspace and live view | PASS WITH NOTES | <ul><li>The member's request shows the exact summary: "Up to 10 virtual users, at most 20 requests a second, for 45 seconds, against localhost:4100; GET only; not signed in."</li><li>An approver typing the wrong host sees "Type localhost exactly to approve." The member has no enabled Approve control.</li><li>The live tiles update without a reload, and Stop now works from the keyboard.</li><li>Viewers see no request, save or k6 controls.</li><li>Notes: P5-BUG-05 (23 px of sideways scroll at 320 px on the results page), P5-BUG-06 and P5-BUG-10.</li></ul> |
| P5-04a Reports | PASS WITH NOTES | <ul><li>The Performance, Accessibility and Security reports, in HTML, PDF, CSV, XLSX and JSON, have 0 emails and 0 formulas (`report_sweep.py`).</li><li>The Security report carries the statement. The Performance report shows the approver and "host typed: yes".</li><li>The Defect Report has no emails.</li><li>Notes:<ul><li>The report detail page has no XLSX button; it is only in the list menu.</li><li>The Phase 2 JSON downloads do contain emails (P5-BUG-09).</li></ul></li></ul> |
| P5-07 Traceability, readiness, assistant v4 | PASS WITH NOTES | <ul><li>`traceability/chain?key=PERF-0006` returns 200.</li><li>AI-off assistant:<ul><li>The security answer ends with the statement.</li><li>Later phases lists only Phase 6.</li><li>"Plan a load test", then Accept, then Apply creates PERF-0008 `awaiting_approval`. It does not start the run.</li></ul></li><li>The mocked test for this is flaky (P5-BUG-11).</li></ul> |
| P5-04b XLSX | PASS | <ul><li>XLSX is valid zip/OOXML with no `<f>` elements.</li><li>Document reports return 422 "XLSX is available for table reports".</li></ul> |
| P5-04c DOCX | Cut (declared) | `format=docx` returns 422. No UI offers it. |
| P5-05a Egress proxy | **Not built, not declared cut** | P5-BUG-04 |
| P5-05b Audit log | PASS WITH NOTES | <ul><li>Owner and admin only: a viewer or member gets 403. Own organisation only.</li><li>The group filter returns 58 of 3,678 rows, and the CSV export's `X-Entries` equals the filtered total.</li><li>The export is itself audited (`audit_log.exported`) and has no formula cells.</li><li>Approvals read "host typed: yes" or "host typed: no", never the typed text.</li><li>Notes: P5-BUG-07, and the export contains emails (P5-BUG-09).</li></ul> |
| P5-05c Retention and purge, migration `0018` | **FAIL** | <ul><li>Retention removed 12 files and kept their metadata. The content URL answers 410 "Removed by the retention policy on 14 Nov 2026."</li><li>Purge rules hold:<ul><li>an active project gets 409 "Archive the project first."</li><li>an admin gets 403</li><li>a wrong name gets 422</li><li>both cancel and unarchive clear the schedule</li></ul></li><li>**But** the deletion never happens (P5-BUG-01), and removed files show as broken images (P5-BUG-03).</li><li>Note: P5-BUG-08.</li></ul> |
| P5-05d CI and dependency audit | **Not built, not declared cut** | There is no `.github/workflows/ci.yml` and no `scripts/check.sh` (P5-BUG-04). |
| P5-06a/b API testing | Cut (declared) | No API-testing UI or endpoints. Checks 40–41 not applicable. |
| P5-08 Close | **FAIL (close-out)** | <ul><li>The journeys pass, but "Phase 1–4 journeys pass with proxy on" can't be met (P5-BUG-04), and the demo thread's performance failure isn't produced (P5-BUG-02).</li><li>`docs/product/backlog.md` still marks every P5 story "Not started" and doesn't record the cuts.</li></ul> |

## Bugs, most severe first

### P5-BUG-01: The UI promises a permanent deletion that never happens (MAJOR)

- **Steps:**
  1. As the owner, archive project D (Settings › Archive).
  2. Choose Delete…, type the name, and confirm.
- **Actual:**
  - The callout reads "This project will be deleted permanently on 15 Nov at 23:26. Only the audit log will keep a record." It appears on Overview, Non-functional, Defects and Reports (`shots/q4-deletion-scheduled.png`).
  - The dialog says "Deletion runs in 24 hours", and the API message says "will be deleted on …".
  - The projects list shows "Deletion scheduled".
  - No job performs the deletion: the developers cut it. After the time passes, nothing is removed.
- **Expected:** P5-05c: "nothing left but audit rows" after 24 h. Since the job was cut, the UI must not promise it. For example: "Deletion is scheduled for … (not yet performed automatically in this release)". Or don't offer the action at all.
- **Where:**
  - `web/src/lib/hardening.ts:99-101` (`deletionCallout`)
  - `web/src/components/settings/ArchiveDelete.tsx:164`
  - `backend/app/api/routers/hardening.py:227`, which also gives the time in UTC with no zone, while the UI shows local time

### P5-BUG-02: On a real project, `/products/2` passes the load test, so the demo thread's performance defect never appears (MAJOR)

- **Steps:**
  1. Take a fresh demo-shop project with AI off through G2 to G4.
  2. On Non-functional › Performance, choose "Draft a load profile" (PRF-01, 6 pages).
  3. A member requests the load test, and an approver approves it by typing `localhost`.
- **Expected** (P5-01b: "demo `/products/2` fails p95"; design check 25; the roadmap demo chain):
  - `/products/2` reads "Missed" against 800 ms.
  - The run fails and drafts a performance defect.
- **Actual:**
  - Every page threshold is p95 < 3000 ms, labelled "From REQ-0022". REQ-0022 is "Pages load within 3 seconds", generated by a rule and marked *assumed*, "under normal load".
  - It replaces the 800 ms default and is locked: it can't be removed.
  - PERF-0002 and PERF-0003 measured `/products/2` at p95 1161.6 ms and 2285.1 ms, both "Met". Both runs passed, with no draft.
  - The failure only appeared after QA lowered the thresholds to 800 ms through the API: PERF-0004 failed and drafted DEF-0004.
  - The developers' backend and mocked tests use fixture thresholds and profiles, so they never exercise this path.
- **Where:** `backend/app/domain/performance/profile.py` `thresholds_for` (around line 160) takes the requirement's ms over the default, including for *assumed* rule requirements. The rule is `ac.performance.load_time` in requirements generation. Either don't lock thresholds from assumed requirements, or make the default win when it is stricter (a product decision).

### P5-BUG-03: Evidence removed by retention renders as broken images and videos everywhere except the evidence drawer (MAJOR)

- **Steps:**
  1. In project O (QA's own organisation), age its screenshots past the retention period and apply retention (12 files removed).
  2. Open Discovery › Responsive.
- **Expected** (design check 37): "Removed by the retention policy on {date}." in place of each file, and no broken image.
- **Actual:**
  - 12 broken `<img>` with no text (`shots/q6-retention-discovery.png`).
  - The page still says "No layout differences observed", although nothing can be compared.
  - Only `EvidenceDrawer.tsx` checks `removed`.
  - The mocked test covers only the drawer.
- **Other screens that use `content_url` without checking `removed`:**
  - `web/src/components/execution/Result.tsx:142,156,172`: screenshots, videos and traces. The default 30-day retention for videos and traces lands here first.
  - `web/src/components/discovery/PageDetailDrawer.tsx:20`
  - `web/src/components/discovery/ResponsiveCompare.tsx:48`
  - `web/src/app/(app)/projects/[id]/defects/[key]/page.tsx:278`
  - `web/src/components/nonfunctional/CheckResults.tsx:131`

### P5-BUG-04: The egress proxy (P5-05a) and CI with the dependency audit (P5-05d) are neither built nor declared cut (MAJOR, scope and close-out)

- **Expected:** D23(a) includes both. P5-08 requires "Phase 1–4 journeys pass with proxy on".
- **Actual:**
  - `/health` reports `egress_proxy: "off"`, and Settings shows the proxy as off.
  - There is no `.github/workflows/ci.yml` and no `scripts/check.sh`, and nothing runs `pip-audit` or `npm audit`.
  - The developers' cut list doesn't mention either item.
  - `docs/architecture/api-contracts.md` calls them "the Docker sandbox for the browser and load generator (P5-05a/d)". That is a different, declared cut.
  - The backlog still says "Not started" for both.
- **Needed:** build them, or have the product manager record the cut and change the P5-08 close criteria.

### P5-BUG-05: Phase 5 results pages scroll sideways at 320 px (MINOR)

- **Steps:** open `/projects/J/non-functional/checks/SEC-0001` at 320 px.
- **Actual:**
  - The page scrolls sideways: 4 px for the owner, and 57 px at 320 px and 2 px at 375 px in the member's state.
  - Q10 finds the source: the Segmented view control in `CheckResults` SecurityView doesn't wrap.
  - The PERF results page scrolls 23 px at 320 px (journey).
- **Expected** (design check 44): `scrollWidth` equals the viewport.
- **Gap in the developers' test:** the mocked test checks 375 px only, with fixtures.

### P5-BUG-06: A failed load test that adds to an open performance defect shows no defect link (MINOR)

- **Steps:** after PERF-0004 drafted DEF-0004, run the same profile again (PERF-0005, PERF-0006, PERF-0009). Each fails on `/products/2`.
- **Actual:**
  - Each run adds an occurrence to DEF-0004, but the run page shows no defect link.
  - `run.defects` is filtered by `environment.run_key`, which is only the first run's (`backend/app/services/performance.py` around line 833).
  - DEF-0004's summary still says "p95 952 ms".
- **Expected:** a link to DEF-0004 marked "occurrence added", as on Phase 4 runs.

### P5-BUG-07: Audit details are missing or misattributed (MINOR)

- **Actual:**
  - The details are empty for settings changes, such as retention "90 → 1" and load limits. Design §13.3 shows "users 20 → 30". See `details_text` in `backend/app/services/hardening.py:79-85`.
  - `retention.changed` is recorded even when nothing changed.
  - A manual "Apply retention now" is attributed to "system", because `backend/app/api/routers/hardening.py:165-170` passes no actor.

### P5-BUG-08: Retention doesn't remove the performance time series (MINOR)

- **Actual:** only the evidence file is removed. The per-second time series stays in `performance_runs.metrics.timeseries` (`backend/app/services/performance.py:831`), and the time-series CSV still downloads.
- **Expected:** retention of "performance time series" removes the data, or the setting says only files are removed.

### P5-BUG-09: Exports contain email addresses (MINOR)

- **Actual:**
  - The JSON downloads of the Phase 2 reports include platform user emails: `requirements_spec` 69 (`updated_by`, `status_changed_by`, `approval.decided_by`), `test_plan` 1 and `test_strategy` 1. This predates Phase 5.
  - The audit-log CSV and JSON exports include emails. That is by design for owners and admins (P5-05b), but it conflicts with the coordinator's rule "no emails in reports or exports".
  - All Phase 5 reports and the Defect Report have none.
- **Where:** `backend/app/agents/reporting/phase2_reports.py` and the serializers it uses.

### P5-BUG-10: Copy and consistency (MINOR)

- Viewer messages differ from the design's "Only owners and admins can see this page." (check 34):
  - "Only owners and admins can change load limits." (the Load limits page renders read-only)
  - "… can see retention."
  - "… can see the audit log."
- The performance draft title uses the path ("/products/2 slows down…"), not the page name ("Desk lamp page…").
- `api-contracts.md` documents `POST /reports {type}`, but the field is `report_type`.
- The purge time is in UTC with no zone, while the UI shows local time (see P5-BUG-01).
- The report detail page has no XLSX button. It is only in the list menu.

### P5-BUG-11: The mocked assistant test `phase5.spec.ts:558` (check 32) is flaky (MINOR, test only)

- **Steps:** `npx playwright test e2e/mocked/phase5.spec.ts:558 --project=ui-mocked --repeat-each=3`
- **Actual:**
  - It failed 2 of 3 times, twice.
  - The snapshot shows the thread empty and "Connection lost. Reconnecting." after "Propose a load test".
  - The mocked `GET /assistant/threads/t1` returns the fixed messages and can overwrite the posted message.
- **Expected:** a stable test. The product flow works live (the journey created PERF-0008).

### Notes (not bugs)

- **Typed host:** matched trimmed and case-insensitive in both the backend (`approvals.confirm_matches`) and the UI. This is consistent with Phase 4. While QA was probing the rule with "LOCALHOST ", it approved PERF-0009, a real run within the limits.
- **Unknown ceiling keys** in the organisation's load limits are silently dropped (200), not stored.
- **Approval panel axe hit:** the colour-contrast finding on the approval panel came from the 150 ms button transition. axe is clean after 500 ms (Q9).
- **SWR polling:** the developers suspected a stale-timer bug. It doesn't occur:
  - `refreshInterval` is in the effect's dependencies.
  - `LoadTest.tsx` polls at 1 s while there is no data.
  - Live, the A11Y check finished on screen in 8 s without a reload, and the draft link appeared on its own.
- **Retention "removed" text:** the developers' concern is confirmed. The text appears only in the evidence drawer (P5-BUG-03).

## Safety

| Check | Result |
|---|---|
| Cross-tenant | The other organisation gets **404** on every Phase 5 endpoint QA could find (about 46):<ul><li>non-functional summary</li><li>scans, findings and triage</li><li>profiles, eligible pages, k6 scripts</li><li>runs, live, stop</li><li>approvals</li><li>traceability chain</li><li>reports and downloads</li><li>organisation settings, audit log and its export, retention, archive and purge</li></ul>(Q1) |
| Viewer | <ul><li>**403** on every write and on both k6 scripts. Reads return 200.</li><li>The audit log, its export and retention return 403.</li><li>UI: no start, request, triage, save, retire or k6 controls (Q5).</li></ul> |
| Member | <ul><li>Approving a load test, `approve:true`, the org load limits, retention, the audit log and purge return 403.</li><li>Confirming at G8 is refused, with the permission note shown.</li></ul> |
| Admin | Purge returns 403 (owner only). |
| Load-test approvals | <ul><li>A wrong typed host returns 422, and the UI says "Type localhost exactly to approve."</li><li>A second decision returns 409. Reusing a used approval returns 409.</li><li>Lowering the ceiling after a request makes the approval 409.</li><li>Saving 30 users returns 422 "Your organisation allows up to 20 virtual users". A ceiling of 51 returns 422 "This server allows up to 50." A ceiling of 0 or −1 returns 422.</li><li>An off-host or undiscovered target returns 422.</li><li>PERF-0001 was blocked: "PRF-01 changed to version 4".</li><li>Every QA load test hit only localhost:4100, within the limits.</li></ul> |
| Secrets | <ul><li>No cookie value appears in the security results DOM.</li><li>The audit log stores "host typed: yes" or "host typed: no", never the typed text (no `confirm_text`).</li><li>The demo login never appears in QA output.</li><li>No new credential scan of storage was run. Phase 5 adds no credential path, because load tests are "not signed in".</li></ul> |
| Emails | <ul><li>Phase 5 reports and the Defect Report: 0.</li><li>Phase 2 JSON reports and the audit export: present (P5-BUG-09).</li><li>The audit-log screen shows "name · email" to owners and admins, which is by design.</li></ul> |
| Retention | <ul><li>Run only in QA's own organisation. The shared organisation's evidence was never touched.</li><li>Removed content returns 410 with the text.</li></ul> |

## Design checks (P5 §), as observed

**PASS live:**
- 1, 2 (via the journey's G2 guard), 3
- 5, 7, 9, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21
- 22: live polling. Pause and reduced motion were not tested.
- 23
- 26: download only; the script was not run.
- 27, 30
- 32: live. The mocked test is flaky.
- 33, 35
- 36: "Show 50 more" focus was not tested.
- 38, 39
- 42: axe on 21 pages plus the approval panel.

**FAIL:**
- 25 (P5-BUG-02)
- 29 (partly: no XLSX on the detail page)
- 34 (copy only; P5-BUG-10)
- 37 (P5-BUG-03)
- 44 (P5-BUG-05)

**Not checked live** (mocked or pytest only):
- 4 (only partly seen)
- 6, 8, 10
- 24: the 500s fixture is pytest only.
- 28, 31
- 43: keyboard was used for Stop now and approval only.

**Not applicable** (API testing cut): 40, 41.

## Risks not covered by automated tests (for a person)

- **Production build:** a `next build && next start` run. Every UI run here used the dev server.
- **Other browsers and assistive tech:** Firefox, WebKit, 200 % and 400 % zoom, and screen readers on the charts and table alternatives.
- **AI-on paths:** AI explanations of results and AI proposals in the assistant.
- **Load generator under real CPU contention:** the p95 measurements here (1.2–2.3 s on `/products/2`) varied a lot between runs on the same laptop. Threshold verdicts near the line may flip.
- **Restarts during a load test:** a backend restart while a load test runs (restart safety). This was pytest only; QA did not restart :8200.
- **The deletion job:** whatever eventually performs a scheduled deletion (cut). Nobody has seen a purge actually remove a project.

## Test changes (test files only)

- `web/e2e/phase5-journey.spec.ts` (new): the real-stack Phase 5 journey on a fresh demo-shop project, AI off. It covers:
  - setup to G4, checking that nothing starts by itself after G2
  - §16.1 accessibility
  - §16.2 security, run by a member
  - §16.3 performance: member request, approver typed-host approval, live polling, threshold verdicts, a rerun with 800 ms thresholds, and Stop now
  - §16.4 reports in PDF, HTML, CSV and XLSX, checked for zip validity, formulas and emails
  - G8: confirm and accepted-risk reject
  - the assistant v4: the security statement and the load-test proposal creating a request
- `web/e2e/phase5-qa-verification.spec.ts` (new):
  - Q0: accounts through invitations, plus a second organisation
  - Q1: cross-org 404 and role 403 matrix
  - Q2: limits and approvals
  - Q3: audit log. Changed this session to filter by group, because the newest page no longer held load-test rows.
  - Q4: archive and purge, and what the UI promises
  - Q5: settings for owner and viewer. The audit-log check now filters by group.
  - Q6a/Q6b: retention in QA's own organisation
  - Q7: axe and 375/320 px on 21 pages
  - Q8: re-check
  - Q9: approval panel axe
  - Q10: finding the overflowing element
- **QA scratch scripts outside the repo** (session scratchpad `p5/scripts/`):
  - `peek.py`: GET as a QA account
  - `report_sweep.py`: every report in every format, scanned for emails, formulas and statements
  - `email_kind.py`
- **No product code was changed.** The developers' flaky test `e2e/mocked/phase5.spec.ts:558` was left as is (P5-BUG-11).

---

# Round 2

- **Date:** 2026-11-15
- **What changed:** the developers' fixes for P5-BUG-01 to P5-BUG-11, uncommitted on `phase-5`, with no new migration (still `0018`). The API on :8200 was restarted with them by the coordinator, and the web dev server on :3002 hot-reloaded. QA started and stopped no server.
- **Projects under test:**
  - **J2** = `075c15a6…`: a fresh demo-shop project in "E2E Shared Org", taken through the whole `phase5-journey` with AI off:
    - A11Y-0001 and SEC-0001
    - PERF-0001 (failed), PERF-0002 (failed, occurrence), PERF-0003 (stopped) and PERF-0004 (the assistant's request)
    - DEF-0001 to DEF-0004
  - In QA's own organisation "QA P5 Other Org" only:
    - throwaway project `6288d16a…`, created, discovered and then purged by the worker
    - throwaway project `24e5f1cd…`, left in place
    - project O (`680993a3…`), taken to G4 for a load test (PERF-0001 there) and retention
- **Database:** backed up before anything that changed it (`p5/qa.db.bak-r2` and `p5/qa.db.bak-r2-before-ts`, made with sqlite `.backup`). QA made two direct DB edits, both in its own organisation:
  - `purge_scheduled_at` of project `6288d16a…` moved 1 minute into the past
  - one `perf_timeseries` evidence row moved back 100 days
- **Shared e2e account file:** md5 `c69df44680deeb88ceb8b00096085368` at the start and the end.
- **Load tests:** all against `localhost:4100` only, each approved with the typed host, at most 10 users, 20 rps and 45 s.

## Round 2 verdict: PASS WITH NOTES

The four round-1 majors are fixed, or (for the proxy) honestly cut, and were checked live on the real stack:

1. **Scheduled deletion now happens.**
   - The worker purged the due project about 15 s after its time.
   - 228 rows and 27 files were removed, and every URL of the project answers 404.
   - The audit log stays, with `project.purged` (name, rows, files, requested by).
   - `PRAGMA foreign_key_check` is clean, and no other project's rows changed: QA compared per-table counts across about 44,000 rows.
2. **The demo thread's performance failure happens on a fresh project.**
   - `/products/2` measured p95 1781.8 ms against the 800 ms default, and PERF-0001 `failed`.
   - Draft DEF-0004: "Desk lamp page slows down under load (p95 1.8 s with 10 users; threshold 800 ms)". All other pages were met at 0.8–2.5 ms.
3. **Removed evidence:** the Responsive view and the page drawer show "Removed by the retention policy on 14 Nov 2026." with no broken images. The Responsive cards say "No layout differences were recorded, but the screenshots were removed…". **One viewer was missed** (R2-BUG-01).
4. **CI exists and works.**
   - `scripts/check.sh` passes end to end.
   - The npm-audit gate fails (exit 1) on a fixture that depends on `lodash@4.17.15`.
   - The proxy cut is stated in `api-contracts.md`, and `/health` says `egress_proxy: "off"`. Two documents still say otherwise (R2-BUG-03).

What remains: one missed evidence viewer, a 4 px overflow, and documentation close-out.

## Round 2 suite counts

| Suite | Command | Result |
|---|---|---|
| Every CI check | `scripts/check.sh` | **All checks passed** (about 10 min):<ul><li>ruff, format and mypy --strict: clean</li><li>pytest: **545 passed** (8 min 37 s)</li><li>web tsc and eslint: clean</li><li>web unit: **183 passed**</li><li>automation: **31 passed**; typecheck and eslint clean</li><li>`pip-audit`: "No known vulnerabilities found"</li><li>`npm audit` for web: 2 high PostCSS advisories allowed; automation: clean</li></ul> |
| npm-audit gate negative check | `node scripts/npm-audit.mjs <fixture dir with lodash 4.17.15>` | **exit 1**, 3 BLOCKING high advisories |
| QA backend test (new) | `uv run pytest tests/integration/test_qa_p5_purge_busy.py` | **1 passed** |
| Web ui-mocked | `npx playwright test --project=ui-mocked --workers=2` | <ul><li>**175 passed, 2 failed** (3.5 min).</li><li>Both failures pass 3/3 on rerun, so they're environmental, not Phase 5:<ul><li>`phase2.spec.ts:120` failed on `net::ERR_CONNECTION_REFUSED` from the :3002 dev server.</li><li>`phase3.spec.ts:157` timed out on a focus.</li></ul></li></ul> |
| Former P5-BUG-11 (`phase5.spec.ts:570`, was :558) | `--repeat-each=5`, then `--repeat-each=10 --workers=2` | <ul><li>**5/5 passed**, then **9/10**.</li><li>The one failure is a different race: axe `document-title` right after the proposal renders (R2-BUG-04).</li><li>The thread race is gone: the proposal rendered in all 10 runs.</li></ul> |
| Real-stack `phase5-journey` (fresh project J2) | `P5QA_STATE=… npx playwright test e2e/phase5-journey.spec.ts --project=e2e --workers=1` | <ul><li>Every step passed, resumed across 4 runs.</li><li>Stops, all QA-side:<ul><li>QA's own G2-first assertion, because the organisation's Gate 2 is "recommended". The spec now treats that as passed.</li><li>The known 4 px SEC overflow (soft).</li><li>The 23 px live-then-finished overflow (soft).</li><li>QA's summary-format assertion, which assumed ms where the summary says "6.4 s". The spec is fixed.</li></ul></li></ul> |
| QA spec, round-2 tests | `P5QA_STATE=… P5QA_ACCOUNTS=… npx playwright test e2e/phase5-qa-verification.spec.ts --grep "R1 \|R2 \|R3 \|R4 \|R5 "` | <ul><li>R1, R3 and R5 pass.</li><li>R2 fails on User journeys (R2-BUG-01).</li><li>R4 fails on SEC-0001 4 px at 320 px (R2-BUG-02).</li></ul> |
| QA spec, round-1 regression | `--grep "Q1 \|Q3 \|Q5 \|Q7 \|Q9 "` | <ul><li>Q1 (cross-org 404, role 403, no problems), Q3 and Q5 pass.</li><li>Q7 fails only on the SEC-0001 4 px overflow.</li><li>Q9 did not run, because serial mode stopped after Q7. It passed in round 1, and the approval panel is unchanged.</li></ul> |
| Real-stack earlier journeys | `phase4`, `phase3`, `phase2` journeys, `--workers=1` | **9/9**, **8/8**, **8/8** |

## Round-1 bugs re-verified

| Bug | Result | Evidence |
|---|---|---|
| P5-BUG-01 Deletion never happens | **Fixed** | <ul><li>Live in QA's own organisation:<ol><li>Create `6288d16a…`, wait for discovery, archive it, then `POST /purge` ("will be deleted on 16 Nov at 00:49 UTC.").</li><li>Age `purge_scheduled_at`.</li><li>The worker purges it within 15 s: `project.purged` `{rows: 228, files: 27, requested_by: "Otto Other"}`, `actor_type: system`.</li></ol></li><li>After the purge:<ul><li>The project, `/non-functional` and `/reports` answer 404.</li><li>No storage files are left and `foreign_key_check` has 0 rows. The audit rows (5) remain.</li><li>The only row changes outside tables with a `project_id` column are this project's own `feature_pages` (11) and `requirement_features` (23) link rows.</li></ul></li><li>Busy-job skip: live, archive is refused while a stage is queued or running (409 "Pause or cancel the running analysis before archiving the project"), so it couldn't be reached through the API. QA added `test_qa_p5_purge_busy.py`: a running job and a queued job each hold the purge, and the purge happens once the job is done. Only the due projects go.</li></ul> |
| P5-BUG-02 `/products/2` passes | **Fixed** | <ul><li>J2 PRF-01: the `/products/2` threshold is 800 ms with a default source (not REQ).</li><li>PERF-0001: `failed`, `/products/2` p95 1781.8 ms "Missed"; others met.</li><li>Drafted DEF-0004 "Desk lamp page slows down under load (p95 1.8 s with 10 users; threshold 800 ms)".</li><li>In QA's own organisation, project O's PERF-0001 also failed on the default.</li></ul> |
| P5-BUG-03 Broken images after retention | **Partly fixed** | <ul><li>Fixed live on project O, after 12 screenshots were removed:<ul><li>Responsive: 12 "Removed by the retention policy on 14 Nov 2026.", 0 broken images, honest card text (`p5/shots/r2-responsive.png`).</li><li>Page drawer: 2 removed texts and 0 broken.</li></ul></li><li>In code, `RemovedEvidence` is now used by Result, PageDetailDrawer, ResponsiveCompare, defect detail, CheckResults and LoadTest.</li><li>**Missed:** Discovery › User journeys shows **11 broken images** (R2-BUG-01).</li></ul> |
| P5-BUG-04 Proxy and CI | **Fixed (CI) / Cut (proxy)** | <ul><li>`.github/workflows/ci.yml` runs `scripts/check.sh` plus the mocked suite. Playwright starts `next dev`, so the mocked CI job is self-contained.</li><li>`check.sh` passes, and the audit gate fails on a vulnerable package.</li><li>The proxy cut is in `api-contracts.md` ("Not built in Phase 5 …"). `/health` reports `egress_proxy: "off"`, and Settings shows "Off (development only)…".</li><li>Documentation gaps: R2-BUG-03.</li></ul> |
| P5-BUG-05 Overflow at 320 px | **Partly fixed** | <ul><li>The SEC-0001 member state went from 57 px to **4 px**. Owner and member both still overflow by 4 px at 320 px (R2-BUG-02).</li><li>375 px is clean.</li><li>Load-test results are clean on a direct load (PERF-0001/0003/0006/0007, owner and member). They still overflow by 23 px when the page watched the run live and then showed the results in place (J2 PERF-0001 and PERF-0002, journey).</li></ul> |
| P5-BUG-06 No occurrence link | **Fixed** | <ul><li>PERF-0002 on J2 failed again: `defects: [{DEF-0004, link: "occurrence_added"}]`.</li><li>The page shows "Occurrence added to DEF-0004".</li><li>The DEF-0004 summary moved to "p95 6.4 s …" (the latest).</li></ul> |
| P5-BUG-07 Audit details | **Fixed** | <ul><li>In QA's own organisation:<ul><li>An unchanged retention save and an unchanged limits save record nothing.</li><li>Changes record "screenshots 1 days → 2 days" and "users 20 → 19".</li><li>A manual apply is recorded as `retention.applied` by "Otto Other" (user), "3 files removed".</li></ul></li><li>Notes: "1 days" grammar, and an apply that removes 0 files records nothing (R2-BUG-05).</li></ul> |
| P5-BUG-08 Time series kept | **Fixed** | <ul><li>O's PERF-0001 had 25 points in `metrics.timeseries`.</li><li>After aging the series file and applying retention:<ul><li>`timeseries` is `[]` with `timeseries_removed_at` set, and the run's `timeseries_removed` reads "Removed by the retention policy on 15 Nov 2026."</li><li>The report's `csv_timeseries` answers **410** with the same text, and the report's `csv` still answers 200.</li></ul></li></ul> |
| P5-BUG-09 Emails in exports | **Fixed (new reports)** | <ul><li>Regenerated `requirements_spec`, `test_plan` and `test_strategy` JSON: **0 emails**. All other reports in every format: 0.</li><li>Reports frozen before the fix keep their emails (69 / 1 / 1), because stored reports aren't rewritten (R2-BUG-05).</li><li>The audit export keeps emails (owner/admin, documented).</li></ul> |
| P5-BUG-10 Copy | **Fixed** | <ul><li>Member and viewer on Load limits, Retention and Audit log: "Only owners and admins can see this page.", no inputs or tables, no settings links, and axe clean (R3). This matches design check 34. The member's old read-only Load limits view is gone, which agrees with check 34's "owner/admin message".</li><li>The performance draft is titled "Desk lamp page…".</li><li>`api-contracts.md` uses `{report_type}`.</li><li>The report detail page has "Download XLSX" (`reports/[type]/page.tsx:191`).</li><li>The API purge message now says "UTC".</li></ul> |
| P5-BUG-11 Flaky mocked assistant test | **Fixed (the race)** | <ul><li>`useThread.ts` keeps the answer when the URL's thread id catches up (`created` ref), and the test matches the thread GET on its path.</li><li>5/5, then 9/10. The remaining failure is R2-BUG-04.</li><li>Live: the journey's assistant step passed after the change (security answer ends with the statement, and the proposal created PERF-0004 `awaiting_approval`).</li></ul> |

## Round 2 bugs and notes, most severe first

### R2-BUG-01: Discovery › User journeys still shows broken images after retention (MINOR; design check 37)

- **Steps:**
  1. In an organisation whose screenshots were removed by retention (project O), open Discovery › User journeys.
  2. Choose "Show steps" on each journey.
- **Expected:** "Removed by the retention policy on {date}." in each step's place.
- **Actual:** 11 broken `<img>` showing only their alt text, and no removed text (`p5/shots/r2-journeys.png`).
- **Where:** `web/src/components/discovery/JourneyCard.tsx:71-73` uses `s.page.screenshot.content_url` without `RemovedEvidence`.
- **Also check:** `AgentActivityFeed.tsx:44` builds links from `content_url` for event screenshots. It wasn't seen broken, but it is the same pattern.

### R2-BUG-02: The SEC check page still scrolls sideways by 4 px at 320 px; load-test results by 23 px after a live run (MINOR; design check 44)

- **SEC page:**
  - **Steps:** open any SEC check (By rule) at 320 px, as owner or member.
  - **Actual:** `scrollWidth − innerWidth = 4`.
  - **Cause:** in `CheckResults.tsx:581-585`, each rule row is `li.flex.flex-wrap` and the title span (`min-w-0 flex-1`) is squeezed to 25–51 px, so long words spill out of it (the row's scrollWidth is 308 against a client width of 288).
- **Load-test page:**
  - **Steps:** watch a load test live at the default size, let it finish in place, then check at 320 px.
  - **Actual:** 23 px of sideways scroll (J2 PERF-0001, PERF-0002). A direct load of the same page is clean.

### R2-BUG-03: Documentation still says the proxy closes DNS rebinding, and the backlog isn't updated (MINOR, close-out)

- `docs/architecture/security-risks.md` T3 still says the residual DNS-rebinding risk is "Closed in Phase 5 (P5-05a) by forcing browser traffic through an in-worker egress proxy…". It is not closed: the proxy was cut.
- `docs/product/backlog.md` lists every P5 story as "Not started" and records none of the cuts (P5-04c, P5-05a, P5-06a/b). The roadmap's P5-05a section has no cut note either.
- P5-08's "Phase 1–4 journeys pass with proxy on" needs the product manager to restate it.
- `scripts/audit-allowlist.json` allows 4 PostCSS advisories, not one. Only 2 match today, so 2 entries are stale. `review_by` is printed but not enforced.

### R2-BUG-04: `phase5.spec.ts:570` can still fail on axe `document-title` (MINOR, test only)

- **Steps:** `npx playwright test e2e/mocked/phase5.spec.ts:570 --project=ui-mocked --repeat-each=10 --workers=2`
- **Actual:** it failed 1 of 10 times: `document-title: html` at line 616, right after the proposal card appears.
- **Cause:** the same pattern as Phase 4's `phase2.spec.ts:316`. The assistant page sets `document.title` in an effect, and axe can run before it does.

### R2-BUG-05: Small notes (MINOR)

- Audit wording "screenshots 1 days → 2 days" should read "1 day".
- A manual "Apply retention now" that removes nothing records no audit entry. That's defensible, but the design's "manual apply is recorded as the person who ran it" doesn't say so.
- Phase 2 reports frozen before the fix still contain emails. Only new or regenerated versions are clean.
- When Gate 2 is "recommended", Non-functional opens before Gate 2 is decided. This is consistent with a non-blocking gate, but design check 2 only describes the blocking case.

## Round 2 risks not covered by automated tests (for a person)

- **Purge during a running job:** the purge skip for a queued or running job is covered only by QA's pytest. The API refuses to archive during a running stage, so a job queued after archiving (a report, for example) is the only real path, and it wasn't triggered live.
- **Purge restarts:** a purge interrupted half-way (worker killed between the DB commit and file deletion) leaves orphan files under `{org}/{project}`. Nothing retries their deletion, because the project row is gone.
- **CI:** CI on GitHub itself hasn't run here. The workflow was only read, and `check.sh` was run locally.
- **Production build and other browsers:** still unchecked, as in round 1.

## Round 2 test changes (test files only)

- `backend/tests/integration/test_qa_p5_purge_busy.py` (new, 1 test): a running job and a queued job each hold a due purge, the purge happens once the job finishes, and another due project in the same pass is removed.
- `web/e2e/phase5-journey.spec.ts`:
  - Asserts the `/products/2` threshold is the 800 ms default (not from REQ) and that the draft is named after the page.
  - Adds a second failing load test that must show `occurrence_added`, "Occurrence added to DEF-…" and a summary that follows the latest measurement.
  - Treats a "recommended" Gate 2 as passed for the G2-first check.
- `web/e2e/phase5-qa-verification.spec.ts`:
  - New tests:
    - R1: project O to G4 in QA's own organisation
    - R2: removed evidence on Responsive, Summary, Sitemap, User journeys and the page drawer
    - R3: member and viewer settings copy, plus axe
    - R4: 320/375 px as owner and member
    - R5: overflow finder for load-test results
  - Q3 and Q5 now filter the audit log by group.
  - Q10 now also reports pseudo-elements and wide rows.
- **QA scratch scripts outside the repo** (session scratchpad `p5/scripts/`):
  - `purge_test.py`
  - `r2_retention.py`
  - `r2_apply.py`
  - `report_sweep_r2.py`
  - `old_reports.py`
- **No product code was changed.**

---

# Round 3 (final)

- **Date:** 2026-11-15
- **What changed:** the round-2 fixes. The API on :8200 was restarted by the coordinator, and the web dev server hot-reloaded. The dev server was also restarted once by someone else during QA's run (new PID; one `ERR_CONNECTION_REFUSED`).
- **Fresh project:** J3 = `8f3d3e68…`, in "E2E Shared Org". QA's own organisation was used for retention and audit checks.
- **Database:** backed up as `p5/qa.db.bak-r3`. No DB edits this round.
- **Shared e2e account file:** md5 `c69df44680deeb88ceb8b00096085368` at the start and the end.
- **Load tests:** localhost:4100 only, each approved with the typed host, within the limits.

## Round 3 verdict: PASS WITH NOTES

All five round-2 items are fixed and were checked on the real stack. The phase journeys pass.

One new finding comes from the developers' own pytest, which failed once in `scripts/check.sh` while the machine was busy: **a Stop now can end as `error` instead of `stopped`** (R3-BUG-01). The code shows a lost-update race on `performance_runs.metrics`. It is intermittent and passed 11 of 11 reruns. It is listed for the lead's judgement because Stop now is a safety control.

## Round 3 checks

| Item | Result | Evidence |
|---|---|---|
| 1. User journeys after retention; drawer from the activity feed | **PASS** | <ul><li>R2 on project O: User journeys shows 11 "Removed by the retention policy on …" with 0 broken images. Responsive (12), page drawer (2), Summary and Sitemap have 0 broken.</li><li>R6 (new): 3 evidence drawers opened from the Overview activity feed, sampled every 50 ms for 3 s. The most broken images seen at any instant was 0, and each shows the removed text.</li></ul> |
| 2. 320 px | **PASS** | <ul><li>Q7 (21 pages, 375/320 px): **0 problems**.</li><li>R4 (owner and member, 320 and 375 px, SEC By rule and By page, A11Y, PERF results, stopped run): **none**.</li><li>Fresh journey J3: PERF-0001 and PERF-0002 results checked at 320 px right after watching them live: no sideways scroll (round 2 had 23 px).</li></ul> |
| 3. Docs and audit gate | **PASS** | <ul><li>`security-risks.md` T3 now says "**Still open after Phase 5:** the planned in-worker egress proxy …", and that a rebinding answer between the check and Chromium's lookup is not caught.</li><li>`scripts/audit-allowlist.json` has 2 entries, both in use.</li><li>Expiry: QA copied `npm-audit.mjs` and the allow-list to the scratchpad and set `review_by` to 2026-11-01. The run then reports `BLOCKING … allow-list review date 2026-11-01 has passed`, exit 1. With the original list it exits 0. Repo files were not touched.</li></ul> |
| 4. Check 32 mocked | **PASS** | `phase5.spec.ts:587 --repeat-each=10 --workers=2`: **10/10**. |
| 5. Audit wording; empty apply | **PASS** | <ul><li>"screenshots 1 day → 2 days" and "2 days → 1 day".</li><li>Apply with nothing to remove: `retention.applied` by "Otto Other" (user), "0 files removed".</li><li>Unchanged saves still record nothing.</li></ul> |

## Round 3 suite counts

| Suite | Result |
|---|---|
| `scripts/check.sh` | <ul><li>**1 failed, 545 passed** (pytest).</li><li>Every other step is ok: ruff, format, mypy, tsc, eslint, web unit 183, automation 31, pip-audit, npm audit for web (2 allowed) and automation.</li><li>The failure is `test_p5_performance.py::test_stop_now_ends_the_run_within_two_seconds` (`done["status"]` was `error`). It ran while QA's Playwright checks were running. It passed 5/5 alone and 6/6 with 10 CPU-bound processes running alongside (R3-BUG-01).</li></ul> |
| QA backend test | `test_qa_p5_purge_busy.py`: passed inside the pytest run |
| Web ui-mocked (`--workers=2`) | <ul><li>**172 passed, 6 failed** (8.1 min, against about 3.5 min normally).</li><li>All six are navigation or visibility timeouts (10 s `toHaveURL`), including `ui.spec.ts:122`.</li><li>Rerunning the six 3 times each gave 18 passed and 6 failed, each test failing once. A warm rerun gave **24/24 passed** (1.3 min).</li><li>Judgement: dev-server cold compiles after the hot reload, not product bugs. `ui.spec.ts:122` is flaky for this reason only: its URL wait is 10 s, and a cold `/projects/new` compile can take longer.</li></ul> |
| Real-stack `phase5-journey` on a fresh project (J3) | <ul><li>Setup, §16.1, §16.2, §16.3, §16.4, G8 and assistant all pass.</li><li>PERF-0001 failed on `/products/2` p95 3079.9 ms against 800 ms and drafted DEF-0004 "Desk lamp page …". PERF-0002 shows `occurrence_added`, and the summary follows it (1.3 s). Stop now took 0.5 s.</li><li>One soft stop: axe `color-contrast` on `.hover:bg-accent-hover` on the approval panel, the round-1 transition artefact. QA's spec now waits 500 ms before that axe call.</li><li>The last two steps were rerun after the :3002 restart and passed.</li></ul> |
| Real-stack earlier journeys | phase4 **9/9**, phase3 **8/8**, phase2 **8/8** |

## Round 3 bugs

### R3-BUG-01: A Stop now can be recorded as "Didn't complete" (`error`), and by code reading the stop flag can be lost (MAJOR candidate, intermittent)

- **Observed:** in `scripts/check.sh`, `test_stop_now_ends_the_run_within_two_seconds` failed once.
  - The run did stop within the 4 s bound.
  - But it ended `status: "error"` instead of `stopped`.
  - It was not reproduced in 11 reruns.
- **Likely cause** (code, not proven by a deterministic test):
  1. `PerformanceRunner._progress` (`backend/app/agents/performance/runner.py:197-205`) reads `run.metrics`, appends the live point and writes the whole JSON column back.
  2. `services.performance.stop` (`backend/app/services/performance.py:697`) records `stop_requested` in the same column.
  3. If a progress write overlaps a stop, it overwrites `stop_requested`.
  4. `_finish` then reads `stopped_by_person = False` (runner.py:247) and takes the `else` branch, which gives `error` with `WORKER_STOPPED` (runner.py:266-270).
  5. Had the overwrite landed before `_poll_stop` saw the flag (runner.py:184-191), the stop would not reach the generator at all, and the load test would continue to its end even though the UI said "Stopped by …" was requested.
- **Expected:** "Stopped by {name}" every time.
- **Suggested fix direction:** keep `stop_requested` out of the live-metrics read-modify-write (for example a separate column, or rely on `stopped_by`), or merge atomically.

### R3-BUG-02: Mocked tests with a 10 s URL wait fail on a cold dev server (MINOR, test only)

`ui.spec.ts:12`, `:90` and `:122`, and `phase5.spec.ts:102`, `:263` and `:415`. These are test timing failures (see the counts above), not product bugs. A longer `toHaveURL` timeout, or a warm-up step in CI, would remove them.

## Round 3 test changes (test files only)

- `web/e2e/phase5-qa-verification.spec.ts`: new R6 (activity-feed evidence drawer sampled every 50 ms).
- `web/e2e/phase5-journey.spec.ts`: waits 500 ms before the approval-panel axe call.
- Scratchpad only: `p5/auditcopy/`, a copy of `npm-audit.mjs` and the allow-list used for the expiry check.
- **No product code was changed.**

## After round 3: R3-BUG-01 fixed (lead verification)

- **Cause 1 (lost update):** `stop()` and the runner's progress writes both rewrote the whole `performance_runs.metrics` JSON. Now the stop signal is `stopped_by`, set by one conditional UPDATE (only while queued or running), and progress writes set only `metrics.live` and `metrics.live_series`. Deterministic test: `test_a_stop_landing_inside_a_progress_write_is_never_lost`.
- **Cause 2 (stop during start-up):** a SIGTERM that landed before the toolkit installed its handlers made `automation/bin/qa.mjs` exit 2, which the adapter read as "refused the configuration". The wrapper now exits 128+signal, and the adapter treats a stop with no summary as `stopped` ("Stopped before the load test started"). Test: `test_a_stop_while_the_generator_is_still_starting_is_a_stop_not_a_refusal` (0, 50 and 200 ms), which fails without the fix.
- **Hardening:** a failed stop poll or progress write is logged and retried instead of ending the poller or failing the run.
- **Results:** stop tests looped 30/30; `scripts/check.sh` exit 0 (pytest 547 passed, 3 skipped; web unit 183; automation 31; audits clean).
- Not re-run after this fix: the real-stack `phase5-journey` and the full ui-mocked suite (no web code changed).
