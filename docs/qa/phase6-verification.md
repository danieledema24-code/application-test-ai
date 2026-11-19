# Phase 6 verification (P6-08)

- **Date:** 2026-11-18
- **Branch:** `phase-6` at `a594218` (P6-06), with the P6-08 changes uncommitted on top.
- **Author:** the developer who built P6-08. This is the developer's close-out record; QA verifies it independently.
- **Status:** P6-08 built, awaiting QA. The backlog marks it "Built, awaiting QA".
- **Secrets:** no password, token or demo login appears in this document or in any log quoted here. Private-stack
  credentials were kept only in `*.local.txt` files (mode 0600) in the session scratchpad.

## Stack used

Every real-stack run used a **private** stack. The user's preview servers (API :8200, demo shop :4100, web :3002)
were not started, stopped, restarted or flipped, `backend/data/qa.db` was not opened, and
`web/playwright/.auth/e2e-account.json` was not written (md5 unchanged, `c69df446…`).

| Piece | Private instance |
|---|---|
| Backend | `uv run uvicorn app.main:app --port 8230`, `DATABASE_URL` and `STORAGE_DIR` in the scratchpad (a fresh database for the final run), `AI_PROVIDER=disabled`, `ALLOW_PRIVATE_TARGETS=true`, `WEB_ORIGIN=http://localhost:3030`, inline worker. Migrations ran to `0021` on the empty database. |
| Web | a copy of `web/` (rsync, without `.next`, `node_modules` cloned) running `next dev -p 3030` with `NEXT_PUBLIC_API_URL=http://localhost:8230`. No `next build`, and nothing written to `web/.next`. |
| Demo shop | `demo-shop/server.mjs` on :4130 with its own `DEMO_VERSION_FILE` and `DEMO_ACCESS_LOG` in the scratchpad. |
| Accounts | an owner ("Erin Shared", approves gates), a member invited through the API, and an owner of a second organisation, created in the private database. |
| Browsers | Playwright Chromium from the scratchpad (`PLAYWRIGHT_BROWSERS_PATH`) for the web suites only. The backend and `scripts/check.sh` used their own. |
| Postgres / Redis | not used. Nothing touched ports 5432 or 6379 (the journey asserts it for its URLs). |

## Results

| Suite | Command | Result |
|---|---|---|
| Phase 6 journey (new), clean run | `npx playwright test e2e/phase6-journey.spec.ts --project=e2e --workers=1` with `E2E_API_URL=http://localhost:8230`, `E2E_SITE_URL=http://localhost:4130/`, `WEB_URL=http://localhost:3030`, `DEMO_VERSION_FILE`, `DEMO_ACCESS_LOG`, `P6_DB`, `P6_STORAGE_DIR`, `P6_STATE` | **10/10 passed** (1.9 min) on a fresh database, fresh accounts and no state file. Earlier runs on a first private database were used to fix the spec's selectors; their last resumed run was also 10/10. |
| Phase 6 closing suite (new) | `cd backend && uv run pytest -q tests/integration/test_p6_close.py` | **4/4 passed** (about 45 s): route list equals the app's Phase 6 routes; other organisation 404 everywhere; signed URLs bound to the organisation; no credential in any artefact or format. |
| `scripts/check.sh` (full, lead re-run after QA fixes) | `env -u PLAYWRIGHT_BROWSERS_PATH scripts/check.sh` | Backend ruff, ruff format, mypy --strict ok; backend pytest **1078 passed, 1 skipped** (22 min); web eslint ok, unit **248 passed**; automation tests, typecheck, eslint ok; pip-audit ok; npm audit web blocking 0 (two allow-listed postcss), automation blocking 0 (7 moderate; GHSA-fc5q-39xc-vjpf for picomatch is no longer reported, no dependency changed). Web tsc failed on one possibly-undefined in the lead's own edit to `phase6-journey.spec.ts`; fixed, then `tsc --noEmit` and eslint re-run clean. |
| Phase 1–5 journeys on release 1 | `npx playwright test e2e/auth.spec.ts e2e/discovery-journey.spec.ts e2e/phase2-journey.spec.ts e2e/phase3-journey.spec.ts e2e/phase4-journey.spec.ts e2e/phase5-journey.spec.ts --project=e2e --workers=1`, then `e2e/phase1-full-journey.spec.ts` (part 1, part 2), on QA's private stack (:8240/:3040/:4140), shop on release 1 | **38/38 passed** (7.7 min), and phase1-full-journey part 1 and part 2 passed. Two test-only fixes were needed first: `phase5-journey.spec.ts` now takes the shop host from `E2E_SITE_URL` (it hard-coded "localhost:4100"), and `phase1-full-journey.spec.ts` takes the API from `E2E_API_URL` and accepts the P6-01 rescan labels ("Rescan and compare…", "Start rescan", the compare toast) with 30 s click timeouts, so it fails instead of hanging. Defaults are unchanged. The developer's earlier run (34 passed, 1 failed, 3 not run; phase1 not run) predates these fixes. |
| QA independent re-run | Fresh private stack | Phase 6 journey **10/10**; `test_p6_close.py` **4/4**. Negative checks: an injected `POST /basket` in the exploration window fails step 5; a fake missing evidence id fails step 8; a planted password in an evidence file and a `change_items` row is found by the credential scan. AC→test table: all 142 references resolve to an existing test. |
| First GitHub Actions run | – | Will run when the phase PR is opened (CI triggers on `pull_request`); not yet recorded. `gh` isn't installed on this machine, so earlier runs (if any) couldn't be listed from here. |

