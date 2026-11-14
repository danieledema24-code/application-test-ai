# Backlog

## Phase 4: Automation, execution, defects (branch `phase-4`, from `phase-3`)

**Source of truth:** `docs/architecture/roadmap.md` ("Phase 4"), with the full Given/When/Then criteria there. Schema: `docs/architecture/database-schema.md` ("Automation, execution, defects (Phase 4)"). Contracts: the endpoints are named in each roadmap story; `api-contracts.md` gets a "Phase 4 endpoints" section with P4-00.

**UX:** every web PR needs `docs/design/P4-qa-analyst-phase4.md` (`ux-designer`) first. Backend-only and Node-only PRs don't.

**Product decisions:** D7–D16 are resolved (user, 2026-11-13). See the table below the backlog.

**Demo thread (phase acceptance):** empty-Message case (expected "Submission is blocked and Message is identified as required") → script → G6 → authorised run (G7) → fails twice → `application_defect` → DEF-0001 draft → confirmed at G8.

| ID | Story | Priority | Size | Acceptance criteria (brief) | Status |
|---|---|---|---|---|---|
| P4-00 | Phase 4 workflow foundation, migration `0016` | P0 | M | Assessment queued once after G5, automation after assessment; execution never auto-queued and not runnable via `/stages`; G7/G8 locked; G7 per run, G8 per defect; G5 re-approval marks automation stale; Phase 3 DB upgrades cleanly. | Done (QA pass, phase4-verification.md) |
| P4-01 | `automation/` Node toolkit (pinned `@playwright/test` = backend Playwright version) + Python adapter | P0 | M | Spec-guard ported with old vectors; network-policy parity with Python SSRF on a shared vector file (incl. redirect hops); `qa` helpers with `QA_ASSERTION:` messages; `validate`/`run`/`version` CLI with JSON; scrubbed child env; `/health.automation`. | Done (QA pass, phase4-verification.md) |
| P4-02 | Step model and automation suitability | P0 | M + S | Every Phase 3 step/expected template parses; suitable/partial/manual_only with plain reasons quoting the step; derived fields (no version bump, no G5 reopen); demo: empty-Message case suitable, sign-in partial without credentials. Fixes "Enter valid in Message". | Done (QA pass, phase4-verification.md) |
| P4-03a | Test Automation Engineer Agent: rule path | P0 | L | Bundle with POMs (accessible locators first), factories from TD, one spec per case tagged `@TC-…`, steps as `test.step`, `qa.expect*` assertions; no fixed waits, secrets or `test.only`; deterministic; only changed cases get new script versions; outdated flagged. | Done (QA pass, phase4-verification.md) |
| P4-04 | Script validation, G6, Automation workspace (Backend PR, Web PR) | P0 | M + L | guard, tsc, eslint, secret scan, tags, live read-only locator check; invalid/outdated scripts can't run (409); G6 per D10; GET-only target access during verification; axe/keyboard/375 px clean. | Done (QA pass, phase4-verification.md) |
| P4-05 | Approvals for risky actions | P0 | M | Possible side effects from the step model (a negative case still "may submit"); separate approval for external transaction and destructive (D12), typed host confirmation; single use, 24 h expiry; rejected cases skipped, not the run. | Done (QA pass, phase4-verification.md) |
| P4-06 | Execution engine and G7 | P0 | L | Run request → scope → G7 by `can_approve` (D8) → sandboxed subprocess (scrubbed env, rlimits, timeouts, process-group cancel); results only from the JSON reporter; evidence (masked screenshot, video, trace off when signing in, logs); retries per D9 (flaky status); restart safety; no credentials anywhere. | Done (QA pass, phase4-verification.md) |
| P4-07 | Test Execution workspace and live view | P0 | L | Run dialog with authorisation summary and approvals; member request vs approver authorise; live progress via SSE + screencast tiles; result detail with expected vs actual and evidence; case "Last result" real; `CURRENT_PHASE = 4`; axe/keyboard/375 px. | Done (QA pass, phase4-verification.md) |
| P4-08 | Defect Analysis Agent | P0 | L | Rule classifier for the 8 classes with confidence, signals and evidence; drafts only for application defects at medium+; heal suggestions for selector failures only, never changing assertions; reclassify with reason; AI can't overrule hard signals. Demo empty-Message → `application_defect`. | Done (QA pass, phase4-verification.md) |
| P4-09 | Defect management and G8 (Backend PR, Web PR) | P0 | M + L | All §11 fields with code-derived severity/priority/reproducibility; per-defect G8 confirm/reject by `can_approve` (D11); verified only after a passing re-run; dedupe into occurrences; no DELETE; no secrets. | Done (QA pass, phase4-verification.md) |
| P4-12 | Traceability, readiness and case results | P1 | M + S | Script/result/defect columns real; the four execution gap lists computed; chain from DEF-; DoD "executed with evidence" and "no open critical/high defects" evaluable; RTM gains columns. | Done (QA pass, phase4-verification.md) |
| P4-11 | Reports: Test Execution and Defect | P1 | M | HTML/PDF/JSON/CSV; totals equal the API; DRAFT band while drafts are undecided; CSV formula guard; no secrets. | Done (QA pass, phase4-verification.md) |
| P4-10 | Export Playwright project + GitHub Actions/GitLab CI templates | P1 | M | Unzipped export runs locally with the same outcome as the platform; safe zip paths; invalid scripts excluded and listed; templates parse and use secrets by name only. | Done (QA pass, phase4-verification.md) |
| P4-03b | Automation Engineer: AI path and repair loop | P1 | M | Up to 3 repairs then rule fallback; assertion set must equal the rule baseline (`assertion_changed`), AI-only assertions must map to a step; AI scripts need G6 review. | Done (QA pass, phase4-verification.md) |
| P4-13 | AI QA Analyst v3: execution and defects (Backend PR, Web PR) | P2 | M + S | AI off: "Did the tests pass?", "Explain a failed test", "Analyse a defect" grounded and cited; rerun proposals create run requests only (G7 still needed). | Done (QA pass, phase4-verification.md) |
| P4-14 | Manual test results (only if D15 = include) | P2 | M | Record pass/fail/blocked with notes and upload for manual cases; counts as execution evidence; no automatic defect drafts. | **Cut** (2026-11-14, lead decision after Phase 4 QA round 1): manual-only cases stay "not executed" and are listed with their reasons in the Test Execution Report's "Not automated" section. |
| P4-15 | End-to-end verification, `api/` retirement, phase close | P0 | M | Full AI-off demo journey catches the empty-Message bug through G8; cross-tenant and credential-absence suites; `api/` retired per D16 (demo shop moved to `demo-shop/` first); `phase4-verification.md`. | Done (QA pass, phase4-verification.md) |

