# Backlog

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