### What the Phase 6 journey checked (clean run)

1. **Release 1, No-go.** The Phase 4 chain through the API (G2–G5, the empty-Message case run by the member and
   authorised by the approver, fails, DEF-0001 drafted, confirmed at G8 as major). REL-0001 recommends `no_go`;
   `exit.no_open_high_defects` is `not_met` naming DEF-0001; the first condition is "Fix or accept DEF-0001 (major)".
   The REL-0001 page shows No-go, DEF-0001 and the fixed release statement.
2. **Release 2, CHG-0001.** Before the rescan the harness takes an inventory (1 scan session, 6 discovered pages, 69
   evidence rows, 69 stored files). The version file flips to 2, the member starts the rescan, and CHG-0001 has exactly
   the nine items of the roadmap's demo chain (P6-01 list, including "Link removed: Travel mug"). The change set page
   shows the rows, the field and button renames and the change-detection statement.
3. **Impact.** The Contact scripts are outdated naming `getByLabel('Message') not found after CHG-0001`; the
   `/products/1` cases are "Page removed: /products/1. Review or retire TC-…"; `/offers` is a gap; the must-run list
   holds the empty-Message case with "Re-tests DEF-0001". The impact tab counts the same items as the API.
4. **Repairs, Gate 6, Gate 7.** The member accepts HEAL-0001 to HEAL-0003 one at a time in the UI (each card shows a
   High match, a confirmation, no bulk accept). Every Contact script's impact item resolves after validation; the
   case's expected result is unchanged. DEF-0001 is marked fixed, the member requests the recommended run, the approver
   authorises it in the Gate 7 panel, the empty-Message case **passes**, DEF-0001 is verified, and its must-run items
   close by themselves.
5. **EXP-0001.** Started from the Exploratory tab with the change-set charter preselected. The session completes; the
   shop's access log for the session holds 18 lines, all `GET`, none to `/basket` or `/offers/apply`, and includes
   `GET /offers`. `POST /basket` is listed as blocked, `Button "Apply code"` on `/offers` as not tried, the
   `uncaught_exception` and `broken_text` findings (medium) are on `/offers`, and the grouped draft is
   `/offers: "Show details" throws an error and shows NaN`. The session page shows the exploration statement and both
   lists. The draft's severity is set to minor with a reason and it is confirmed at Gate 8 in the UI.
6. **Conditional, G9, override.** The very high-risk sign-in cases run with the shop's saved test account, and the
   manual must-run re-tests are recorded (D37). REL-0002 is `conditional` with all four blocking criteria met; the
   conditions name the minor exploratory defect and "Page removed: /products/1". The approver approves it in the
   Gate 9 panel (final: Conditional). REL-0003 is overridden in the UI to Go: a 9-character reason is refused with
   "Write at least 20 characters…", then a longer one is accepted; the API shows final `go`, recommendation
   `conditional` and the reason.