### Product decisions (resolved 2026-11-13)

| # | Decision | Options | Resolution | Stories affected |
|---|---|---|---|---|
| D7 | Default browsers and viewports for runs | (a) Chromium desktop 1440×900 only; mobile 390×844 and Firefox/WebKit opt-in per run. (b) Chromium desktop + mobile by default. (c) Chromium + Firefox + WebKit by default (needs extra browser installs). | **Decided: (a)**, Chromium desktop 1440×900 by default; mobile, Firefox and WebKit opt-in per run. | P4-06, P4-07 |
| D8 | How G7 authorises runs | (a) Every run needs its own G7 decision; an approver starting a run authorises in the same click; members request. (b) A standing authorisation per scope (same scripts, environment, no new risky actions) valid for N days. (c) One authorisation per project until the scope changes. | **Decided: (a)** (user's choice), every run is authorised separately. | P4-06, P4-07, P4-13 |
| D9 | Retries and flake policy | (a) No retries; failures analysed once. (b) Playwright `retries: 1`; pass on retry = `flaky`, no defect draft; no retries for external-transaction/destructive specs. (c) `retries: 2`. | **Decided: (b)**, one retry; pass on retry = flaky, no defect; no retries for external-transaction/destructive specs. | P4-05, P4-06, P4-08, P4-09 |
| D10 | Is G6 (script validation) a human sign-off? | (a) `required` for every bundle (a third human approval before the first run, after G5 and before G7). (b) `recommended`: static validation always blocks; no human sign-off. (c) Hybrid: static validation always blocks; rule-generated valid scripts need no sign-off; AI-written scripts need a `can_approve` review. | **Decided: (c)** (user's choice), hybrid: static validation always blocks; rule-written scripts need no sign-off; AI-written scripts need a `can_approve` reviewer. | P4-00, P4-03b, P4-04 |
| D11 | How G8 works and who decides | (a) Per defect: each draft confirmed or rejected by a `can_approve` user (bulk allowed); members edit drafts and mark fixes. (b) Per defect, but members can confirm too. (c) One batch decision over all drafts of a run. | **Decided: (a)**, per defect by `can_approve`, bulk allowed. | P4-09, P4-11 |
| D12 | What counts as a risky action needing a separate approval | (a) External transactions and destructive actions only; form submission, sign-in and data creation are shown in the G7 summary and covered by G7. (b) Also data creation (sign-up, create records). (c) Every side effect, including any form submission. | **Decided: (a)**, separate approval only for external transactions and destructive actions. | P4-05, P4-07 |
| D13 | Can people edit generated scripts in the platform? | (a) No: read-only; change the case and regenerate, or edit the exported project. (b) Members edit, with spec-guard re-validation; edited scripts are kept on regeneration and need G6 review. (c) Owners/admins only. | **Decided: (a)**, scripts are read-only in the app. | P4-03a, P4-04, P4-10 |
| D14 | API testing (OpenAPI import, API cases) | (a) Defer to a new Phase 5 story P5-06; retire the old API runner anyway (it stays on `main`). (b) Port it in Phase 4 as P4-16 (adds an L story). | **Decided: (a)**, deferred to P5-06. | P4-15, P5-06 |
| D15 | Recording manual test results | (a) Defer: manual-only cases stay "not executed". (b) Include P4-14 (M) late in the phase. | **Decided: (b)** (user's choice), P4-14 is included and is the first story cut if the phase runs long. | P4-12, P4-14 |
| D16 | The old `api/` at phase end | (a) Partial: delete only the Phase 4-replaced parts and the three Phase 3 leftovers; delete `api/` in Phase 5 as planned. (b) Delete `api/` entirely in P4-15 after moving the demo shop and demo login to `demo-shop/`. (c) Keep everything until Phase 5. | **Decided: (b)** (user's choice), delete `api/` in P4-15 after moving the demo shop and its login file to `demo-shop/`. The user updates `football-predictor/.claude/launch.json` (remove `test-app-api`; point `test-app-demo` at `demo-shop/`). | P4-15, retirement plan |

### Defaults chosen in planning (change on request)

- Playwright in `automation/` is pinned to the backend's Python Playwright version (1.65.x) so both use one browser install; Node 22.
- Run limits: workers 2 (cap 4); 60 s per test; 10 s per assertion; wall clock min(30 min, estimate + 2 min); 300 tests per run; 1 active run per project, 2 per organisation.
- Evidence: a masked final screenshot for every test; video and trace kept for failures only; trace off in specs that sign in; workflow code never deletes evidence.
- Live view: on for Chromium, about 5 frames a second, not stored (the video is the record).
- Defect drafts only for `application_defect` at medium or high confidence; lower confidence shows "Raise defect" instead.
- Severity derived from the linked risk level and the failure scope; priority from the case's effective priority; both overridable with a reason.
- A repeat failure of the same case and step adds an occurrence to the open defect instead of a new draft.
- Risky-action approvals are single use (per run) and expire after 24 h.
- Locator verification is live and read-only, and signs in with saved credentials for signed-in pages; unchecked locators are a warning, not a blocker.
- The runner sandbox is a subprocess with a scrubbed env, rlimits (memory limits are not enforced on macOS), spec-guard and the network-policy fixture. That is stated as a trusted-tenant limitation until the P5-05 Docker sandbox.
- CI templates for GitHub Actions and GitLab CI are validated as YAML but not run on real CI.

---

## Phase 3: Test design and traceability (branch `phase-3`, from `phase-2` / PR #4)

**Source of truth:** `docs/architecture/roadmap.md` ("Phase 3"), with the full Given/When/Then criteria there. Schema: `docs/architecture/database-schema.md`. Contracts: `docs/architecture/api-contracts.md` ("Phase 3 endpoints").

**UX:** every web PR needs `docs/design/P3-qa-analyst-phase3.md` (`ux-designer`) first. Backend-only PRs don't.

**Product decisions:** D1–D6 are resolved (user, 2026-11-13). See the table below the backlog.

| ID | Story | Priority | Size | Acceptance criteria (brief) | Status |
|---|---|---|---|---|---|
| P3-00 | Phase 3 workflow foundation (backend), plus a web PR that deletes the orphaned legacy screens | P0 | M + S | `test_design` queued once after G4 and blocked before it (409 `gate_blocked`). `traceability` is a derived stage. G5 default `required` (D1), and existing projects are switched by a data step. G5 snapshot/reopen machinery. G4 re-approval marks design stale. Legacy `/test-cases`, runs, defects and integrations screens deleted; all builds green. | Done (QA pass with notes, phase3-verification.md) |
| P3-01a | Test Design Agent: rule path, tables (`0013`), read API, G5 lint | P0 | L | Demo shop, AI off: EP and BVA (0/1 characters) for Name/Email, a sign-in decision table and state transition, nav smoke, a products use case, an accessibility case. No upper-boundary case without `maxlength`. Empty-Message case as an open question. Fixture BVA 80/81 (79/80/81 at high risk) and 9/10. All §7 fields; `not_run`; deterministic TD; no secrets anywhere. | Done (QA pass with notes, phase3-verification.md) |
| P3-01b | Test Design Agent: AI path and regeneration review | P1 | M | Model values replaced by computed ones; untraceable boundaries dropped. Provenance capped. Fallback to rules. Injection isolated. Protected items kept; approved and no longer found → keep. | Done (QA pass with notes, phase3-verification.md) |
| P3-02 | Test case management and G5 (Backend PR, Web PR) | P0 | M + L | Create/edit/approve/reject/deprecate (no DELETE). Approval blocked by lint errors or open questions. Edits after approval reopen G5. G5 is a required sign-off by a `can_approve` user, with the same check as G3/G4 (D1); design waits in `awaiting_approval`. G5 blocked by an untested open high risk. Viewer read-only; members approve individual cases (D2); G5 needs `can_approve`. Axe and keyboard clean, 375 px. | Done (QA pass with notes, phase3-verification.md) |
| P3-03 | Test data management | P1 | M | Synthetic guard (reserved domains and phone ranges, Luhn, secret refs only). Boundary length locked. Edit used by approved cases → G5 reopens. Retire blocked while in use. DoR "test data identified" evaluated from TD. (D3) | Done (QA pass with notes, phase3-verification.md) |
| P3-05 | Risk-based prioritisation | P1 | M | Case risk level, score and priority derived from linked risks and recomputed in the same transaction (no version bump, no reopen). Override needs a reason; below-risk override warns. Per-risk coverage, `?uncovered=true`. | Done (QA pass with notes, phase3-verification.md) |
| P3-04 | Traceability engine and matrix (Backend PR, Web PR) | P0 | M + M | Forward, backward and chain views. Coverage numbers equal the gaps. Spec §12 gap lists, with the Phase 4 ones `available=false` (never "0"). `basis=approved` uses the G5 snapshot. DoD AC-coverage evaluable. Accessible table, 375 px. | Done (QA pass with notes, phase3-verification.md) |
| P3-08 | Reports: Test Case Specification and RTM | P1 | M | HTML/PDF/JSON/CSV; XLSX in P5-04 (D4). Counts equal the stats. DRAFT band until G5; frozen on G5 approval. CSV formula-injection guard. No secrets. Phase 4 columns "Not available". | Done (QA pass with notes, phase3-verification.md) |
| P3-06 | AI QA Analyst v2: test design (Backend PR, Web PR) | P1 | M + S | AI off: "Generate more negative test cases" → non-duplicate proposal with computed data. "Review test coverage" counts equal the coverage. "Generate regression scenarios" tags by risk. Accepting reopens G5. Citation guard covers TC/TCOND/TD. | Done (QA pass with notes, phase3-verification.md) |
| P3-07 | Workspace members and roles (Backend PR `0014`, Web PR) | P1 (P0 if a second dev is free) | M + M | One-time invitation link (D5). Role and `can_approve` edits. Last-owner protection. Admin can't touch owners. Removal revokes sessions. Token stored hashed. Non-approver copy fixed. | Done (QA pass with notes, phase3-verification.md) |
| P3-09 | End-to-end verification and phase close | P0 | M | Full AI-off journey on fixture and demo through G5, traceability and reports. Roles via real invitations. Cross-tenant 404 suite. Legacy `api/` test-case, assistant and members code removed. `phase3-verification.md`. | Done except legacy `api/` removal (awaiting user decision) |

### Product decisions (resolved 2026-11-13)

| # | Decision | Options considered | Resolution |
|---|---|---|---|
| D1 | Is G5 blocking or advisory by default? | (a) `recommended`: lint always runs, hard blockers apply whenever someone approves, and Phase 4 automates only approved, lint-clean cases. (b) `required`, like G3/G4. | **Resolved: (b) `required`** (user's choice, not the PM recommendation). A user with `can_approve` (same check as G3/G4) must approve G5 before Phase 4 automation. Lint hard blockers still apply. Changes after approval reopen G5, and downstream keeps the last approved snapshot. |
| D2 | Who approves individual test cases? | (a) Members, as with requirements in Phase 2; G5 needs `can_approve`. (b) Only `can_approve` users. | **Resolved: (a)**, members approve individual cases; G5 needs `can_approve`. |
| D3 | Test data beyond synthetic? | (a) Synthetic only, enforced by the guard; credentials by reference; real data waits for Phase 4 approvals. (b) Allow user-entered real values now, flagged. | **Resolved: (a)**, synthetic only, enforced by validation; credentials by reference only. |
| D4 | RTM / Test Case Specification formats now | (a) PDF, HTML, JSON + CSV (no new dependency); XLSX in P5-04. (b) Add XLSX now (`openpyxl`). | **Resolved: (a)**, CSV now, XLSX in P5-04. |
| D5 | How do invited people join? | (a) Copyable one-time link, no email. (b) Admin sets a temporary password (old app). (c) Email delivery (needs SMTP). | **Resolved: (a)**, a copyable one-time link; an email that already has an account is refused this phase. |
| D6 | An expected result depends on an open requirement (the demo's empty Message) | (a) Open question: the case can't be approved until a person decides. (b) Generator assumes "should be required" (`assumed`). | **Resolved: (a)**, an open question that a person must resolve. |

---

## SCAN-1 — Watch the scan live, and get checks + scripts automatically

**Status:** Done — QA passed (branch `scan-live-view`, not yet merged)

**Why:** Users with little QA experience don't know what the scan is doing or what to do once it finishes. Showing the browser while it works, and producing ready-to-review checks with their Playwright scripts automatically, removes two steps and the guesswork.

**Product decisions (lead, defaulted):**
- Generated checks stay **drafts** (DRAFT/READY, as today). Nothing runs until the user approves; "Approve all and run" is offered.
- Auto-generation uses the rule-based generator (or AI when enabled) with the existing defaults (max 20 checks, default categories).
- Re-running a scan does not delete earlier checks; it only adds checks for pages that don't already have one with the same title (no duplicates).

### Acceptance criteria

1. **Live view during the scan**
   - Given a scan is queued or running, when the user is on the Site scan tab, then they see a live view of the scan's browser (same experience as the live view on automated runs: frames update while it works) plus the current page/URL being visited and a running count of pages found.
   - Given the scan finishes, fails or is cancelled, then the live view stops and is replaced by the results; no stale "live" indicator remains.
   - Given the live view can't connect (or the scan is headless without frames yet), then the user sees a friendly "Waiting for the browser…" state, not an error.

2. **Automatic generation after the scan**
   - Given a scan completes successfully with at least one page, then the system automatically generates manual test cases (with steps and expected results) from the discovered pages AND a Playwright script for each automatable case, without the user clicking anything.
   - Given generation is in progress, then the scan page shows "Writing checks for the pages we found…" and progress/completion.
   - Given generation fails, then the scan still shows as completed, and the page shows a clear message with a "Try again" button that runs generation manually.
   - Given the same scan is re-run, then duplicate checks (same title in the project) are not created.
   - Each generated case is linked to the scan (so the UI can count "N checks from this scan").

3. **Clear next steps on the scan page**
   - Given generation finished, then the scan page shows a prominent "What's next" panel that says, in plain words: how many manual checks were written and how many have automated (Playwright) scripts; a link "See the checks" to the Test Cases tab (filtered to this scan if possible); an explanation of where to see the automated script (open a check → Automation/Script section); and a primary button "Approve all and run" plus "Review first".
   - The copy must be understandable to someone with no QA background (no jargon like "discovery", "heuristic", "spec").
