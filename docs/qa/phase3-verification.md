# Phase 3 verification (P3-09)

- **Date:** 2026-11-13
- **Branch:** `phase-3`, uncommitted working tree
- **Stack:** API on :8200 (AI off), web on :3002, demo shop on :4100. All three were up for the whole run; none was started or stopped by QA.
- **Tester:** QA agent, independent of the developers. Developer self-reports were treated as claims and re-checked.
- **Project under test:** "QA P3 Demo Shop" (`a7368ef2…`) in a QA-only organisation, driven through the real UI by `web/e2e/phase3-qa-verification.spec.ts` (J1–J13) plus API probes. A second organisation was used for cross-tenant checks. Members were added only through real invitation links.
- **Screenshots:** `p3-shots/` (63 files), aria snapshots in `p3-aria/`, downloads in `p3-downloads/`, all in the session scratchpad outside the repo.
- **Shared e2e account file:** `web/playwright/.auth/e2e-account.json` md5 `c69df44680deeb88ceb8b00096085368` before, during and after every run (never overwritten).

## Round 3 (final, targeted): PASS WITH NOTES (final verdict)

- **When:** 2026-11-13, after the backend restart with the round 2 fixes.
- **Project:** a fresh demo-shop project, "QA P3 R3 Demo Shop", taken through G3 and G4 in the UI (J1, J2). Then:
  1. A negative-cases proposal was accepted.
  2. The design was regenerated twice.
  3. A review was applied in the UI.
  4. Each copy fix was checked by `phase3-qa-verification.spec.ts` R3, R3b, R3c and R3d.
- **Screenshots:** `p3-shots/round3-*`. Downloads are in `p3-downloads/r3/`. Both are in the session scratchpad.
- **Shared e2e account file:** md5 `c69df44680deeb88ceb8b00096085368` before and after every run.

All round 2 items are fixed. The checks for blocker and major defects found none. What remains is one small wording note.

### Round 3 suite counts

| Suite | Result |
|---|---|
| Backend `uv run pytest -q` | **263 passed**, 0 failed |
| ruff check, ruff format --check, `mypy app` (strict) | clean |
| Web tsc, eslint | clean (0 warnings) |
| Web unit | **122 passed** |
| Web ui-mocked (`--workers=2`) | <ul><li>74 passed and 11 failed. The run overlapped with QA's real-stack UI runs.</li><li>Serial rerun of the 11: 8 passed.</li><li>The remaining 3 (`phase2.spec.ts:24`, `ui.spec.ts:77`, `ui.spec.ts:222`) **passed when run alone**.</li><li>All 85 pass; the failures were load.</li></ul> |
| Real-stack e2e, serial | `phase2-journey` **8/8**, `phase3-journey` **8/8** |
| QA spec on the fresh project | J1, J2, R3, R3b, R3c, R3d all passed |

### Round 2 items re-checked

| Item | Round 3 | Evidence |
|---|---|---|
| R2-01 "{d0}" in accepted cases | **Fixed** | <ul><li>PROP-0001 (REQ-0003, 5 items) was accepted. TC-0043…TC-0047 store the step actions **exactly as previewed** (compared item by item; 0 mismatches), for example `Enter "casey fixture@example.com" in Email`.</li><li>No "{d" appears in the API, the case page (`round3-tc0045-accepted-case.png`) or any report download.</li><li>Each step carries its data item (TD-0021…TD-0025 created, existing ones reused).</li></ul> |
| R2-02 Label and origin of accepted cases | **Fixed** | <ul><li>Classification matches the preview for all 5 (Assumed, Inferred, Inferred, Inferred, Assumed).</li><li>Each case has `generated_by: rules`, `human_edited: false` and `source: assistant`.</li><li>**Regeneration keeps them:** run 2's review was `no_longer_found: 0` and 95 unchanged. After apply, all 5 are still Draft in run 2, and run 1 is `superseded`.</li></ul> |
| R2-05 Rollback leaves the proposal pending | **Fixed (backend test)** | `test_accept_rolls_back_and_stays_pending_on_an_unexpected_error` (`tests/integration/test_phase3_flow.py:664`) checks four things: an error on the second case gives 500 without leaking the message, the case, data and audit counts are unchanged, the proposal stays `pending`, and a retry is accepted. It passes in the 263. |
| "Preliminary: assessed in Phase 4." twice | **Fixed** | Appears once on TC-0006 (`round3-tc0006-preliminary.png`) |
| "TD-0007 (len:0)" coverage label | **Fixed** | TCOND-0006 shows "TD-0007 (empty)", and no "len:" remains anywhere (`round3-tcond0006-coverage-labels.png`) |
| TCS "Saved logins are named, never shown." | **Fixed** | Present in the TCS PDF (pypdf text) and the HTML |
| Test data headings repeat the path | **Fixed** | "Form · Contact us form (/contact)", "Form · Sign in form (/login)" |
| Retire dialog repeats "and" | **Fixed** | "TD-0001 is used by TC-0005, TC-0006, …, TC-0018 and 7 more." (`round3-td-retire-in-use.png`) |
| Lowercase toast | **Fixed** | "Test design is waiting for your approval" |
| Regenerate while a review is pending (check 45) | **Fixed** | The dialog says "A regeneration is waiting for review. Review or discard it before starting another." It offers Cancel and Review changes, with no Regenerate button (`round3-regenerate-pending.png`). |
| Raw JSON in change review | **Fixed** | TC-0007 (protected, edited by a person) shows "Changed 1. Open /contact", the removal "in a new browser tab" as a text deletion, and "→ The contact form is shown". There is no JSON or UUID on the page, and axe is clean (`round3-change-review.png`). |
| Check 5 "Started automatically after Gate 4 approval" | **Fixed** | Still shown on the step 13 row after the run finished, on the round 2 project whose design G4 started (`round3-check5-started-automatically.png`). It is correctly absent on the round 3 project, whose latest run was a manual regeneration. |

### Safety (round 3, quick)

The demo username and password were checked and are absent from:
- the 32 API responses on the new paths: every proposal detail with its preview, all test data items, the 5 accepted cases and the thread
- `qa.db` and the WAL
- all 8 round 3 report downloads, with PDF text extracted

The draft reports carry "DRAFT: not the approved version (G5)".

### Remaining (round 3)