7. **Reports.** The Release Readiness Report for REL-0003 reads "Go · Final" and carries the override reason; the
   Test Completion Report is generated from the UI for REL-0003, its passed/failed counts equal
   `traceability/coverage?basis=approved`, and it lists EXP-0001. Both pages download PDF (`%PDF-`), CSV (with the
   verdict, no email) and XLSX (zip) through the UI.
8. **History.** Comparing scan 1 with scan 2 again returns the same nine items. DEF-0001's release-1 evidence opens
   (200 through its signed URL; the defect page shows the image), and the Changes tab still lists CHG-0001. After the
   run there are 2 scan sessions, 12 discovered pages, 193 evidence rows and 193 stored files: every scan, page,
   evidence row and file from before the rescan is still there with the same size, and none was purged.
9. **Assistant (AI off).** "What changed?" answers with the change set and the change-detection statement; "Can we
   release?" cites REL-0003 and ends with the release statement.
10. **Harness.** The demo is back on release 1 (also enforced in `afterAll`, whatever happens).

axe (serious and critical, as soft assertions) was clean on every Phase 6 screen the journey opened.

### Go on the fixture

`backend/tests/integration/test_p6_release.py::test_fixture_project_with_every_criterion_met_is_go` (backend, seeded
evidence: approved requirement and criterion, G4 with its exit criteria and a high risk, G5, a passed run, clean
accessibility and security checks, a met load test and an exploratory session). There is no UI path that produces Go
on a real site without running every check, so this verdict is covered by the backend test only.

## Dependency audit: picomatch GHSA-fc5q-39xc-vjpf

`scripts/check.sh` had been failing in "audit: automation (npm audit)" on GHSA-fc5q-39xc-vjpf (picomatch ≤ 4.0.7,
high; through `typescript-eslint` → `@typescript-eslint/typescript-estree` → `tinyglobby` → `picomatch@4.0.7`). The
advisory lists **no patched version**, and GitHub **withdrew it on 2026-11-18**. With the withdrawal, `npm audit
--omit=dev` in `automation/` reports no high or critical advisory (7 moderate: `minimatch` GHSA-g3hv-75wg-m249 through
`typescript-eslint`, below the audit's threshold), and `web/` is unchanged (only the two allow-listed postcss
advisories). No dependency was changed and no allow-list entry was added: an entry for a withdrawn advisory would only
print "no longer needed".

## Cross-tenant and credential-absence suites

`backend/tests/integration/test_p6_close.py` builds one demo project with every kind of Phase 6 artefact: REL-0001,
the shop's test account saved, the rescan (CHG-0001), impact items (one closed as "No action needed"), repairs (all
Contact ones accepted), a manual re-test, a regression run waiting for G7, EXP-0001 (anonymous, with its draft) and
EXP-0002 (signed in, approved with the typed host), REL-0002 decided at G9, a scan comparison and both report types.

- **Every Phase 6 route** (28, `PHASE6_ROUTES`) is compared with the app's OpenAPI paths, so a new endpoint fails the
  test until it is added. Each gets a concrete call with a valid body from the other organisation: **404 on all**,
  plus the earlier endpoints that now serve Phase 6 objects (sessions as `quality-scans`, findings, triage and raise
  defect, the exploratory draft, scan 2 and its pages and evidence, the regression run, report generation for both
  types, every report's detail and its five downloads, traceability gaps and coverage, and chains by CHG, EXP, HEAL
  and REL key). None of the refused writes changed anything.
- **Signed URLs:** every evidence file written from the rescan on (discovery screenshots of release 2, repair
  screenshots, exploration before/after, report files) opens with its own signature; a signature made for the other
  organisation, a changed expiry and an expired one get **403** ("This link is invalid or has expired", the
  behaviour since Phase 1); `GET /evidence/{id}` from the other organisation is 404.
- **Credentials:** the test account's password (plain and base64) is in no Phase 6 API response, no report format
  (HTML, PDF text, JSON, CSV, XLSX cells), no evidence file or its metadata, no event, no database row and no log
  line; its email is in no Phase 6 API response or report. A control check confirms the scan would have found the
  password.

## Acceptance criteria → tests

Backend tests are under `backend/tests/integration/` (`i/`) and `backend/tests/unit/` (`u/`); mocked UI tests under
`web/e2e/mocked/` (`m/`); the real-stack journey is `web/e2e/phase6-journey.spec.ts` (`J` with its step number).

### P6-00 Foundation, rescan staleness rule and demo-shop v2

| Acceptance criterion | Tests |
|---|---|
| A rescan leaves requirements, strategy, design and automation un-stale with unchanged versions; a11y/security stale | `i/test_p6_foundation.py::test_rescan_keeps_approved_artefacts_and_marks_checks_stale`, `::test_plain_discovery_rerun_keeps_todays_staleness`, `u/test_stages.py`; `i/test_p6_changes.py::test_approved_work_keeps_its_status_after_rescans` |
| Exploratory before G2 409; `POST /stages/exploratory/run` 422; release readiness needs a finished run | `i/test_p6_foundation.py::test_exploratory_needs_g2_and_never_runs_as_a_stage`, `::test_release_readiness_needs_a_finished_run` |
| A Phase 5 database upgrades cleanly and keeps its data | `i/test_p6_foundation.py::test_migration_keeps_phase5_data_and_sets_the_ceiling`, `::test_downgrade_removes_phase6_rows`, `::test_migration_on_a_real_phase5_database`; `i/test_p6_exploratory.py::test_migration_0021_up_down_up` (SQLite only, see Limitations) |
| v1 byte-for-byte the Phase 5 shop; v2 changes present; version file flips without restart; Phase 1–5 e2e pass | `i/test_p6_demo_shop.py` (all six tests); the Phase 1–5 journeys on release 1 (Results) |
| Another organisation gets 404 on every new stage endpoint | `i/test_p6_foundation.py::test_new_stages_and_endpoints_are_404_for_another_organisation`; `i/test_p6_close.py::test_other_organisation_gets_404_on_every_phase6_endpoint` |

### P6-01 Rescan and change detection

| Acceptance criterion | Tests |
|---|---|
| CHG-0001 on the demo has exactly the listed items | `i/test_p6_changes_demo.py::test_demo_shop_release_2_change_set`; J2; J8 |
| Fixture: moved element cosmetic, heading cosmetic, price change grouped under "Content values changed" | `i/test_p6_changes.py::test_rescan_change_set_on_release_2`, `u/test_p6_change_diff.py`, `u/test_qa_p6_01_diff.py` |
| Compare scan 1 with scan 3; earlier change sets unchanged | `i/test_p6_changes.py::test_compare_scan_1_with_scan_3_skipping_2`, `i/test_p6_changes_api.py::test_compare_two_scans_once_and_read_the_items`; `m/phase6.spec.ts` "compare Scan 1 with Scan 3"; J8 |
| The baseline's pages, evidence and reports unchanged; no earlier row updated or deleted | `i/test_p6_changes.py::test_earlier_scan_is_untouched`; J2 + J8 inventory |
| Changed G1 hosts 409; viewer 403; other organisation 404 | `i/test_p6_changes_api.py::test_rescan_refusals`, `i/test_p6_changes.py::test_other_organisation_gets_404`, `i/test_p6_close.py` |
| Web: before/after view by keyboard, text alternatives, 375 px | `m/phase6.spec.ts` "before/after drawer…", "375 px…", "viewer…"; `m/qa-phase6.spec.ts` |

### P6-02 Change impact analysis and regression recommendation