- **MINOR copy:** in negative-case proposals and the cases accepted from them, a field that keeps its existing valid data item is written as "Enter valid in Message" instead of its value or "a valid Message". The preview and the stored case match, so this is wording only.
- **P3-09 close-out (the coordinator's call):**
  - The legacy `api/src/routes/assistant.ts`, `workspace.ts` and `testing.ts` (and their tests) are still present.
  - The backlog statuses haven't been updated.
  - The members step of `phase3-journey` returns early when the shared account isn't an owner or admin, so invitation acceptance through the UI is covered only by QA's J5.
- **Not checked:**
  - a production build of the web app (see the round 2 note on the dev-server compile)
  - Firefox, WebKit and screen readers
  - the AI-on paths

### Final verdict

**PASS WITH NOTES.** Every round 1 and round 2 defect is fixed and re-verified live. The P3-09 journey works on the demo shop from the rule output to a G5 approval in the UI, then on to traceability and reports. The developers' journeys and all suites pass. What remains is one wording note and the P3-09 close-out items above.

### Round 3 test changes (test files only)

- `web/e2e/phase3-qa-verification.spec.ts`: added R3, R3b, R3c and R3d.
- QA scratch script (outside the repo): `qa/r3_props.py`.

---

## Round 2 (re-verification of fixes): FAIL, one major bug left

- **When:** 2026-11-13, about 18:45–19:30, after the backend restart with migration 0015.
- **Project:** a fresh demo-shop project, "QA P3 R2 Demo Shop" (`5deb30c6…`), in the QA organisation. It was driven through the real UI from discovery to a real G5 approval by `phase3-qa-verification.spec.ts` (J1–J3 and R2a–R2f), with API probes alongside.
- **Screenshots:** `p3-shots/round2-*` (J1–J3 on the fresh project are `round2-j*`). Downloads are in `p3-downloads/round2-*`. All are in the session scratchpad.
- **Shared e2e account file:** md5 `c69df44680deeb88ceb8b00096085368` before and after every run.

Every round 1 blocker and major is fixed, and so are most of the minors. The core D1–D6 journey now works on the demo shop from the rule output alone:

1. Discovery, then G3 and G4.
2. 42 designed cases, including REQ-0013 (TC-0041 HTTPS checklist).
3. Write TC-0006's expected result. It saves without inventing step results.
4. Bulk approve all cases.
5. "Approve test cases", then "Gate 5 approved."

The developers' real-stack journeys now pass (24/24), and the safety regression is clean.

The verdict is still **FAIL** because of one new **major** defect in the code fixed this round. Test cases added by accepting a "Generate more negative test cases" proposal store the step placeholder literally ("Enter {d0} in Email"). That text shows on the case page and is what a person would approve (R2-01). It is a small, targeted fix; nothing else stands in the way of PASS WITH NOTES.

### Round 2 suite counts

| Suite | Result |
|---|---|
| Backend `uv run pytest -q` | **262 passed**, 0 failed (4 min 39 s). Includes QA's 5 tests in `test_qa_p3_ai_validation.py`. |
| ruff check, ruff format --check, `mypy app` (strict) | clean (165 files formatted, 136 source files) |
| Web tsc, eslint | clean. The 2 warnings in QA's own spec were removed. |
| Web unit | **116 passed** |
| Web ui-mocked (`--workers=2`) | 82 passed, 1 failed. The failure (`ui.spec.ts:90` "bare host gets an https hint") **passed on a serial rerun**, so it was load. |
| Real-stack e2e, serial | `auth` **4/4**, `discovery-journey` **2/2**, `phase1-full-journey` **2/2**, `phase2-journey` **8/8**, `phase3-journey` **8/8**. Total **24/24**. |
| QA spec R2a–R2f + J1–J3 on the fresh project | all passed. Defects are recorded as state values (below). |

### Round 1 bugs re-checked

| Round 1 bug | Round 2 | Evidence |
|---|---|---|
| P3-01 Proposal accept 500 and half-applied | **Fixed** | <ul><li>PROP-0001 (5 negative cases on REQ-0003) was accepted with 200. Cases went from 42 to 47 and the status is `accepted`.</li><li>PROP-0002 (`set_suite`, 11 cases) was accepted with 200. All 11 of 11 were applied.</li><li>Stale probe: the proposal adds `regression` to TC-0006 and TC-0007. Editing TC-0007 and then accepting gives **409** "The target changed after this proposal was made". **Neither case changed** (TC-0006 was not half-applied), and the status is `stale`.</li><li>Audit has 5 `assistant.proposal_accepted` rows.</li><li>The "other error rolls back and leaves pending" branch is not reachable live and has no test. Only the stale path is tested (`test_regression_suite_proposal_accepts_atomically`).</li></ul> |
| P3-21 TCS report page crash | **Fixed** | The TCS and RTM pages render ("Approved at Gate 5"). axe is clean, and there is no sideways scroll at 375 or 320 px (R2d, `round2-report-test-case-spec.png`). |
| P3-02 Edits can't be saved | **Fixed** | <ul><li>TC-0006: Write expected result, then Save gives "Expected result saved. TC-0006 can now be approved." No step errors (R2a, `round2-tc0006-after-save.png`).</li><li>The read view no longer flags "Missing expected result".</li><li>Lint errors = 0 across 42 cases.</li></ul> |
| P3-03 G5 not approvable on the demo shop | **Fixed** | <ul><li>TC-0041 "Sign-in credentials are sent only over HTTPS" (checklist, Assumed) covers REQ-0013.</li><li>After the open question was answered and the cases approved, G5 had **0 Must fix**, and "Approve test cases" was enabled and approved through the UI (R2c, `round2-g5-ready.png`, `round2-g5-approved.png`).</li><li>Note: the demo shop runs on `http://localhost`, so TC-0041 will rightly fail in Phase 4.</li></ul> |
| P3-04 Negative cases never proposed | **Fixed, with a new defect (R2-01)** | <ul><li>REQ-0003 gave 5 items: spaces around Name, Email and Message; an email with a space inside; two "@". Each has steps, data (new TD marked), expected result, label and constraint.</li><li>Asking again gives "No further negative test cases can be derived…" listing the 10 existing negatives, with 11 citations and no proposal card.</li></ul> |
| P3-05 Technique default "Other" | **Fixed** | Default is "Choose a technique" (value empty) with no "Other". Saving gives the field error "Choose the test design technique this case uses." and no raw enum (R2b, `round2-new-case-technique.png`). |
| P3-06 TC-0018 expects "s" accepted | **Fixed** | TC-0018 now expects "Submission is blocked and Email is identified as an invalid email address". |
| P3-07 REQ-0007 doesn't show the waiting case | **Fixed** | "1 test case is waiting for this answer: TC-0006." (`round2-req0007-waiting-case.png`) |
| P3-08 Missing API fields | **Fixed** | <ul><li>The case summary has `risk_key`, `feature`, `condition_key`, `changed_in_latest` and `objective`.</li><li>`priority_source` is present.</li><li>Data items have `form` and `used_by[].status`.</li><li>Coverage has `approved_at`.</li><li>The condition has `design_basis.evidence_refs`.</li><li>UI: "Used by 13 approved cases (…). Saving moves them back to Draft and Gate 5 will need approval again." with the **"Save and reopen review"** button (`round2-td-edit-used-by-approved.png`). Conditions have evidence links.</li></ul> |
| P3-09 Search key/title only | **Fixed** | `q=Network panel` and `q=developer tools` return TC-0041 (step text). `q=contact form is shown` matches step expected results. |
| P3-10 Retire 409 shape | **Fixed** | `details.used_by` lists 13 keys. The dialog lists them with "Show these cases". |
| P3-11 Two "Close" buttons | **Fixed** | 1 button named "Close". The confirm offers "Go back" and "Close without copying". |
| P3-12 TCS CSV duplicate rows | **Fixed** | 42 rows, 42 unique keys, for the 42-case approved version |
| P3-13 Needs-AI tasks missing | **Fixed** | Needs AI lists "Update test cases" and "Suggest missing test cases". Capabilities have `needs_ai: true, available: false`. |
| P3-14 Regression items without a reason | **Fixed** | Each item has a reason, e.g. "Approved test case (scope: every approved case)". The summary reads "(every approved case)", not a raw key. |
| P3-15 Disabled Approve not focusable | **Fixed** | TC-0006 Approve: `aria-disabled="true"`, focusable, and Enter opens no dialog |
| P3-16 Copy | **Partly fixed** | <ul><li>Fixed:<ul><li>"Not decided:" now appears once.</li><li>The priority and test-data copy match.</li></ul></li><li>Still open:<ul><li>"Preliminary: assessed in Phase 4." appears twice in the Automation row.</li><li>The coverage-item label "TD-0007 (len:0)".</li><li>The lowercase toast "test design is waiting for your approval".</li><li>The feed shows "Queued Test conditions and test cases" rather than "Started automatically after Gate 4 approval" (check 5).</li></ul></li><li>Not rechecked (no pending review on the fresh project):<ul><li>the Regenerate-while-pending copy (check 45)</li><li>the raw JSON steps in the change review</li></ul></li></ul> |
| P3-17 Superseded run still awaiting | **Fixed** | Round 1 project runs: v2 is `approved`, v1 is `superseded` with `superseded: true` |
| P3-18 "Last approved" disabled after reopen | **Fixed** | After editing approved TC-0013 (warning shown, G5 reopened), "Last approved (Gate 5)" is enabled and opens `?basis=approved` (`round2-trace-last-approved.png`) |
| P3-19 Lost first click (dev server) | **Explanation plausible; not a product bug as far as tested** | <ul><li>Both journeys now pass.</li><li>The same click always worked on a warm route (J13).</li><li>QA did **not** run `next build && next start`. A build writes to the same `.next` folder the :3002 dev server uses, so it would have disturbed it.</li><li>A curl of a detail route after 90 s idle answered in 0.16 s, so the "drops after a minute idle" part was not reproduced (the route may have been kept warm by other traffic).</li><li>A person should open a project with a production build once to confirm.</li></ul> |
| 76 Focus after closing a case | **Fixed** | Browser Back and the breadcrumb both return focus to the TC-0013 row link |

### Remaining bugs (round 2), most severe first

#### R2-01: Cases added from a negative-cases proposal show "{d0}" in their steps (MAJOR)

- **Steps:**
  1. In the assistant, run "Generate more negative test cases" for REQ-0003 and accept PROP-0001.
  2. Open TC-0045.
- **Expected:** steps read like the preview and the rule cases, e.g. "Enter "casey fixture@example.com" in Email" or "Enter TD-0023 (a space inside) in Email".
- **Actual:**
  - Steps 2–4 read "Enter {d0} in Name", "Enter {d0} in Email" and "Enter {d0} in Message" in the API and on the case page (R2f, `round2-assistant-case-placeholders.png`). This affects all 5 accepted cases (TC-0043…TC-0047).
  - The data chips (TD-0001, TD-0023, TD-0003) are attached, so a tester could work it out, but this is the text a person approves and that goes into the TCS.
- **File:** `backend/app/services/assistant_p3.py`. The preview resolves `{dN}` (`_preview_step`, around lines 361–370), but the accept path stores the generator's raw action. Rule cases resolve it at design time (`backend/app/domain/testdesign/generate.py:1541`).

#### R2-02: Accepted cases don't keep the preview's label (MINOR)

- PROP-0001 previews "Email with a space inside: rejected" as **Inferred**, but TC-0045 is stored as **Assumed**.
- The accepted cases are also stored with `generated_by: human` (with `source: assistant`).
- The label the person reviewed should be the label that is saved.

#### R2-03: New copy defects (MINOR)

- Test data form headings repeat the path: "Form · Contact us form (/contact) (/contact)".
- The retire dialog joins keys with repeated "and": "used by TC-0005 and TC-0006 and TC-0008 and …".

#### R2-04: Round 1 copy items still open (MINOR)

- "Preliminary: assessed in Phase 4." is printed twice.
- "TD-0007 (len:0)" coverage-item label.
- Lowercase toast "test design is waiting for your approval".
- Check 5: no "Started automatically after Gate 4 approval" once the stage has finished.
- The TCS PDF has no "Saved logins are named, never shown." line (check 61).

#### R2-05: Untested rollback path (risk, MINOR)

The "any other error rolls everything back and leaves the proposal pending" branch of proposal accept has no test. Only stale (409) is covered, by the developer's test and live.

### Safety regression (round 2)

| Check | Result |
|---|---|
| Cross-tenant | <ul><li>All 41 Phase 3 endpoints return **404** to the other organisation on the new project.</li><li>The new project's proposals (GET and accept) and its thread (GET and message) return 404.</li><li>PATCH of a membership id from another organisation returns 404.</li></ul> |
| Roles | <ul><li>A viewer gets 403 on all 18 write endpoints, on G5 approval and on proposal accept.</li><li>The member removed in round 1 still gets 401.</li></ul> |
| Invitations | <ul><li>The 43-character token is stored as SHA-256 (hash verified), with a 7-day expiry.</li><li>No raw token is in `qa.db`, the WAL or audit metadata.</li><li>Lookup works; after revoke it returns 404.</li><li>Accept works; reuse returns 404 "This invitation is no longer valid".</li><li>Removing the new member made their session return 401 immediately.</li></ul> |
| Credential absence | <ul><li>Demo username and password are absent from `qa.db`, the WAL, the SHM, the pre-P3 backup and 1,624 storage files.</li><li>Also absent from 34 API responses, including every proposal detail with its preview, all 25 test data items, the thread and the capabilities.</li><li>Also absent from all 8 round 2 report downloads (PDF text extracted with pypdf).</li><li>Password items TD-0014…0016 have no value and only a secret reference.</li></ul> |

### P3-09 close-out items still open (coordinator's call)

- Legacy `api/src/routes/assistant.ts`, `workspace.ts` and `testing.ts` (and their tests) are still present.
- `docs/product/backlog.md` statuses still read "Ready" or "Not started" for P3-00…P3-09.
- `phase3-journey.spec.ts` returns early in the members step when the shared account isn't an owner or admin. Invitations through the UI are covered only by QA's J5.

### Round 2 test changes (test files only)

- `web/e2e/phase3-qa-verification.spec.ts`: added R2a–R2f (round 2 re-checks), J13 (row-link probe) and J14 (report pages). Removed two unused helpers that triggered lint warnings.
- QA scratch scripts (outside the repo): `qa/r2_proposals.py`, plus `qa/tenancy.py` pointed at the round 2 project.

---

## Round 1 verdict: FAIL

The core of Phase 3 works and is safe:

- rule-based test design from the approved strategy
- open questions that block approval and G5
- member approval of single cases versus `can_approve` for G5
- G5 reopen on change, traceability with honest "Not available" Phase 4 data
- frozen, credential-free TCS and RTM reports
- hashed one-time invitations with session revocation on removal
- 404s across organisations

It fails on five points:

1. **Accepting an assistant proposal returns 500 and leaves a half-applied change** (BUG-P3-01). This is a data-integrity defect in a P1 story.
2. **No generated case can be edited and saved without inventing expected results for setup steps** (BUG-P3-02). This breaks the D6 "write the expected result" path that unblocks G5.
3. **G5 can't be approved on the demo shop with the rule output alone** (BUG-P3-03). The P3-09 demo journey "through G5" isn't achievable without a hand-written case or a risk acceptance.
4. **"Generate more negative test cases" can never produce a proposal on real data** (BUG-P3-04). P3-06 AC1 is unmet.
5. **The Test Case Specification report page crashes** with a runtime TypeError whenever any case has no requirement (BUG-P3-21). That is a state the design explicitly allows (check 30).

In addition, the developer's own `phase3-journey.spec.ts` fails at step 4 on every run, so its last four steps (G5, traceability, reports, members) never execute.

## Suite counts

| Suite | Command | Result |
|---|---|---|
| Backend tests | `cd backend && uv run pytest -q` | **251 passed**, 0 failed (3 min 21 s) |
| QA backend tests (new) | `uv run pytest tests/unit/test_qa_p3_ai_validation.py` | **5 passed** |
| Backend lint and types | `ruff check`, `ruff format --check`, `mypy app` (strict) | clean (164 files formatted, 136 source files type-clean) |
| Web types and lint | `npx tsc --noEmit`, `npm run lint` | clean |
| Web unit | `npx playwright test --project=unit` | **103 passed** |
| Web mocked UI | `npx playwright test --project=ui-mocked` | 77 tests. With `--workers=2`: 68 passed and 9 failed under load or from test-results folder collisions. All 9 passed when rerun serially. |
| Real-stack e2e, serial (`--workers=1`) | `auth`, `discovery-journey`, `phase1-full-journey`, `phase2-journey`, `phase3-journey` | See [Existing e2e specs](#existing-e2e-specs). **Two specs fail on every run.** |
| QA journey (new) | `P3QA_STATE=… P3QA_SHOTS=… npx playwright test e2e/phase3-qa-verification.spec.ts --project=e2e -g Jn --workers=1` | J1–J14 run step by step against one project. J1–J11, J13 and J14 passed. **J12 failed:** an axe soft-assert on the TCS report page (`document-title`, `html-has-lang` on `#__next_error__`, which is the Next.js error page from BUG-P3-21), then a 12-minute timeout waiting for `main` on that crashed page, so its final sideways sweep didn't run. Other product defects are recorded as state values and soft assertions. |

### Existing e2e specs

| Spec | Result | Notes |
|---|---|---|
| `auth.spec.ts` | 4/4 passed | |
| `discovery-journey.spec.ts` | Failed in the 5-spec serial run, then **2/2 passed** when rerun alone | Timing under load |
| `phase1-full-journey.spec.ts` | **1 failed** ("live feed populates without reload", 2.3 min) | <ul><li>Not rerun, because every run registers a new account and the per-IP register limit (5 per hour) was nearly used up.</li><li>The live activity feed worked in every QA journey step, so this is probably timing. A person should rerun it alone.</li></ul> |
| `phase2-journey.spec.ts` | **1 failed, 6 did not run**, reproduced alone | <ul><li>Step "P2-02/03/04", line 79: `link /^REQ-\d+/ first().click({ position: { x: 8, y: 8 } })` doesn't navigate, so `toHaveURL(/requirements\/REQ-/)` times out.</li><li>The same pattern fails in `phase3-journey`; see BUG-P3-19.</li></ul> |
| `phase3-journey.spec.ts` | **3 passed, 1 failed, 4 did not run**, reproduced alone | <ul><li>Step 4 "P3-01/02/03", line 138, has the same positioned click on the first `TC-` link. The page stays on `/test-cases`.</li><li>So the spec's G5, traceability, reports and members steps never ran.</li><li>Even when it gets that far, the G5 step returns early if G5 is blocked (BUG-P3-03), so it can't prove G5 on the demo shop.</li></ul> |

Logs (outside the repo): `scratchpad/e2e-real.txt`, `pw-out-p3j/`, `pw-out-rerun/`.

## Story acceptance (P3-00 to P3-09)

| Story | Result | Evidence |
|---|---|---|
| P3-00 Workflow foundation and legacy web removal | PASS WITH NOTES | <ul><li>`test_design` before G4 returns 409. While the strategy is still running, the message is "Test strategy and test plan must finish first"; once it is awaiting approval, it is "Test strategy approval (G4) must be approved first".</li><li>Running `traceability` returns 422 (derived stage).</li><li>Design starts automatically after G4 (J2).</li><li>G5 policy is `required` on new projects.</li><li>G4 re-approval marks design and traceability stale with "Strategy changed after these test cases were designed". The sidebar, lifecycle and page callout show "Out of date" (J12).</li><li>Legacy screens are deleted. `/test-cases/x` shows the app 404, `lib/types.ts` is gone, and nothing links to the old routes.</li><li>Notes:<ul><li>The superseded design run 1 is still listed as `awaiting_approval` (BUG-P3-17).</li><li>"Started automatically after Gate 4 approval" only shows while running (BUG-P3-16).</li></ul></li></ul> |
| P3-01a Test Design Agent, rule path | PASS WITH NOTES | <ul><li>Run 1 produced 39 cases, 20 conditions and 20 data items.</li><li>EP and BVA use 0 and 1 characters with "Constraint: required (…)". There is no upper-boundary case without `maxlength`, and the note "No maximum length was discovered…" is present.</li><li>Sign-in has a 6-rule decision table and a state transition including "after failed attempt". The open question is TC-0006 on REQ-0007.</li><li>Security, performance and the other excluded types are listed under not-designed.</li><li>Every case is `not_run`. No credentials appear anywhere.</li><li>Fixture BVA 80/81 and 79/80/81 are covered only by the developer's unit tests (not observable on the demo shop).</li><li>Defects:<ul><li>TC-0018 has a wrong expected result (BUG-P3-06).</li><li>REQ-0013 can never be covered (BUG-P3-03).</li><li>Generated setup steps have no expected result, which the web form rejects (BUG-P3-02).</li></ul></li></ul> |
| P3-01b AI path and regeneration review | PASS WITH NOTES (AI path untested live) | <ul><li>AI is off in this environment. The developer's suite had **no test of the AI validation path**. QA added `test_qa_p3_ai_validation.py` (5 passed):<ul><li>an untraceable 1001-character boundary is dropped</li><li>85 is dropped and 81 is kept</li><li>an unknown partition is dropped</li><li>a backend claim is capped at `inferred`</li><li>an unknown requirement is dropped</li></ul></li><li>Regeneration (live, J8):<ul><li>A second run while a review is pending returns 409.</li><li>The review lists protected items with default "Keep current".</li><li>Rejected TC-0010 is left out.</li><li>Apply works and lands on `?changed=1`.</li></ul></li><li>"Approved and no longer found → keep" has no test anywhere.</li></ul> |
| P3-02 Test case management and G5 | **FAIL** | <ul><li>Works:<ul><li>PATCH of code-owned fields returns 422. DELETE returns 405 (`Allow: GET, PATCH`), and the UI has no Delete control.</li><li>Deprecate needs a comment and works only from Approved. Reject needs a reason. A locked case returns 409, and so does a stale version.</li><li>An open question blocks case approval and G5, even on a draft (D6).</li><li>A member without `can_approve` approved TC-0006 and bulk-approved 38 (TC-0040 skipped with its reason). That member got 403 on G5, with the buttons disabled and the reason shown (D2).</li><li>A `can_approve` member approved G5 in the UI: "Approve with 1 draft?" then "Gate 5 approved." (D1).</li><li>Editing an approved case reopens G5, with the warning copy and a one-time toast, and the panel shows "Changes since approval: 1".</li></ul></li><li>Fails:<ul><li>BUG-P3-02 (edits can't be saved)</li><li>BUG-P3-03 (G5 blocked on the demo shop)</li><li>BUG-P3-05 (the new-case form defaults to an invalid technique)</li><li>BUG-P3-07 (the requirement page doesn't show the waiting case)</li><li>BUG-P3-08 (no "Save and reopen review" warning)</li><li>BUG-P3-15 (disabled Approve isn't focusable)</li></ul></li></ul> |
| P3-03 Test data management | PASS WITH NOTES | <ul><li>All synthetic-guard messages match the contract. A real-looking email is refused.</li><li>The 1-character boundary edit gets "This item tests the 1-character boundary; change the case instead."</li><li>Retire while in use returns 409, and the dialog lists TC-0012 and TC-0042 with "Show these cases".</li><li>The password item says the value is never shown. No mask or asterisks are in the DOM.</li><li>Notes:<ul><li>The data-item API has no `form` or `used_by[].status`. Headings show a raw anchor (`form:/contact:contact us (/contact)`), and editing an item used by an approved case gives no warning (BUG-P3-08).</li><li>The notice wording differs from design check 61.</li></ul></li></ul> |
| P3-04 Traceability | PASS WITH NOTES | <ul><li>Coverage tiles equal `/traceability/coverage`. Requirements show 19 of 21, ACs 21 of 26, high risks 5 of 5. Execution coverage reads "Not available" and is never 0.</li><li>Gaps are split into "No test case at all" and "none approved". An empty list says what it means. The four Phase 4 lists are `available: false` and read "Available after test execution (Phase 4)."</li><li>The matrix is a table with a caption. At 375 and 320 px it becomes cards with no sideways scroll, each ending "Scripts, results, defects: not available until Phase 4".</li><li>The chain view for TC-0013 shows requirement, AC, condition, case and risk, with level names.</li><li>`basis=approved` returns the G5 snapshot through the API, and 404 before any G5.</li><li>Notes:<ul><li>After G5 reopens, the UI disables "Last approved" even though a snapshot exists (BUG-P3-18).</li><li>Coverage has no `approved_at` (BUG-P3-08).</li></ul></li></ul> |
| P3-05 Risk-based prioritisation | PASS | <ul><li>An override with no reason, or a blank one, returns 422. The UI shows "Explain why this case needs a different priority."</li><li>With a reason, the case shows "set by Quinn Owner: 'Low traffic path in this release'", "Risk-based priority: High (RISK-003)" and the advice "Priority lower than its risk".</li><li>Re-rating RISK-003 recalculated 12 cases (high to critical) with no case version bump and no G5 reopen. The feed says "Risk-based priority changed on 12 test case(s)".</li></ul> |
| P3-06 AI QA Analyst v2 | **FAIL** | <ul><li>Read intents work:<ul><li>coverage, with counts equal to coverage</li><li>explain</li><li>trace</li><li>gate</li><li>execution returns `no_execution_data`</li><li>an unknown TC citation is removed</li></ul></li><li>The viewer sees proposals read-only.</li><li>The regression proposal (PROP-0001) is rule-based and tags TC-0041.</li><li>Accepting it returns **500 and partly applies** (BUG-P3-01).</li><li>"Generate more negative test cases" never yields a proposal (BUG-P3-04).</li><li>"Update test cases" and "Suggest missing test cases" are missing from Needs AI. Regression items have no reason.</li></ul> |
| P3-07 Members and roles | PASS WITH NOTES | <ul><li>Invitation tokens:<ul><li>The token is 32 bytes and stored only as SHA-256, with a 7-day expiry.</li><li>No raw token is in the DB, the WAL or the audit metadata.</li><li>A revoked or reused link returns 404 "This invitation is no longer valid".</li></ul></li><li>An existing account returns 409, and the UI explains multi-workspace accounts. A duplicate pending invitation returns 409. A viewer with `can_approve` returns 422.</li><li>The last-owner guard returns 409. Admins get 403 on owners, and the UI disables those rows with "Only owners can change or remove an owner".</li><li>A role or `can_approve` change applies on the next request. Removal revokes sessions (401), and authored items keep the name.</li><li>The viewer's members page is read-only with no emails. The non-approver copy is correct for member, viewer and admin.</li><li>"Link copied" is announced.</li><li>Note: the close-without-copying confirm has two buttons named "Close" (BUG-P3-11).</li></ul> |
| P3-08 Reports | **FAIL** | <ul><li>The TCS and RTM appear in the list. Download offers PDF, HTML (single file) and CSV only (D4).</li><li>Before G5 they carry "DRAFT"; on approval they are frozen as "Approved at G5 by QA Memapp".</li><li>Counts equal `/test-cases/stats`.</li><li>CSV has a BOM, and the formula guard turns a title of `=HYPERLINK(…)` into `'=HYPERLINK…`. HTML is escaped.</li><li>Downloads use `Content-Disposition: attachment`. CSV on `test_plan` returns 422.</li><li>No credentials in any format (PDF text extracted with pypdf).</li><li>**The TCS report page in the web app crashes** ("Cannot read properties of null (reading 'key')") because TC-0040 has no requirement (BUG-P3-21). The RTM page renders, with "Approved at Gate 5" and "Not available" Phase 4 columns, and no sideways scroll at 375 or 320 px (J14).</li><li>Note: the TCS CSV has one row per case per requirement group, 50 rows for 41 cases (BUG-P3-12).</li></ul> |
| P3-09 End-to-end verification and close | **FAIL** | <ul><li>The developer's `phase3-journey.spec.ts` fails at step 4 on every run, and returns early at G5 when blocked.</li><li>There is no developer e2e that accepts invitations through the UI (QA's J5 does).</li><li>The legacy `api/` routes and tests for test cases, the assistant and the workspace are still present.</li><li>The backlog statuses weren't updated.</li><li>The cross-tenant suite passes (QA script: 41 Phase 3 endpoints return 404 to another organisation).</li></ul> |

## Design acceptance checks (P3 design §22)

Legend: PASS, FAIL, PARTIAL, N/T (not testable here).

| # | Check (short) | Result | Evidence |
|---|---|---|---|
| 1 | Sidebar shows Test Cases and Traceability with no badge; legacy `/test-cases/x` is the app 404 | PASS | J12 `j12-legacy-404.png`, sidebar text |
| 2 | "Waiting for your approval" for approvers; non-approver copy for the others | PASS | J5 member overview, J6 approver overview, J11 viewer and admin |
| 3 | Lifecycle steps 13 and 14 and a G5 diamond "Test case quality"; step 14 never "Running" | PASS | `j12-lifecycle-all-steps.png`: step 14 is "Traceability matrix · Computed, no agent" |
| 4 | Unique "Review Gate n" link names | PARTIAL | Only "Review Gate 2" was present when checked (G3–G5 approved). No duplicate names were seen anywhere. |
| 5 | Step 13 row and feed say "Started automatically after Gate 4 approval." | FAIL (minor) | Only shown while the stage is running; afterwards the feed says "Queued/Started…" (BUG-P3-16) |
| 6 | Before G4: "Test cases are designed from the approved Test Strategy. Approve Gate 4 first." with Review Gate 4 | PASS | J2 pre-G4 text |
| 7 | AI off: "Generated by rules", no "AI-generated" label | PASS | Header "Generated by rules (AI not configured)" |
| 8 | Not-designed types named with "…designed in Phase 5." | PASS | `j8-list.png`: "Not designed in Phase 3: Sanity, Exploratory, Security, Performance, …" |
| 9 | G4 re-approved: "Out of date" in sidebar, lifecycle and callout; cases editable | PASS | J12 sidebar "Test Cases · Out of date … Traceability · Out of date", callout "Test cases may be out of date" |
| 10 | Row shows every column and "Not run yet"; no pass/fail | PASS | J8 list row and header |
| 11 | Filters in URL and chips; Back restores | PASS | J8 `filterUrls` |
| 12 | Group by Requirement with counts and "Not linked to a requirement" | PASS | `j8-group-by-requirement.png` |
| 13 | Bulk approve skips cases with reasons; toast with Undo | PASS | J5: "Approve 38", TC-0040 skipped with "2 checks you must fix"; toast "38 test cases approved. 1 skipped. Undo · Show skipped" |
| 14 | Viewer sees none of the write controls | PASS | J11: 0 checkboxes, New case, Regenerate, Edit, Approve or Set priority |
| 15 | 375 and 320 px: cards, filter sheet, no sideways scroll | PARTIAL | No sideways scroll on traceability, members and RTM at 375 and 320 px. The list sweep didn't run (J12 timed out on BUG-P3-21). |
| 16 | Name BVA values with constraint and evidence link; "No maximum length…" note | PARTIAL | Values, constraint and note are present. No evidence link: the backend puts `evidence_refs` at the top level, but the web reads `design_basis.evidence_refs` (BUG-P3-08). |
| 17 | Fixture `maxlength=80`: 80/81 and 79/80/81 | N/T live | Developer unit tests and QA `test_ai_boundary_must_be_a_computed_value` |
| 18 | Every coverage item row has a constraint line | PASS | `j3-tcond0006.png` |
| 19 | "␣␣␣ (3 spaces)" rendering | N/T | No such value on the demo shop |
| 20 | Reject condition with 2 drafts names both | N/T | No condition had 2 drafts. The single-case wording was correct (`j8-condition-reject-dialog.png`). |
| 21 | All §7 fields visible with labels | PASS | `j3-tc0006-open-question.png`, `j6-new-case-created.png` |
| 22 | "Last result: Not run yet", "Execution arrives in Phase 4.", no Run button | PASS | Detail pages |
| 23 | Automation suitability with reason and "Preliminary: assessed in Phase 4." | PASS WITH NOTE | Line printed twice (BUG-P3-16) |
| 24 | Approve focusable but disabled, with reason | FAIL (minor) | Native `disabled`, so not focusable (BUG-P3-15). Reason shown; no dialog opens. |
| 25 | Edit an approved case: warning, Draft, G5 waiting, toast once | PASS | J7: "Saving moves it back to Draft. Gate 5 will need approval again." The toast appears once and the second save didn't repeat it. |
| 26 | Step editor by keyboard: focus stays, move announced | PASS | J4: focus on "Move step 3 down", status "Step 2 moved to position 3" |
| 27 | Empty step expected result: message, focus, error summary | PASS | J4: "Fix these … before saving", focus on step 2's expected field |
| 28 | Conflict callout, text kept, Compare | N/T in UI | API 409 on a stale version was verified |
| 29 | Read-only fields with help text | PARTIAL | Seen in `j4-write-expected-form.png`; not asserted field by field |
| 30 | New manual case without a requirement: Draft, Assumed, "Written by a person", Must fix | PARTIAL | Saved after choosing a technique by hand. The default "Other" technique fails with a raw pydantic message (BUG-P3-05). |
| 31 | Deprecate with reason, kept in traceability, no Delete anywhere | PASS | "Deprecated by Quinn Owner…: Duplicate of TC-0015. Kept for traceability and history." 0 Delete controls |
| 32 | Open-question callout, "Not decided: REQ-…" linking, Approve disabled | PASS WITH NOTE | Copy says "Not decided: Not decided: REQ-0007…" (BUG-P3-16) |
| 33 | Write expected result: focus in the empty field; on save the question clears and becomes Assumed, "Written by a person" | PASS only with a workaround | Focus lands in the empty field. Saving needs invented expected results for steps 2–4 (BUG-P3-02). |
| 34 | Requirement page: "1 test case is waiting for this answer: TC-00nn." | FAIL | REQ-0007 shows "Linked test cases (0)" (BUG-P3-07, `j3-req0007-waiting-case.png`) |
| 35 | "High · from RISK-00n (High, score n)" with a link | PASS WITH NOTE | Detail shows "Risk-based priority: High (RISK-003)". The list reads "High from a High risk". |
| 36 | Override needs a reason; shows "set by {name}: '{reason}'" | PASS | J8. Copy differs: "Explain why this case needs a different priority." |
| 37 | Risk re-rated: priorities update, no revision, no reopen | PASS | API and feed |
| 38 | Test data grouped form → field, kind, value, length, used by, notice | PARTIAL | Form heading is a raw anchor (BUG-P3-08). Notice wording differs (BUG-P3-16). |
| 39 | Password item: "Uses the saved test account (value never shown)", no mask in DOM | PASS | `dataDomHasMask=false`, credential scans clean |
| 40 | Real email is refused with the message and focus | PASS | `j8-td-real-email.png` |
| 41 | Boundary length locked | PASS (demo equivalent) | "This item tests the 1-character boundary; change the case instead." |
| 42 | Item used by an approved case: warns, "Save and reopen review" | FAIL | No warning; the button reads "Save" (BUG-P3-08, `j8-td-edit-used-by-approved.png`) |
| 43 | Retire in use: lists cases, Show these cases, nothing retired | PASS | "TD-0006 is used by TC-0012 and TC-0042…" |
| 44 | Regeneration review: protected kept, rejected left out | PASS (adapted scenario) | J8 `j8-change-review.png`. "Approved and no longer found" wasn't reachable. |
| 45 | Regenerate with a pending review says so up front | FAIL (minor) | The dialog doesn't mention the pending review; the backend returns 409 after confirming (BUG-P3-16) |
| 46 | G5 lists open question and uncovered risk with unique links; Approve disabled | PASS | `j3-g5-blocked.png`: "Must fix before approval (3)", "Fix the 3 items…" |
| 47 | "Quality checks by type" grouped, with filtering links | PASS | `j3-g5-blocked.png` (Must fix, Advice) |
| 48 | Member without `can_approve`: buttons disabled, callout, no dialog; can approve single cases | PASS | J5 |
| 49 | Approver: "Approve with n drafts?", toast, focus moves | PASS | J6: "Approve with 1 draft?", "Gate 5 approved.", focus on the "Approved by QA Memapp…" line |
| 50 | After G5, an edit shows "Changes since approval: 1" and Compare | PASS | J7 `j7-g5-reopened.png`, `j7-compare-approved.png` |
| 51 | Accepting the risk clears the blocker and lists "Accepted risks" | N/T | G5 was unblocked with a manual case instead |
| 52 | Coverage tiles equal the API; execution "Not available" | PASS | J7 and API comparison |
| 53 | Gap lists split; Phase 4 lists have no count | PASS | J7 coverage text |
| 54 | Empty gap list explains itself | PASS | "None. Every approved requirement has an approved test case." |
| 55 | Matrix table with caption and row headers; Phase 4 "—" | PASS | aria: `table "Forward traceability…"` with caption |
| 56 | 375 px cards, no sideways scroll, Phase 4 line | PASS | `traceSideways` 0 at 375 and 320 |
| 57 | "Last approved" disabled before any G5 with the reason | PASS, but see BUG-P3-18 | Also disabled after G5 has been approved once and reopened |
| 58 | Chain view with level names and links | PASS | `j7-chain-tc0013.png` |
| 59 | Reports list TCS and RTM; Download offers PDF, HTML, CSV only | PASS | J12 download menu: "PDF · HTML (single file) · CSV (spreadsheet)". **But the TCS page itself crashes** (BUG-P3-21). |
| 60 | DRAFT before G5; approver and date after | PASS | `p3-downloads/approved-*` |
| 61 | No credentials; appendix says "Saved logins are named, never shown." | PASS WITH NOTE | No credentials. Notice wording differs. |
| 62 | Works-without-AI and Needs-AI groups | FAIL (minor) | "Update test cases" and "Suggest missing test cases" are missing (BUG-P3-13) |
| 63 | Negative proposal shows steps, data, label, constraint; Add n | FAIL | No proposal is ever produced (BUG-P3-04) |
| 64 | All derivable negatives exist: the exact answer, no card | PASS | Exact copy, but it is always this answer (BUG-P3-04) |
| 65 | Regression proposal lists Add and Remove, each with a reason | FAIL (minor) | No reason per item (BUG-P3-14). Applying returns 500 (BUG-P3-01). |
| 66 | Viewer: proposals without Apply or Reject, with the copy | PASS | J11 |
| 67 | Invite link shown once with expiry; "Link copied"; close confirm | PASS WITH NOTE | Two buttons named "Close" (BUG-P3-11) |
| 68 | Existing account: explanation | PASS | "This email already has an account. Multi-workspace accounts aren't supported yet…" |
| 69 | Only owner: Remove and role change disabled with the reason | PASS | API 409, UI disabled |
| 70 | Changing your own role warns | N/T | Needs two owners |
| 71 | Admin: owner rows disabled, Owner not offered | PASS | J11 `j11-admin-members.png` |
| 72 | Member or viewer: read-only, no emails, no buttons | PASS | Only "What each role can do" (a disclosure) and the account menu |
| 73 | Accept page shows organisation, inviter, role; accepting signs in; reuse is refused | PASS | J5 (UI accept), API reuse and revoke returns 404 |
| 74 | Granted `can_approve` takes effect on reload | PASS | J6 and API |
| 75 | axe clean on every Phase 3 screen | PASS WITH EXCEPTION | No serious or critical violations on any working screen in J1–J14. The only violations were on the TCS report crash page (BUG-P3-21). |
| 76 | Keyboard: every action reachable; closing detail returns focus to its row | PARTIAL | Back from detail puts focus on the "Test Cases" h1, not the row (J12 `focusAfterBack`) |
| 77 | 200%/400% zoom and 320 px | PARTIAL | 320 px only, on traceability, members and RTM |

## Bugs (most severe first)

### BUG-P3-01: Accepting an assistant proposal returns 500 and partly applies (BLOCKER)

- **Steps:**
  1. In the AI QA Analyst, run "Generate regression scenarios" (any scope). You get a proposal such as PROP-0001.
  2. As owner, press Accept.
  3. Alternatively, run the same through the API: `POST /projects/{id}/assistant/proposals/{pid}/accept`.
- **Expected:** all items are applied in one transaction. The proposal becomes `accepted`, G5 reopens, and `assistant.proposal_accepted` is audited.
- **Actual:** HTTP 500. Seen live as request `7d4c385245b94c1d9c556e9d7dd0b9f5` (PROP-0001) and `5645243553aa4657a617c89f684627f4` (PROP-0002).
  - The first case's patch is **already committed**. PROP-0002 tagged TC-0006 and left the other 9 cases unchanged.
  - The proposal stays `pending`, then later turns `stale`. No accept audit is written.
  - The in-process traceback is `sqlalchemy.exc.MissingGreenlet`, raised by an expired attribute access after a commit.
- **File:**
  - `backend/app/services/assistant_p3.py:451`: `out.artefact_ref(pr.project_id, …)` after `patch_case` commits.
  - It is reached from `backend/app/services/assistant.py:466` and `:484`.
  - The `add_test_cases` branch reads `pr.project_id` after commits too, so it probably fails the same way. It couldn't be reached live because of BUG-P3-04.
- **Note:** none of the developer's tests accept a P3 proposal against a session that commits.

### BUG-P3-21: The Test Case Specification report page crashes when any case has no requirement (MAJOR)

- **Steps:**
  1. Have a case with no requirement. A manual case saved without one is allowed by design check 30; here it is TC-0040.
  2. Open Reports, then Test Case Specification (`/projects/{id}/reports/test-case-spec`).
- **Expected:** the report renders, with the unlinked case under "Not linked to a requirement".
- **Actual:** Next.js "Runtime TypeError: Cannot read properties of null (reading 'key')". No `main` is rendered, and axe flags the error page. The download menu on the Reports list still works, and the RTM page renders.
- **Evidence:** J12 error context (`pw-out/phase3-qa-verification-J12-…/error-context.md`), J14 `j14-report-test-case-spec.png`
- **File:** `web/src/components/report/Phase3Report.tsx:206-209`. It does `r.requirement.key` and `r.requirement.label` with no null guard; the report JSON groups unlinked cases under a `null` requirement.
- **Note:** this is the same class of defect as BUG-P2-06. The developer's `phase3-journey` reports step would have caught it, but it never runs (BUG-P3-19).

### BUG-P3-02: Generated cases can't be saved after any edit (MAJOR)

- **Steps:**
  1. Open TC-0006 (the open question) and press "Write expected result".
  2. Type the expected result and press Save changes.
- **Expected:** it saves. Setup steps such as "Open /contact" need no expected result, and the server lint accepts them.
- **Actual:** "Fix these 3 before saving: Describe the expected result for step 2/3/4." Every generated case has setup steps with an empty expected result, so **no generated case can be edited** unless the user invents text for those steps. The read view also flags "Missing expected result" on them.
- **Screenshot:** `j4-save-blocked-setup-steps.png`
- **File:** `web/src/lib/testcases.ts` `validateCaseForm` (around line 557), which requires `expected` on every step. It is out of line with the backend lint in `backend/app/domain/testdesign/`.

### BUG-P3-03: Gate 5 can never be approved on the demo shop from the rule output (MAJOR)

- **Steps:**
  1. Run the full AI-off journey on the demo shop.
  2. Answer the open question and approve every case.
  3. Open G5.
- **Expected:** G5 can be approved (roadmap P3-09: "Full AI-off journey on fixture and demo through G5").
- **Actual:** the `high_risk_covered` blocker stays on. REQ-0013 "Sign-in credentials are only sent over HTTPS" is a security requirement, so the rules design no case for it, but it is linked to the open High RISK-003. The only ways out are a hand-written case (QA created TC-0041) or accepting the sign-in risk.
  - The developer's demo test only approves observed or inferred requirements.
  - `phase3-journey.spec.ts` returns early when G5 is blocked.
- **File:** `backend/app/domain/testdesign/generate.py`. Either design a non-security check for transport requirements (an inferred "form posts to https" case), or have the G5 risk blocker ignore requirements whose only types are not designed.

### BUG-P3-04: "Generate more negative test cases" never produces a proposal (MAJOR)

- **Steps:**
  1. In the assistant, run "Generate more negative test cases" for REQ-0003, REQ-0004, REQ-0005, REQ-0006 or REQ-0011.
- **Expected:** a non-duplicate proposal with computed data (P3-06 AC1, design check 63), for example the "leading/trailing spaces" item from the spec's negative catalogue.
- **Actual:** always "No further negative test cases can be derived from the discovered constraints." The intent reruns the rule design and only proposes cases that are missing. The catalogue items beyond the rule design aren't implemented. The backend test only gets a proposal by deleting a case directly in the DB.
- **File:** `backend/app/services/assistant_p3.py` (negative-cases intent)

### BUG-P3-05: The new manual case form defaults Technique to "Other" and fails with a raw validation message (MAJOR)

- **Steps:**
  1. Go to Test cases, then New test case.
  2. Fill in title, objective, steps and requirement, and save without touching Technique.
- **Expected:** a valid default, or a plain-language field error.
- **Actual:** Technique "Other" has the value `""`. The API returns 422 and the UI shows "Input should be 'equivalence_partitioning', 'boundary_value_analysis', …".
- **Screenshot:** `j6-new-case-other-technique-error.png`
- **File:** `web/src/lib/testcases.ts:233`; `web/src/components/testcases/TestCaseDetail.tsx` (around line 889)

### BUG-P3-06: TC-0018 expects an invalid email to be accepted (MINOR/MAJOR)

- **Steps:** open TC-0018 "Email with 1 character".
- **Expected:** a BVA on `required` for a `type=email` field uses a valid 1-character-local email, or isn't generated.
- **Actual:** the value is "s", and the expected result is "Email is accepted without a validation message". The browser rejects "s" for `type=email`, so this case will fail in Phase 4 for the wrong reason.
- **File:** `backend/app/domain/testdesign/generate.py` (BVA on `required` applied regardless of input type)

### BUG-P3-07: The requirement page doesn't show the case waiting for its answer (MINOR)

- **Steps:** open REQ-0007 (the open question about Message).
- **Expected:** "1 test case is waiting for this answer: TC-0006." (design check 34).
- **Actual:** "Linked test cases (0)".
- **Screenshot:** `j3-req0007-waiting-case.png`
- **File:** `web/src/components/testcases/LinkedCases.tsx`. It filters on `requirement_keys`, but the open-question requirement isn't in that list. It is only in the open-question data.

### BUG-P3-08: API fields the web expects are missing (MINOR)

| API object | Missing fields |
|---|---|
| Case summary | `risk_key`, `feature`, `condition_key`, `changed_in_latest`, `objective` |
| Case detail | `priority_source.overridden_at` |
| Data item | `form`, `used_by[].status` |
| Coverage | `approved_at` |
| Condition | `design_basis.evidence_refs` (the backend sends top-level `evidence_refs`) |

**Visible effects:**

- Editing a data item used by an approved case gives no "moves back to Draft" warning, and the button reads "Save" instead of "Save and reopen review" (check 42).
- Test data form headings show the raw anchor `form:/contact:contact us (/contact)`.
- Conditions have no evidence link (check 16).

**File:** `backend/app/services/serialize_p3.py` and `backend/app/schemas/api.py`, versus `web/src/lib/testcases.ts` types.

### BUG-P3-11: Two buttons named "Close" in the close-without-copying confirm (MINOR, a11y)

The dialog's X button and the confirm's "Close" button have the same accessible name. Found in `web/src/components/settings/Members.tsx` (around line 335).

### BUG-P3-12: The TCS CSV has duplicate rows (MINOR)

There is one row per case per requirement group: 50 rows for 41 cases, with duplicate keys. The contract says one row per case.

**Download:** `p3-downloads/approved-test_case_spec-v1.csv`

### BUG-P3-09: Server-side search covers only key and title (MINOR)

`q` on `/test-cases` searches the key and title only (`backend/app/api/routers/testdesign.py:414-416`). The web placeholder and contract imply it also searches the objective and step text.

### BUG-P3-10: The retire 409 shape doesn't match the web (MINOR)

The web reads `details[].key`; the backend sends `details[0].cases`. The dialog still lists the cases through a fallback.

### BUG-P3-13: Needs-AI tasks are missing (MINOR, check 62)

"Update test cases" and "Suggest missing test cases" aren't listed.

### BUG-P3-14: Regression proposal items have no reason (MINOR, check 65)

Items read "TC-0041: no suite → regression" with no reason. The proposal title shows the raw scope key: "(high_risk)".

### BUG-P3-15: The disabled Approve button isn't focusable (MINOR, a11y, check 24)

It uses native `disabled` instead of `aria-disabled`, so keyboard users never reach it and its reason.

### BUG-P3-18: "Last approved" basis is disabled after G5 reopens (MINOR)

- **Steps:**
  1. Approve G5.
  2. Edit an approved case so that G5 reopens.
  3. Open Traceability.
- **Expected:** "Last approved (Gate 5)" is still available. The API returns the snapshot with `basis=approved`.
- **Actual:** it is disabled with "Available after Gate 5 is approved."
- **Screenshot:** `j7-trace-matrix-current.png`
- **File:** `web/src/app/(app)/projects/[id]/traceability/page.tsx:175`. It uses `gateApproved(current gate status)` instead of "a G5 snapshot exists".

### BUG-P3-19: The first list-row link click is lost on a just-finished project (MINOR, unconfirmed product impact)

- **Steps:** `phase2-journey.spec.ts:79` and `phase3-journey.spec.ts:138`. Click the first `REQ-`/`TC-` link at (8, 8) right after the stage finishes.
- **Expected:** it navigates to the detail page.
- **Actual:** it stays on the list. This reproduces on every run on fresh projects. On the settled QA project the same click navigates (J13).
- **Likely cause:** the row is re-rendered by the live feed refresh right after the run finishes, so the click is lost. A human should check whether real users can lose a click in that window.
- **Effect:** the developer's journey specs can't pass, so their claimed e2e green isn't reproducible.

### BUG-P3-16: Copy (MINOR)

- "Not decided: Not decided: REQ-0007 …" (duplicate prefix).
- "Preliminary: assessed in Phase 4." is printed twice on the case detail.
- The change review diff shows raw JSON steps with UUIDs.
- The coverage-item button reads "TD-0007 (len:0)".
- Lowercase toast: "test design is waiting for your approval".
- The test-data notice wording differs from checks 38 and 61.
- Check 45: the Regenerate dialog doesn't say a review is already pending.
- Check 5: "Started automatically after Gate 4 approval" only shows while the stage is running.
- The priority override error reads "Explain why this case needs a different priority." The design says "Explain why you changed the priority."

### BUG-P3-17: The superseded design run is still `awaiting_approval` (MINOR)

After regeneration was applied, run 1 is still listed as `awaiting_approval`.

### BUG-P3-20: P3-09 close-out incomplete (MINOR, process)

- The legacy `api/` routes and tests are still present (`assistant.ts`, `workspace.ts`, `testing.ts`, and the scan-checks tests), although P3-09 says they are removed.
- There is no developer e2e for accepting invitations through the UI.
- The backlog statuses still read "Not started" for P3-03…P3-09.

## Safety checks

| Check | Result |
|---|---|
| Cross-tenant | 41 Phase 3 endpoints (cases, conditions, data, runs, review, traceability ×4, reports, assistant threads and proposals, members, invitations) return 404 to another organisation. Membership ids from another organisation return 404. |
| Roles | Viewer writes return 403. Member G5 approval returns 403. Admin on owner rows returns 403. A role change applies on the next request. |
| Invitations | SHA-256 hash only, 32-byte token, 7-day TTL. Single use: reuse and revoke return 404. The raw token is absent from `qa.db`, the WAL and audit metadata. |
| Credential absence | Demo-shop username and password were absent from `qa.db`, the WAL, 1,234 storage files, 154 API responses, every report download (PDF via pypdf) and the test-data DOM. |
| Session revocation | Removing a member makes their token return 401 immediately. Their name stays on authored items. |
| CSV/HTML injection | The formula guard prefixes `'`. A title of `=HYPERLINK("http://x.invalid","click")` is escaped in HTML and has no live link. |

## UX notes

- The open-question flow (callout, disabled Approve, G5 blocker, write expected result) is easy to follow, apart from BUG-P3-02.
- Bulk approve with skipped reasons and Undo is clear and fast.
- Traceability is the strongest screen. The honest "Not available (Phase 4)" handling, the split gap lists and the mobile cards all work well.
- With AI off, the assistant's task panel makes it clear what needs AI. The negative-cases task, though, looks broken to a user, because it always says nothing can be derived.
- Members:
  - The invitation dialog's "shown only once" message is clear, and copy is announced.
  - The role help disclosure is useful for viewers.

## Not covered

| Area | Why |
|---|---|
| AI-on design, AI proposals, injection isolation live | AI disabled. Validation is covered by QA unit tests only. |
| Fixture-site BVA (80/81, 79/80/81, 9/10) live | Covered by developer unit tests; not on the demo shop |
| "Approved and no longer found" in regeneration | No test anywhere; not reachable on the demo shop |
| Invitation expiry live | Covered by a backend test |
| Conflict callout UI (28), own-role change (70), 2-draft condition reject (20), 3-space values (19), risk acceptance on G5 (51) | No data or second owner |
| 200% and 400% zoom (77) | Only 320 px width was checked |
| `phase1-full-journey.spec.ts` rerun | Register rate limit; a person should rerun it alone |
| Firefox, WebKit, screen readers | Chromium and axe only. VoiceOver on G5, the step editor and the members dialog should be checked by hand. |

## Test assets added (tests only, no product code changed)

| File | Purpose |
|---|---|
| `web/e2e/phase3-qa-verification.spec.ts` | Serial real-UI journey J1–J14 (G3 → G4 → design → open question → member and approver G5 → reopen → traceability → test data → regeneration → assistant → members → viewer/admin → lifecycle, reports, legacy 404; J13 row-link probe; J14 report pages). It reads the QA state file from `P3QA_STATE`. It never reads or writes `playwright/.auth/e2e-account.json` and never types the demo-shop login. |
| `backend/tests/unit/test_qa_p3_ai_validation.py` | 5 tests of P3-01b AI-case validation (`_ai_case`) without a model |

**Setup done for this verification:**

- Three accounts were registered: the QA owner, a second-organisation owner, and the one created by the auth spec.
- Members (Member, Member with `can_approve`, Viewer, Admin) were created only through invitation links.
- A temporary copy of the DB used to reproduce BUG-P3-01 in-process was deleted afterwards.