| Acceptance criterion | Tests |
|---|---|
| CHG-0001 impact: Contact requirements and cases direct, Contact scripts outdated, removed-page reviews, `/offers` gaps, must-run list with DEF-0001 | `i/test_p6_impact_demo.py::test_demo_chain_impact_and_regression`, `i/test_p6_impact.py::test_release_2_impact_is_labelled_with_reasons`, `::test_scripts_that_find_message_are_outdated_and_the_stage_keeps_its_status`; J3 |
| An outdated script blocks the request (422 naming it); healed scripts → run waits for G7, nothing sent | `i/test_p6_impact.py::test_must_run_and_the_outdated_script_block`, `::test_repairs_close_and_the_regression_run_closes_reruns`; `m/phase6-impact.spec.ts`; J4 |
| After the authorised run, every must-run rerun item is resolved by it | `i/test_p6_impact.py::test_repairs_close_and_the_regression_run_closes_reruns`; J4 |
| `no_action` needs a reason; AI can't drop a must-run case or add an unknown one | `i/test_p6_impact.py::test_closing_rules`, `::test_ai_may_reorder_should_run_only`, `u/test_p6_impact.py`, `u/test_qa_p6_02.py` |
| Viewer 403 on the run; other organisation 404 on impact and recommendation | `i/test_p6_impact.py::test_other_organisations_get_404`; `m/qa-p6-02.spec.ts`; `i/test_p6_close.py` |

### P6-04 Advanced self-healing recommendations

| Acceptance criterion | Tests |
|---|---|
| HEAL-0001/0002 (and the form, HEAL-0003) High with "same field, renamed", verified with a screenshot | `i/test_p6_repairs_demo.py::test_demo_chain_repairs_then_the_regression_run`, `i/test_p6_repairs.py::test_change_set_suggests_the_renamed_label_verified_on_the_live_page`; J4 |
| Both accepted: one locator line changed, spec files byte-identical, G6 valid, run passes | `i/test_p6_repairs_demo.py`, `u/test_p6_repairs.py`; J4 |
| Ambiguous rename: no High candidate, "More than one element matches; not offered" | `i/test_p6_repairs.py::test_the_ambiguous_rename_offers_no_high_candidate` |
| Changed asserted text: an `expected_result_review`, no accept, expected result unchanged | `i/test_p6_repairs.py::test_a_changed_confirmation_text_is_a_review_without_accept`; J4 (expected result unchanged) |
| FakeLLM proposing an unverified expression or an edited assertion is rejected | `i/test_p6_repairs.py::test_ai_may_only_reorder_verified_candidates`, `u/test_p6_repairs_qa.py` |
| The P4-08 accept endpoint still works; viewer 403; other organisation 404 | `i/test_p6_repairs.py::test_permissions_tenancy_and_no_batch_accept`, `m/phase6-repairs-result.spec.ts`, `i/test_p6_close.py` |

### P6-05a Release readiness assessment and G9

| Acceptance criterion | Tests |
|---|---|
| Demo after the Phase 4 chain: `no_go`, `exit.no_open_high_defects` not met naming DEF-0001 | `i/test_p6_release_demo.py::test_demo_chain_no_go_then_conditional`; J1 |
| Demo after the v2 chain: `conditional`, every blocking criterion met, conditions name the minor defect and the removed-page reviews | J6 (the only test that runs exploration in the chain); `i/test_p6_release_demo.py` (without exploration) |
| Fixture with every criterion met: `go` | `i/test_p6_release.py::test_fixture_project_with_every_criterion_met_is_go` |
| "Stakeholders signed off" not evaluable until a member confirms it ("Confirmed by {name}") | `i/test_p6_release.py::test_unrecognised_exit_criterion_is_confirmed_by_a_member`; `m/phase6-release.spec.ts` "Confirm result…" |
| A new result makes it stale; a decision gets 409 | `i/test_p6_release.py::test_assessment_goes_stale_when_evidence_changes`, `i/test_p6_release_demo.py`, `i/test_p6_release_retests.py::test_risks_impact_items_and_repairs_make_it_stale` |
| Override without a reason or under 20 characters 422; with one, audit and `gate_decisions` keep both | `i/test_p6_release.py::test_override_needs_a_different_verdict_and_a_reason`; J6 (UI refusal, then override) |
| Member deciding G9 403; FakeLLM "ready to release" on no-go rejected; other organisation 404 | `i/test_p6_release.py::test_ai_writes_the_narrative_only`, `::test_other_organisations_get_404_and_nothing_starts_before_a_run`, `i/test_p6_close.py` |
| D37 manual re-tests recorded and counted | `i/test_p6_release_retests.py::test_manual_retests_are_recorded_and_count_like_results`; J6 |

### P6-05b Release readiness workspace and G9 decision

| Acceptance criterion | Tests |
|---|---|
| Member: no decision controls; approver: override needs another verdict and a reason; the confirmation says where it is shown | `m/phase6-release.spec.ts` "approver: Override offers only other verdicts…", "member: read-only Gate 9…"; `m/qa-p6-05b.spec.ts` "override boundaries…"; J6 |
| Stale: decision controls disabled with the reason | `m/phase6-release.spec.ts` "stale: banner and disabled decision…" |
| Criteria status and blocking as text; evidence keys link | `m/phase6-release.spec.ts` "REL-0001: No-go · Recommended…", `m/qa-p6-05b.spec.ts` "criteria filter…" |
| Viewer read only; axe; keyboard; 375 px | `m/phase6-release.spec.ts` "keyboard…", "375 px…"; `m/qa-p6-05b.spec.ts` "viewer…", "320 px…"; J1, J6 (axe) |

### P6-05c Test Completion and Release Readiness reports

| Acceptance criterion | Tests |
|---|---|
| REL-0002 final: verdict, criteria, conditions and counts equal the API; decider and time; the override shown | `i/test_p6_reports.py::test_release_readiness_report_follows_the_assessment`, `i/test_p6_release_demo.py`; J7 |
| Awaiting approval: DRAFT band (XLSX: first line of Summary) | `i/test_p6_reports.py::test_stale_assessment_band_and_confirmed_criterion`, `::test_release_readiness_report_follows_the_assessment`; `m/phase6-reports.spec.ts` |
| Completion counts equal the execution API; deviations list never-executed approved cases | `i/test_p6_reports.py::test_completion_report_measures_equal_the_api`; J7 |
| Formula guard; no credentials and no email in any format | `i/test_p6_reports.py::test_completion_report_measures_equal_the_api`, `i/test_qa_p6_05c.py`, `i/test_p6_close.py::test_no_credential_in_any_phase6_artefact_or_format`; J7 (CSV without email) |
| No assessment: 409 "Not available yet…"; other organisation 404 on reports, 403 on signed links | `i/test_qa_p6_05c.py`, `m/phase6-reports.spec.ts` "before any assessment…"; `i/test_p6_close.py` (404 and 403) |

### P6-03a Exploratory testing: rule-based safe explorer

| Acceptance criterion | Tests |
|---|---|
| Demo v2, EXP-0001: `/offers` findings with before/after evidence, the draft, POST /basket blocked, "Apply code" not tried | `i/test_p6_exploratory_demo.py::test_demo_shop_exploration_on_release_2`; J5 |
| Access logs show only GET/HEAD; "Delete account", "Pay now", `/logout` never activated; no form submitted | `i/test_p6_exploratory_demo.py`, `i/test_p6_exploratory.py::test_lab_oracles_blocked_write_not_tried_and_budget`, `::test_no_new_window_is_ever_opened`; J5 (access log) |
| Infinite link chain ends `completed` at exactly the budget | `i/test_p6_exploratory.py::test_chain_ends_at_exactly_the_budget` |
| Budget over the ceiling 422; signed-in waits for a typed-host approval, members can't approve | `i/test_p6_exploratory.py::test_budget_limits_and_rights`, `::test_signed_in_session_waits_for_a_typed_host_approval` |
| Prompt-injection page: actions unchanged, the detector records a finding | `i/test_qa_p6_03a.py`, `u/test_p6_exploratory.py`, `u/test_qa_p6_03a.py` |
| Signed-in: no credential, cookie value or password in steps, findings, evidence, events or logs | `i/test_p6_exploratory.py::test_signed_in_session_waits_for_a_typed_host_approval`, `i/test_qa_p6_03a_r2.py`; `i/test_p6_close.py` (EXP-0002 signed in on the demo) |
| Stop now within 2 s with steps kept; viewer 403; other organisation 404 | `i/test_p6_exploratory.py::test_stop_now_ends_within_two_seconds`, `::test_budget_limits_and_rights`; `i/test_p6_close.py` |

### P6-03c Exploratory workspace and live session view

| Acceptance criterion | Tests |
|---|---|
| Progress at least every 2 s; Stop now by keyboard with a confirmation; no live indicator after the end | `m/phase6-explore.spec.ts` "a double click on Start exploring…", "Stop now by keyboard…"; `m/qa-p6-03c.spec.ts` |
| Member signed in: the dialog says an approver must approve; no Approve control | `m/phase6-explore.spec.ts` "member signed in…" |
| Findings: numbered reproduction steps; before/after screenshots with text alternatives | `m/phase6-explore.spec.ts` "EXP-0001 results…"; J5 (session page) |
| Viewer: no start or stop controls; axe; keyboard; 375 px | `m/phase6-explore.spec.ts` "viewer…", "375 px…"; `m/qa-p6-03c.spec.ts`; J5 (axe) |

### P6-06 Traceability, Overview and AI QA Analyst v5

| Acceptance criterion | Tests |
|---|---|
| After CHG-0001, before healing: `scripts_outdated` lists the Contact scripts with reasons; the count equals the list | `i/test_p6_trace_assistant.py::test_traceability_gap_lists_and_matrix_after_the_rescan`; `m/phase6-trace.spec.ts` "coverage…" |
| "Can we release?" AI off: verdict, REL key, blocking criteria, the statement; none → offers to create one | `i/test_p6_assistant_release.py::test_can_we_release_without_ai`; `m/phase6-trace.spec.ts`, `m/qa-p6-06.spec.ts`; J9 |
| Accepted `propose_regression_run`: the run waits for G7 | `i/test_p6_trace_assistant.py::test_regression_proposal_waits_for_gate_7`; `m/phase6-trace.spec.ts` |
| Another organisation's key isn't resolved | `i/test_p6_trace_assistant.py::test_keys_resolve_only_inside_the_organisation`, `i/test_qa_p6_06.py::test_other_org_cannot_ask_or_read_chains`; `i/test_p6_close.py` (chains by key) |
| AI answers about release verdicts are replaced by the rules answer (`release_guard`) | `i/test_qa_p6_06.py`, `i/test_p6_assistant_release.py::test_ai_can_not_answer_release_or_change_questions` |

### P6-08 End-to-end verification and phase close

| Acceptance criterion | Tests |
|---|---|
| Clean environment, AI off: the journey passes; no-go then conditional on the demo, go on the fixture | J1–J10 (clean run, 10/10); `i/test_p6_release.py::test_fixture_project_with_every_criterion_met_is_go` |
| `scripts/check.sh` and the e2e suites pass; every criterion maps to a test | Results table; this section |
| No row or file from an earlier scan deleted (inventory of `scan_sessions`, `discovered_pages`, `evidence`, storage) | J2 (before) + J8 (after) |
| Harness: no non-GET at a target during exploration; no 5432/6379; demo left on v1 | J5; `beforeAll`; J10 and `afterAll` |
| Cross-tenant suite over every Phase 6 endpoint and signed URL; credential absence over every artefact type and format | `i/test_p6_close.py` (4 tests) |

P6-03b and P6-07 were cut, so their criteria have no tests (see Cuts).

## Limitations

- **Postgres:** migration `0021` (and the rest of Phase 6) was verified on SQLite only. Postgres stays with the Hosted
  deployment phase (H-01); it was never run against the instances on 5432.
- **Safari:** the real-stack journey ran in Chromium only. The mocked suite has a WebKit project in CI; the Phase 6
  screens were not walked in Safari against a real backend.
- **Not built (P6-06 deviations):** the Overview "Changes" glance card (design P6 §4.5) and the "Changed" badge on
  Discovery. Overview shows only the "Application changed" banner. The HEAL picker in the assistant is a text field.
- **pushState logged as "Opened /logout":** a script-driven `history.pushState` to a sign-out address is recorded as
  an opened, blocked navigation in the step log, although nothing was requested. The wording overstates what
  happened; the safety is unaffected.
- **Flaky backend test:** the comparison test in `test_p6_changes.py` (the scan-compare path) has been seen to fail
  intermittently; it passed in this run. Not investigated in P6-08.
- **Wording:** the exploration statement says "1 actions on 1 pages" for a one-action session (no singular forms).
- **Signed-in screenshots:** password fields are masked and their values removed from DOM data, but text a page
  shows after sign-in (for example the demo's "Signed in as …" with the account's email) can appear in a screenshot
  image. The credential scan checks text and files, not pixels.
- **Readiness latency:** an assessment is a queued stage task; on a busy worker the page shows "Assessing…" for
  several seconds before the verdict appears.
- The journey's step 1 drives the Phase 4 chain through the API (the UI version is `phase4-journey.spec.ts`), and its
  REL-0002 doesn't include the Phase 5 conditions (open serious accessibility finding, `/products/2` p95), because
  the journey doesn't run the Phase 5 chain.
- AI-on paths are still untested live (no API key); every Phase 6 AI path is tested with `FakeLLM`.

- **Go on the fixture is a backend test, not an e2e run (deviation):** `test_p6_release.py::test_fixture_project_with_every_criterion_met_is_go` seeds the stored evidence (requirement, strategy, risk, passed run, clean checks, exploratory session) and then runs the real assessment and G9 over HTTP. It doesn't prove the Phase 5 checks produce "met" from real evidence.
- **5432/6379 check is shallow:** the journey checks only the URLs it was given; it can't see the backend's `DATABASE_URL`. A grep of `web/e2e`, `web/tests`, `backend/tests` and `automation` finds no use of either port.
- **`test_p6_close.py` gaps:** existing endpoints that gained Phase 6 behaviour (`/approvals/{id}/decision` for signed-in exploration, assistant proposal accept/reject for the P6 kinds, heal accept) aren't in the cross-tenant sweep. Its credential fixture doesn't execute a post-rescan run, and trace zips aren't unzipped. QA's scan of the full journey stack (256 files, 13 zips unzipped, every DB row, logs) found no password.
- **Not re-run:** `phase2`–`phase5-qa-verification.spec.ts` (they also hard-code :4100/:8200 in places).

## Cuts

- **P6-03b AI-guided exploration:** cut by the user on 2026-11-18 (deferred to the backlog). With AI on, the rule
  explorer drives every session; `chosen_by` is always `rules`. `security-risks.md` T11 says so.
- **P6-07 egress proxy:** cut by the user on 2026-11-18 (back to the hardening pool). `/health` still reports
  `egress_proxy: "off"`, and `security-risks.md` **T3 stays open**: browsers (discovery, rescans, locator re-checks,
  heal verification, exploration, test runs) rely on the context-wide network policy, which doesn't catch a DNS
  rebinding answer between its check and Chromium's own lookup.

## Hand-off to the Hosted deployment phase (D23)

Phase 6 is the last product phase on this machine's local stack. The next phase is Hosted deployment (H-01 to H-05),
which starts when Docker (or Colima) is installed and uses its own Postgres and Redis on 5433/6380, never 5432/6379:

- **H-01 Postgres and RLS:** run migrations `0001`–`0021` on Postgres (including Phase 6's `0019`–`0021`, unverified
  there); RLS on the Phase 6 tables (`change_sets`, `change_items`, `impact_items`, `heal_suggestions`,
  `exploratory_steps`, `release_assessments`, `manual_retests`); rerun `test_p6_close.py`'s cross-tenant sweep with RLS
  as the second line.
- **H-02 Redis queue:** the Phase 6 jobs (`change_analysis`, `exploratory_session`, release assessments, report
  rendering) must meet the same `JobQueue` contract; "Stop now" for exploration relies on the 0.25 s poll.
- **H-03 S3 storage:** repair screenshots, exploration before/after evidence and the two new report types go through
  `ObjectStorage`; signed URLs unchanged.
- **H-04 sandbox:** browsers (including exploration) and the runner in containers with an egress firewall denying
  private ranges: this, with the egress proxy, closes T3.
- **H-05:** production settings refuse `ALLOW_PRIVATE_TARGETS`; the demo shop's `DEMO_VERSION_FILE`/`DEMO_ACCESS_LOG`
  stay development-only.
- Also carried over: the first GitHub Actions run (when the phase PR is opened), the egress proxy (P6-07) and
  AI-guided exploration (P6-03b).
