# P3 — AI QA Analyst Platform: Phase 3 UX (Test design, Gate 5, Traceability, Members)

## 1. Goal and user
Source: roadmap Phase 3 (stories P3-00…P3-09), spec §7 (test case fields, techniques), §12 (traceability, gap lists), §16 (assistant), §17 (reports), §18 Gate 5; user decisions D1–D6 (§2).

There are two users:
1. **A QA lead.** They want a test design that is ordered by risk and that they can defend in a review.
2. **A developer or PM with no QA background.** They want to see what will be tested, why each case exists, and what isn't covered.

The job: "Turn the approved requirements and strategy into test cases I trust, and show me the gaps."

The Phase 1 and 2 rules still apply:
- Earn trust with evidence and honest states, not volume.
- Nothing the AI or the rules produce replaces human work without a visible diff and a decision.

Phase 3 adds two more:
- **Values are computed, never guessed.** Every boundary or partition value shows the constraint it came from.
- **Nothing has run yet.** No screen, report or answer may suggest that a test was executed.

This spec **extends** `docs/design/P2-qa-analyst-phase2.md`. That spec in turn extends `docs/design/P1-qa-analyst-phase1.md`. Tokens, shell, focus, motion, gate, diff, revision, provenance, report and assistant patterns from P1 and P2 apply unless restated here. References like "P2 §5.6" point to those specs.

---

## 2. Decisions applied (final; they override older roadmap text)

| # | Decision | What it means in the UI |
|---|---|---|
| D1 | **Gate 5 is a required sign-off**, like G3 and G4 | <ul><li>The lint always runs.</li><li>**Must fix** items (hard blockers) disable G5 approval. **Advice** items (warnings) are listed but don't block.</li><li>Only users with `can_approve` decide G5.</li><li>Any change after approval reopens G5.</li><li>The lifecycle shows "Waiting for approval" until G5 is decided.</li></ul> |
| D2 | Members can approve individual test cases | Members get Approve, Reject and Deprecate on cases and in bulk. Only the G5 buttons need `can_approve`. |
| D3 | Test data is synthetic only | <ul><li>A guard rejects values that look real.</li><li>Logins appear only as "the saved test account". Their values are never shown.</li></ul> |
| D4 | The Test Case Specification and the RTM download as PDF, HTML and CSV | There is no XLSX option, and no "coming soon" item for it. |
| D5 | Invitations are a copyable one-time link, with no email sent | <ul><li>The invite dialog shows the link once.</li><li>An email that already has an account is refused, with the reason shown.</li></ul> |
| D6 | An expected result that depends on an unresolved requirement is an **open question** | <ul><li>The case shows "Not decided" with a link to the requirement.</li><li>The case can't be approved until a person writes the expected result.</li></ul> |

**Gate 5 blockers (D1).** All of these must be clear before G5 can be approved. They are computed by code.
1. G4 is approved, and the test design was built from that approval.
2. At least one case is approved.
3. No approved case has a "Must fix" lint item.
4. Every approved requirement linked to an **open** High or Very high risk has at least one approved case. Accepted risks are exempt and are listed.
5. **No active case has an open question.** Active means draft or approved, not rejected or deprecated. Resolve each one by writing the expected result, or by rejecting or deprecating the case. The roadmap lists open questions as a warning; D1 makes them a blocker. See open question 1.

**Advice (G5 warnings):**
- drafts remain (they are left out of the approved set)
- approved requirements without an approved case
- approved ACs without a case
- drafts with "Must fix" items
- "Advice" lint items on approved cases

---

## 3. Token and status additions (`web/src/app/globals.css`, `ui/StatusPill.tsx`)

There are no new colours. Phase 3 reuses the semantic and risk tokens from P2 §2.

**Priority** (`PriorityValue`, new). Each priority is shown as text plus an icon. Low is neutral, not green, because "low" doesn't mean "good".

| Priority | Icon | Style |
|---|---|---|
| Critical | `ChevronsUp` | `danger-solid` / white, bold |
| High | `ChevronUp` | `danger-bg` / `danger-fg` |
| Medium | `Equal` | `warning-bg` / `warning-fg` |
| Low | `ChevronDown` | `neutral-bg` / `fg-muted` |

**Add to `TONES`:**

| Key | Tone | Icon |
|---|---|---|
| `DEPRECATED` | grey | `Archive` |
| `OPEN_QUESTION` | amber | `CircleHelp` |
| `NOT_RUN` | grey | `CircleDashed` |
| `PENDING` (invitation) | blue | — |
| `EXPIRED`, `REVOKED` | grey | — |
| `NOT_AVAILABLE` | grey | `Clock` |

**Lint severity** is always shown as a word plus an icon:
- **Must fix:** `CircleX`, `danger-fg`.
- **Advice:** `TriangleAlert`, `warning-fg`.
- **No issues:** `CircleCheck`, `success-fg`.

---

## 4. Information architecture

### 4.1 Routes
| Route | Screen |
|---|---|
| `/projects/[id]/test-cases` | Test Cases workspace. Tabs via `?view=cases\|conditions\|data\|review` (default `cases`). Filters go in URL params (§6.2). Drawers: `?condition=TCOND-0003`, `?data=TD-0004`. |
| `/projects/[id]/test-cases/[key]` | Case detail (`TC-0001`). `?v=<n>` shows an older revision read-only. `?edit=1` opens the edit form. |
| `/projects/[id]/test-cases/new` | New manual case. `?requirement=REQ-0004` prefills the link. `?from=TC-0004` is used by Duplicate. |
| `/projects/[id]/test-cases/changes?run=<n>` | Regeneration review (§12). |
| `/projects/[id]/traceability` | Traceability. `?view=coverage\|matrix` (default `coverage`), `&dir=forward\|backward`, `&basis=current\|approved`, plus filters. |
| `/projects/[id]/traceability/[key]` | Chain view for any `REQ-`, `AC-`, `TCOND-`, `TC-` or `RISK-` key. |
| `/projects/[id]/reports/test-case-spec`, `/reports/rtm` (`?version=<n>`) | The two new reports. |
| `/settings/members` | Workspace members and invitations. `/settings` becomes tabbed: Profile & organisation · Members. |
| `/invite/[token]` | Public page to accept an invitation. Uses the `(auth)` layout. |

P3-00 deletes the legacy `/test-cases/[id]` route. `/test-cases/x` must show the app's 404.

### 4.2 Sidebar (`lib/sections.ts`)
- Set `CURRENT_PHASE = 3`. Test Cases and Traceability lose their phase badge and become real screens.
- **Test Cases holds all of test design:** cases, the conditions (the design results), test data, and Review · Gate 5. Traceability is its own section, because spec §15 lists it separately.
- **Attention badges.** Show one per section, in priority order:

  | Section | Badge | When | Accessible name |
  |---|---|---|---|
  | Test Cases | "Review" | G5 is waiting | "Test Cases, Gate 5 waiting for approval" |
  | Test Cases | "Out of date" | `test_design` is stale | "Test Cases, out of date" |
  | Test Cases | "{n} ?" | Open questions exist, nothing above applies | "Test Cases, {n} open questions" |
  | Traceability | "Out of date" | `traceability` is stale | "Traceability, out of date" |

- **Fix the Phase 2 UX note.** `sectionBadge` srText becomes "Gate {n} waiting for approval". It drops "your" for everyone, because the badge doesn't know who can approve.
- **Members** live under the global footer item **Settings**, not inside the project, because membership belongs to the workspace.

### 4.3 Lifecycle, header and Overview
- **Lifecycle (`lib/lifecycle.ts`).** The Test design stage (steps 13 and 14) is now built:
  - Step 13 is "Test conditions & test cases" (Test Design Agent). Step 14 is "Traceability matrix", a derived step marked "Computed, no agent".
  - The **G5 diamond** "Test case quality" is shown after step 14.
  - The `traceability` status mirrors `test_design`, so it can never read "Running".
  - The Automation stage onward still shows "Phase 4".
- **Waiting copy depends on who is looking.** This fixes the Phase 2 UX note in the header, lifecycle and Overview:
  - Users with `can_approve` see "Waiting for your approval".
  - Everyone else sees "Waiting for approval by someone who can approve gates".
  - Make `STATUS_LABEL.waiting` a function of `canApprove`. In `ProjectHeader` and `attention.ts`, do the same.
  - The roadmap's P3-07 wording, "by an owner or admin", isn't used. A member can hold `can_approve`, so that wording would be wrong.
- **Who decides gates:** G3, G4 and G5 decisions all use one permission, `can_approve`, whatever the role.
  - Anyone with `can_approve`, including a member it was granted to, gets enabled gate buttons.
  - Anyone without it gets disabled buttons with the visible reason. No confirmation dialog opens.
  - In this spec, "owner or admin" refers only to managing members and credentials, never to gate decisions.
- **Unique link names** (avoids repeating P2 BUG-P2-22):
  - Every gate link is named "Review Gate {n}". Never use plain "Review gate".
  - Each "Show cases" link carries its subject, for example "Show 2 cases missing an expected result".
- **"Show all 21 steps" rows** for 13 and 14 offer:
  - "Regenerate test cases…" (§12.1)
  - "Review Gate 5"
  - "Open traceability"
- **Auto-advance notice.** After G4 approval, the step 13 row and the feed show "Started automatically after Gate 4 approval."
- **Overview, "Needs your attention".** Add these rows after "Gate waiting":
  - "{n} test cases have open questions." [Resolve open questions]
  - "Test cases are out of date." [Open test cases]
- **Overview, "At a glance".** Add two cards:
  - **Test cases:** "48 cases · 30 approved · 1 open question", then the G5 status line.
  - **Traceability:** "18 of 22 approved requirements covered · 2 untested high risks".
  - Before test design runs, each card shows "Starts after Gate 4."
- **Dashboard.** The "Awaiting approval" tile and the "Gate status" column now cover G2–G5. There is still no pass rate or execution number.
- **New agent in the feed:** "Test Design Agent" (short "Design Agent"). Example messages:
  - "Designed 48 test cases from 22 approved requirements using 6 techniques"
  - "No maximum length was discovered for Message; no upper boundary case is designed"
  - "Dropped 1 AI suggestion: no discovered limit supports a boundary at 1,001 characters"
  - "1 case needs a decision: REQ-0011 asks whether Message is optional"
  - "Gate 5: Test case quality is waiting for approval"

---

## 5. Test Cases workspace (P3-02)

### 5.1 Layout
```
[Project header + compact lifecycle]
Test Cases                                  Design run [2 · 13 Nov 11:50 ▾]  [Regenerate…] [New test case] [Open report]
Designed from Requirements v5 (Gate 3, 13 Nov) and Strategy v2 (Gate 4, 13 Nov) · Generated by rules
[Out-of-date callout, when stale]   [Gate 5 banner, when waiting]   [Open-questions callout, when any]
Tabs:  Test cases (48) | Conditions (21) | Test data (37) | Review · Gate 5
```
- The **"Designed from" line** is always visible. Each version links to its approval.
- **Design run** uses `VersionSelect`. Older runs are read-only, with the P2 older-version banner.
- **[Regenerate…]** opens §12.1. **[New test case]** goes to §8.2. **[Open report]** opens the Test Case Specification.
- **Viewers** see no [Regenerate…] and no [New test case]; there are no dead buttons. Members see both.
- **Open-questions callout** (amber, shown while any exist): "{n} test cases can't be approved yet: their expected result depends on a question that isn't answered. Decide each one to continue." [Show open questions] (filters the list).

### 5.2 Workspace states
| State | What the user sees | Copy |
|---|---|---|
| Not started: G4 not approved | `EmptyState` + G4 banner | "Test cases are designed from the approved Test Strategy. Approve Gate 4 first." [Review Gate 4] |
| G4 approved, design not run (Phase 2 projects, or after a failure) | `EmptyState` | "The strategy is approved. Design test cases to start." [Design test cases]. Viewers see the text only, with no button: "An owner, admin or member can start test design." |
| Queued / running | Card with a spinner and two steps (13 Test conditions & test cases · 14 Traceability) + feed filtered to the Test Design Agent | "The Test Design Agent is designing test cases from {n} approved requirements and the techniques in Strategy v{m}." |
| Failed | ErrorState + [Try again] | "Test design failed: {reason}. Your requirements and strategy are unaffected." |
| Rules (AI off) | `GeneratedByLabel` in header + info Callout (dismissible per user) | "Designed by rules (AI not configured). Rules cover form fields, sign-in, navigation and journeys. Values come from what discovery found; wording is plain. Review titles and expected results." |
| Mixed (AI on) | `GeneratedByLabel mixed` + Disclosure "Checks on AI suggestions ({n})" | "{n} AI suggestions were changed or dropped by our checks." Each line names one change, e.g. "Dropped: a boundary at 1,001 characters for Message. No maximum length was discovered." or "Corrected: a boundary value of 85 to the computed 81." |
| Partial (cap reached) | Amber Callout | "Test design stopped at the limit of 300 cases. {n} requirements weren't designed: {keys}." [Regenerate…] |
| Not designed (types) | Info Callout under the tabs | "Not designed in Phase 3: {Security, Performance}. They need separate approval and are designed in Phase 5." |
| Out of date | Warning Callout (`OutOfDateCallout`) | "Test cases may be out of date. They were designed from Strategy v2; Strategy v3 was approved on {date}. Regenerate to update them. Approved, edited and locked cases are kept, and the current cases stay in use until you apply changes." [Regenerate…] |
| Regeneration ready | Callout | "Regenerated test cases are ready to review." [Review changes] |
| Loading | Skeleton rows (8) | — |
| Load error | ErrorState in panel | "Couldn't load test cases. Try again." |
| Offline | P1 offline banner | "You're offline. Your changes are still here; save again when you reconnect." |

---

## 6. Test cases tab (list)

### 6.1 Table
```
Search [ TC id, title or step text ]  Status [Any ▾] Technique [Any ▾] Type [Any ▾] Priority [Any ▾] [More filters ▾]
Active: [Open question ×]  Clear filters                       Group by [None | Requirement | Feature]   Sort [Priority ▾]
Showing 12 of 48                                                    What do techniques mean? ⓘ  What do labels mean? ⓘ
+--------------------------------------------------------------------------------------------------------------------+
|[ ]| Test case                                  | Priority          | Expected result | Status            | Checks    | Requirements | Last result  |
|[ ]| TC-0005 Send the form with an empty Name   | ⌃ High            | ◌ Inferred      | ✓ Approved        | ✓ No      | REQ-0004     | Not run yet  |
|   | BVA · Functional · System · Regression     | from RISK-003     |                 |                   |   issues  |              |              |
|[ ]| TC-0019 Send the form with an empty Message| = Medium          | Not decided     | ○ Draft           | ✗ 1 must  | REQ-0006     | Not run yet  |
|   | Error guessing · Functional · System       | from RISK-005     |                 | ? Open question   |   fix     |              |              |
|[ ]| TC-0031 Sign in with the saved test account| ⌃⌃ Critical       | ◌ Inferred      | ○ Draft  ✎        | ⚠ 1 advice| REQ-0008     | Not run yet  |
|   | Decision table · Functional · Smoke        | from RISK-001     |                 |                   |           |              |              |
+--------------------------------------------------------------------------------------------------------------------+
{n} rejected and {m} deprecated test cases are hidden. Show them
```
**Columns, in priority order.** At `md`–`lg` the table scrolls inside a labelled container with a sticky first column. Below `md` it becomes cards (§6.5).

| Column | Content |
|---|---|
| Checkbox | Hidden for viewers. |
| **Test case** | <ul><li>Key (mono) and title form one link to the detail page.</li><li>The second line (`text-small fg-muted`) reads: technique (short name, with the full name in sr-only) · type · level · suites.</li><li>A source tag follows only when it isn't the header's: "Written by a person" or "AI-generated".</li></ul> |
| **Priority** | `PriorityValue`. The second line gives the source: "from RISK-003", "set by a person" (with the `UserPen` icon) or "no linked risk". |
| **Expected result** | `ProvenanceLabel` for the case's classification. Open-question cases show "Not decided" in amber text instead of a label. |
| **Status** | `StatusPill`: Draft / Approved / Rejected / Deprecated, plus flags with sr text: `? Open question`, 🔒 Locked, ✎ Edited by a person, ✦ Changed in latest generation. |
| **Checks** | Lint chip: "✗ {n} must fix", "⚠ {n} advice" or "✓ No issues". If both kinds exist, it shows "✗ {n} must fix" with "+{m} advice" on the second line. |
| **Requirements** | Keys, each a link. A case with none shows "None" with a warning icon. |
| **Last result** | Always "Not run yet" in `fg-muted`, with the tooltip "Execution arrives in Phase 4." It is never "—" alone, never a pill and never coloured. |

### 6.2 Filters, search, sort, group
- Built from `FilterBar` and `FilterChips`, URL-synced as in P2 §5.2.

  | Filter | Options |
  |---|---|
  | Status | Draft, Approved, Rejected, Deprecated (default "Any except Rejected and Deprecated") |
  | Technique | Equivalence partitioning, Boundary value analysis, Decision table, State transition, Use case, Error guessing, Other |
  | Type | The in-scope test types from the strategy (functional, smoke, accessibility, compatibility, usability…) |
  | Priority | Critical, High, Medium, Low |
  | More filters | <ul><li>Level · Risk level · Suite (Smoke, Regression) · Requirement · Feature</li><li>Checks (Must fix · Advice only · No issues)</li><li>Open question</li><li>Source (Rules · AI · Person)</li><li>Priority set by a person · Locked · Edited by people · Changed in latest generation · No requirement link</li></ul> |

- **Search** matches the key, title, objective and step text. There is no fuzzy matching.
- **Sort:** Priority (default; ties broken by risk score, highest first, then key) · Key · Status · Last changed.
- **Group by** uses `Segmented`: None | Requirement | Feature.
  - Grouped tables use one `<tbody>` per group, with a `th scope="rowgroup"` header row such as "REQ-0004 Contact form requires Name · 4 cases · 3 approved".
  - A case linked to two requirements appears in both groups, marked "Also in REQ-0005".
  - Cases with no link go in the last group, "Not linked to a requirement".
- **Explainers:** "What do techniques mean?" (a `TechniqueLegend` popover, §7.4) and the existing `ProvenanceLegend`.

### 6.3 Bulk actions (members, owners, admins)
```
12 selected   [Approve 12]  [Reject…]  [Deprecate…]  [Add to suite ▾]  [Lock]  [Unlock]   Clear selection
```
- Uses `BulkActionBar`. It is a `role="region"` labelled "Bulk actions", and selection changes are announced ("12 test cases selected"). The header-checkbox "Select all {m} matching test cases" pattern from P2 applies. The API limit is 200; above that the button reads "Approve first 200".
- **Bulk approve guard.** If any selected case can't be approved, show a `ConfirmDialog` first:
  - Title: "Approve 12 test cases?"
  - Body: "3 can't be approved yet: 2 have checks you must fix and 1 has an open question. They'll stay as drafts."
  - Actions: [Cancel] [Approve 9]. The skipped cases are listed below the body, each with its reason.
  - If all can be approved, it runs immediately.
  - The toast reads "9 test cases approved. 3 skipped." with [Undo] (10 s; returns them to draft) and [Show skipped] (filters to them).
- **Deprecate…** applies only to approved cases. Others are skipped with "Only approved cases can be deprecated".
- **Add to suite ▾** offers Smoke and Regression, each with add and remove. This is an edit, so it reopens G5 for approved cases. The menu shows "Gate 5 will need approval again." when that applies.
- **After G5 approval,** any bulk change shows this line in the bar before the action: "Changing approved cases reopens Gate 5."
- **Viewers** get no checkboxes and no bar.

### 6.4 List states
| State | Copy |
|---|---|
| Filters match nothing | "No test cases match these filters." [Clear filters] |
| All rejected | "All test cases are rejected. Restore some, add one, or regenerate." [Show rejected] [New test case] |
| Bulk action partly failed | Toast (error): "{n} of {m} changed. {k} weren't: someone edited them since." [Show them] |
| No permission (viewer opened a link with `?edit=1`) | Read-only view + neutral Callout: "You have view-only access. Ask an owner or admin for member access to edit test cases." |

### 6.5 375 px cards
```
[ ] TC-0019                                ○ Draft · ? Open question
    Send the form with an empty Message
    Error guessing · Functional · System
    Priority = Medium (RISK-005) · Expected: Not decided
    ✗ 1 must fix · REQ-0006 · Not run yet
```
- The checkbox target is 44×44 px and sits top-left. The whole title is the link; the card itself is not a click target.
- Filters open in a full-screen sheet ([Filters ({n})]). Group by and Sort move into the sheet.
- The bulk bar shows [Approve {n}] plus `⋯` for the other actions.
- **There must be no horizontal page scroll at 375 px or at 320 px.**

---

## 7. Conditions tab: the test design results (P3-01a)

This tab answers "what did the agent design, with which technique, and where do the values come from?"

### 7.1 Layout
```
Group by [Feature | Requirement | Technique]                                Technique coverage: 19 of 21 conditions complete
Form · Contact (/contact)                                                                                           (h2)
  REQ-0004 Contact form requires Name   ✓ Approved · Risk High (RISK-003)                                           (h3)
  +-- TCOND-0003 · Name length ----------------------------------- [BVA Boundary value analysis] [✓ Approved] [Rules] -+
  | Why: Name is required, so the shortest allowed value is 1 character. 2-value boundaries (risk High uses 3-value     |
  | only for High or Very high risk requirements: this one is High, so 3 values are used).                              |
  | Constraint: required (Name) · from [EV-0042 DOM] · AC-0010                                                          |
  | Coverage items (3 of 3 have a case)                                                                                 |
  | | Value                  | What it tests             | Expected            | Test data | Test case          |      |
  | | (empty) 0 characters   | Just below the minimum    | Submission blocked  | TD-0004   | TC-0005 ✓ Approved |      |
  | | 1 character "A"        | The minimum               | Accepted            | TD-0005   | TC-0006 ○ Draft    |      |
  | | 2 characters "Ab"      | Just above the minimum    | Accepted            | TD-0006   | TC-0007 ○ Draft    |      |
  | ⓘ No maximum length was discovered for Name; no upper boundary case is designed.                                    |
  |                                                              [Edit notes] [Reject…] [⋯ Lock · History · Traceability]|
  +---------------------------------------------------------------------------------------------------------------------+
```
- Each condition is a `Card`. Its title is an `h4` that includes the key, so headings stay hierarchical.
- **The technique chip** (`TechniqueChip`, new) shows the short name and the full name at `md+`. Below `md` it shows the short name, with the full name in sr-only and in a tooltip.
- **"Why"** is the `design_basis`, in plain language.
- **"Constraint"** names the discovered attribute or AC, and links to its evidence (`EvidenceDrawer`) or AC. When values come from an AC, it reads "Constraint: test values from AC-0012". Every BVA and EP value must show a constraint line. A condition without one is a defect.
- **Coverage items** form a real table with these columns:
  - **Value:** literal values in mono. Whitespace is made visible: "␣␣␣ (3 spaces)", with sr text "three spaces". An empty value reads "(empty) 0 characters". Long values are truncated to "aaaa…aaa (81 characters)", with a [Show full value] button.
  - **What it tests:** the partition or boundary, in words.
  - **Expected:** the expected result.
  - **Test data:** the TD key, which opens the test data drawer.
  - **Test case:** the TC key with its status. If no case covers the item, the cell reads "No case", and the card header shows "2 of 3 have a case".
- Per technique, the coverage table also shows:

  | Technique | Extra columns |
  |---|---|
  | Decision table | One row per rule: Email · Password · Outcome. Values are words ("valid", "wrong", "empty"); the password is always "the saved test account" or "wrong" |
  | State transition | From state → Event → To state, plus one row per tested path |
  | Use case | Main flow steps, with the journey link |
  | Error guessing | The catalogue entry ("Whitespace-only input in a required field") and the evidence it is tied to |

- **The note line** (`Info` icon) carries "no boundary" statements. They must appear whenever a field has no constraint for one side.
- **Open-question condition:** an amber line reads "Expected result not decided: REQ-0011 asks whether Message is optional." It links to REQ-0011 and to the case.
- **Actions:**
  - [Edit notes]: description and design-basis notes only. Values are never editable; the help text says "Values are calculated from the constraint. To change them, change the requirement or the case."
  - [Reject…]: the dialog states "Rejecting TCOND-0003 also rejects its 2 draft test cases: TC-0006, TC-0007. Approved cases are kept." [Cancel] [Reject condition and 2 drafts].
  - Lock, History (`RevisionHistory`) and View traceability.
- **Condition drawer** (`?condition=`) shows the same card full-height. It is opened from case detail and from test data.

### 7.2 Header summary
A row of `StatTile`s above the groups. Each tile links to the filtered case list.
- Cases by technique, e.g. "BVA 8", "EP 12".
- "Technique coverage: {n} of {m} conditions complete".
- "Not designed: 2 test types", which opens the Not-designed callout.

### 7.3 States
| State | Copy |
|---|---|
| None (all rejected) | "No test conditions. Regenerate to design them again." [Regenerate…] |
| Loading / error | Skeleton cards / "Couldn't load test conditions. Try again." |

### 7.4 Technique names and definitions (`TechniqueLegend`, tooltips, report glossary)
| Short | Full name | Definition |
|---|---|---|
| EP | Equivalence partitioning | "Splits inputs into groups the application should treat the same way, and tests one value from each group." |
| BVA | Boundary value analysis | "Tests the values at the edges of what's allowed, where mistakes are most likely." |
| DT | Decision table | "Tests each combination of conditions that leads to a different outcome." |
| ST | State transition | "Tests moving between states, such as signed out to signed in." |
| UC | Use case | "Follows a complete task the way a user would." |
| EG | Error guessing | "Tries inputs and actions that often cause problems, based on experience." |
| — | Other | "Written by a person without a named technique." |

---

## 8. Test case detail, edit, new (P3-02)

### 8.1 Detail (`/projects/[id]/test-cases/TC-0019`)
```
Test Cases / TC-0019                                                 ‹ Previous   7 of 12 (filtered)   Next ›
TC-0019 · Send the contact form with an empty Message                                                  (h1)
[○ Draft] [? Open question] [EG Error guessing] Priority = Medium   [Rules]        [Approve] [Reject…] [Edit] [⋯]
                                                ⋯ = Duplicate · Lock · Ask AI QA Analyst about this · View traceability · Copy link
+-- Open question (amber Callout) --------------------------------------------------------------------------------+
| The expected result isn't decided. REQ-0011 asks whether Message is optional.                                   |
| Write what should happen, or resolve REQ-0011 and regenerate. This case can't be approved until then.           |
| [Write expected result]  [Open REQ-0011]                                                                        |
+-----------------------------------------------------------------------------------------------------------------+
+-- main (2/3) ------------------------------------------------+ +-- side (1/3) ----------------------------------+
| Objective                                                    | | Requirements  REQ-0006 Contact form purpose →  |
| Check what happens when the form is sent without a Message.  | | Acceptance    AC-0015 →                        |
|                                                              | | Condition     TCOND-0011 Error guessing →      |
| Why this case exists                                         | | Risk          RISK-005 Medium (score 6) →      |
| Message is optional while Name and Email are required. An    | |------------------------------------------------|
| optional field next to required ones is a common source of   | | Test type     Functional                       |
| mistakes. Evidence: [EV-0044 DOM]                            | | Test level    System                           |
|                                                              | | Suites        Regression                       |
| Preconditions                                                | | Priority      Medium, from RISK-005 (Medium)   |
| 1. On /contact                                               | |               [Set priority…]                  |
| 2. Signed out                                                | | Expected result label  Not decided             |
|                                                              | |------------------------------------------------|
| Test data  [TD-0002 Name "Ada Lovelace"] [TD-0008 Email …]   | | Last result   Not run yet                      |
|                                                              | |   Execution arrives in Phase 4.                |
| Steps                                                        | | Execution status  Not run (read-only)          |
| # | Action                       | Data     | Expected       | | Automation    Manual only (preliminary)        |
| 1 | Enter TD-0002 in Name        | TD-0002  | Name shows it  | |   Open question: needs a decided result.       |
| 2 | Enter TD-0008 in Email       | TD-0008  | Email shows it | |   Preliminary: assessed in Phase 4.            |
| 3 | Leave Message empty          | —        | Message empty  | | Side effects  [Submits a form]                 |
| 4 | Press Send message           | —        | Not decided ✗  | |   Labels only. Nothing runs in Phase 3.        |
|                                                              | | Evidence      [EV-0044] [EV-0040]              |
| Overall expected result                                      | |------------------------------------------------|
| Not decided: REQ-0011 asks whether Message is optional.      | | Quality checks (1)                             |
|                                                              | |  ✗ Must fix · Open question                    |
|                                                              | |    Write the expected result, or resolve       |
|                                                              | |    REQ-0011 and regenerate. [Go to step 4]     |
|                                                              | |------------------------------------------------|
|                                                              | | Revision history (2)              View all     |
+--------------------------------------------------------------+ +------------------------------------------------+
```
**Every spec §7 field is visible with a label:**
- ID, requirement reference, title, objective, preconditions, test data, steps, expected results, type, level, priority
- automation suitability, execution status, evidence refs

The extra fields are technique, condition, "Why this case exists", suites, risk and side effects. If a field is empty it says so, e.g. "Preconditions: None"; it is never hidden.

**Header actions by status** (members, owners, admins):

| Status | Actions |
|---|---|
| Draft | [Approve] (primary), [Reject…], [Edit] |
| Approved | [Edit], [Deprecate…]; `⋯` adds "Move back to draft" |
| Rejected | [Restore to draft] |
| Deprecated | No status actions. The banner reads "Deprecated by {name}, {date}: {reason}. Kept for traceability and history." |

- **Viewers** see no action buttons. `⋯` keeps only Copy link, View traceability and Ask AI QA Analyst.
- **Approve with blockers.** [Approve] stays visible but is disabled, with the visible reason under the header (`aria-describedby`):
  - "Fix 1 check before approving: open question." or "Fix 2 checks before approving: missing expected result (step 4), not linked to a requirement."
  - There is never a dialog first. This is the R2-04 lesson applied to cases.
  - If the server still returns 422, the lint items show next to their step (§8.4).

**Steps table:**
- One expected result per step. A real `<table>` with caption "Steps for TC-0019".
- Data chips open the test data drawer.
- A missing per-step expected result shows "Missing" in danger text with a `CircleX` icon and sr text "missing expected result".
- Below `md` each step is a card: "Step 4 · Action … · Data … · Expected …".

**Priority row** (§10) and the **Last result** row ("Not run yet") always appear.

**The case has no execution controls.** There are no "Run" buttons, and no pass or fail anywhere.

**Revisions:** the `RevisionHistory` drawer, with change types Generated · Regenerated · Edited · Approved · Rejected · Deprecated · Locked · Priority set · Applied from AI QA Analyst proposal. `?v=<n>` is read-only with the P2 banner.

### 8.2 Edit form and new case
The main column turns into a form, as in P2 §5.3. The side column stays visible but read-only.

| Field | Control | Rules / copy |
|---|---|---|
| Title | `TextField`, required, 140 | "Give the case a short, specific title." |
| Objective | `TextArea`, required | "Say what this case checks." |
| Requirements | Multi-select of non-rejected requirements (key + title) | Optional on save. Without one: lint "Not linked to a requirement" (Must fix). |
| Acceptance criteria | Multi-select, filtered to the chosen requirements | Optional |
| Technique | `SelectField` (§7.4 list, "Other" allowed) | Generated cases: read-only, with "Set by the design rules." |
| Preconditions | `ChecklistEditor` | Max 10 |
| Steps | `StepEditor` (§8.3) | ≥ 1 step |
| Overall expected result | `TextArea`, required | "Describe what the user should see at the end." |
| Test type / level | `SelectField` from the strategy's in-scope types and levels | An out-of-strategy type gives Advice "Test type not in the strategy". |
| Suites | Checkboxes Smoke, Regression | — |
| Reason for change | `TextField`, optional, 200 | Stored in the revision |

**Never editable** (shown read-only with the help text): the expected-result label, risk level, derived priority, execution status, lint results, and generated values. The help text reads: "Labels, risk and checks are worked out by the system from evidence and links."

**Banners inside the form:**
- Editing an approved case: "This case is approved. Saving moves it back to Draft." If G5 is approved, it adds: "Gate 5 will need approval again."
- Locked: [Edit] is replaced by [Unlock to edit] (P2 copy pattern).
- **Conflict (409):** the P2 §5.3 danger Callout and diff. "Someone else changed TC-0019 while you were editing (now version 4 by A. Lee)." [Compare with their version] [Discard my changes]. Typed text is never lost.
- Leaving with unsaved changes: "Discard unsaved changes to TC-0019?" [Keep editing] [Discard].

**Live check preview.** A quiet panel at the bottom of the form, titled "Checks (preview)", lists the lint items as they change. It is debounced at 500 ms and never interrupts focus. Below it: "The server checks again when you save." Vague words are highlighted in the field with `<mark>`, and the hint names them: "'works' is vague. Say exactly what the user sees."

**Save:** toast "TC-0019 saved as version {n}." Focus returns to [Edit]. An approved case also gets "Moved back to Draft".

**First change after G5 approval** (one-time warning toast, per user per approval): "Test cases changed since Gate 5 approval. Approve Gate 5 again so the changes become the approved set."

**New test case** (`/test-cases/new`):
- The same form, empty. The key is assigned on save ("New test case" until then).
- Source: Person. Label: Assumed. Status: Draft. Priority: derived on save from the linked requirements' risk.
- The info line at the top reads: "Cases you write are labelled Assumed: the system has no evidence for their expected result. Approving them confirms them for testing."
- Toast "TC-0049 created as a draft."

**Duplicate** creates a draft copy owned by a person and opens it in edit mode. The title starts "Copy of …". Toast "TC-0050 created from TC-0019."

### 8.3 `StepEditor` (new; keyboard-first, no drag)
```
Step 1                                                         [↑ Move up] [↓ Move down] [Remove]
  Action *      [ Enter TD-0002 in Name                                   ]
  Test data     [TD-0002 Name "Ada Lovelace" ×]  [Add test data ▾]
  Expected *    [ Name shows "Ada Lovelace"                               ]
[Add step]                                                              4 steps · 15 recommended maximum
```
- Each step is a `fieldset` with `legend` "Step {n}". The buttons have full names, e.g. "Move step 2 up". Move up is disabled on the first step and Move down on the last.
- **After a move,** focus stays on the same button in the step's new position, and the region announces "Step 3 moved to position 2". **After Remove,** focus goes to the next step's Action field (or [Add step] if none), and the region announces "Step 3 removed".
- **[Add step]** appends a step and focuses its Action field.
- **[Add test data ▾]** is a searchable listbox of active TD items for the same form, showing key, field, kind and value. Password fields can only take a secret reference, and the option reads "Saved test account (value never shown)". The last option is "New test data item…", which opens §11.3 in a dialog and returns.
- **Validation on save:** "Describe the action for step {n}." / "Describe the expected result for step {n}." Focus goes to the first error, and an error summary appears at the top of the form with links to each field.
- **Typing a password or email** that looks real into an Action or Expected field triggers the synthetic guard error on save: "Step 2 contains what looks like a password. Reference the saved test account instead." or "Step 2 contains a real-looking email address. Use a test data item with a reserved domain such as example.com."

### 8.4 Writing the expected result for an open question (D6)
- [Write expected result] opens edit mode, focused on the first undecided expected result (step 4 or the overall result). The field is prefilled empty, never with the "Not decided" text.
- The hint under the field reads: "Decide what should happen. Example: 'Submission is blocked and Message is identified as required.' Your answer is labelled Assumed until REQ-0011 is resolved."
- **On save:** the open question clears and the case is flagged ✎ Edited. The label becomes Assumed, with "Written by a person". Toast: "Expected result saved. TC-0019 can now be approved."
- **The alternative route** is resolving REQ-0011. The callout links there. The requirement detail shows a reverse note: "1 test case is waiting for this answer: TC-0019."

### 8.5 Reject, deprecate, restore
**Reject dialog** (reuses `RejectDialog` with case reasons):
- Reasons: Not useful · Duplicate of another test case (needs a case picker) · Wrong expected result · Out of scope · Other (needs a comment).
- Footer: "The agent won't propose this case again. You can restore it later."
- Buttons: [Cancel] [Reject test case].

**Deprecate dialog** (approved cases only):
- Title: "Deprecate TC-0009?"
- Reason (required): "The requirement or constraint changed" · "Replaced by another test case" (needs a picker) · "Other" (needs a comment).
- Body: "Deprecated cases stay in traceability and history, marked Deprecated. They won't be automated or run. This can't be undone."
- Buttons: [Cancel] [Deprecate test case].
- There is **no Delete anywhere**.

**Move back to draft** and **Restore to draft** need no dialog. The toast offers [Undo].

### 8.6 Lint vocabulary (checks panel, list chip, G5, reports)
| Code | Severity | Name shown | Fix hint |
|---|---|---|---|
| `missing_steps` | Must fix | No steps | "Add at least one step." |
| `missing_expected_result` | Must fix | Missing expected result | "Write what should happen after step {n}." / "…at the end of the case." |
| `orphan_case` | Must fix | Not linked to a requirement | "Link the requirement this case checks." |
| `unresolved_placeholder` | Must fix | Unfinished text | "Replace '{token}' in {field} with the real wording." |
| `technique_data_mismatch` | Must fix | Data doesn't match the technique | "A boundary value case needs test data at the boundary. Add it, or change the technique." |
| `literal_secret` | Must fix | Password typed into the case | "Use the saved test account instead of a typed password." |
| `non_synthetic_data` | Must fix | Real-looking data | "Use synthetic data, such as an example.com email." |
| `open_question` | Must fix | Open question | "Write the expected result, or resolve {REQ} and regenerate." |
| `vague_wording` | Advice | Vague wording | "'{word}' is vague. Say exactly what the user sees, e.g. 'The error \"Name is required\" is shown'." |
| `too_many_steps` | Advice | More than 15 steps | "Split it into smaller cases." |
| `duplicate_case` | Advice | Same as {TC} | "Reject one, or change its data." |
| `type_not_in_strategy` | Advice | Test type not in the strategy | "Change the type, or add it to the Test Strategy." |
| `linked_requirement_rejected` | Advice | Linked requirement was rejected | "Relink the case, or deprecate it." |
| `priority_below_risk` | Advice | Priority lower than its risk | "Check the reason, or clear the override." |

Each item in the case panel has a [Go to {field}] button that focuses the field in edit mode.

### 8.7 Detail states
| State | Copy |
|---|---|
| Loading | Skeleton header and two columns |
| Not found / other organisation | App 404: "We couldn't find TC-0999 in this project." [Back to test cases] |
| Load error | "Couldn't load TC-0019. Try again." |
| Save error | InlineError above the actions: "Couldn't save TC-0019. Your changes are still here. Try again." |
| Approve rejected by server (422) | InlineError: "TC-0019 can't be approved: {lint names}." Items are highlighted in place. |
| Viewer | Read-only, no actions, no Callout (§6.4 copy only on `?edit=1`) |
| Older version | "You're viewing version {n} of TC-0019. The latest is version {m}." [View latest] |

---

## 9. Requirement detail and risk register additions

**Requirement detail, "Linked test cases"** replaces the Phase 2 empty text:
```
Linked test cases (4)                                              View traceability
 TC-0005 Send the form with an empty Name     BVA  ✓ Approved
 TC-0006 Name with 1 character                BVA  ○ Draft
 …
 [New test case for REQ-0004]
```
- The list is ordered by priority and shows key, title, technique (short, with full sr) and status.
- The "New test case for REQ-0004" button is shown to members and above.

| Requirement state | Copy |
|---|---|
| Before design, G4 not approved | "Test cases are designed after the Test Strategy is approved (Gate 4)." |
| Design ran, none for this requirement | "No test cases yet." + amber note if approved: "This approved requirement isn't covered." [New test case for REQ-0004] |
| Requirement is Draft / Needs info | "Test cases are designed only from approved requirements." |
| Requirement rejected | "Rejected requirements get no test cases." |
| Has open-question cases | Line: "{n} test case is waiting for this answer: TC-0019." |

**Risk register, "Test coverage" column** (P3-05):
- "3 cases, 2 approved", or "No approved case" in danger text with an icon.
- Accepted risks show "Accepted · not required".
- A filter option "No approved case" is added. Below `md`, the value appears as a line on the risk card.

---

## 10. Priority from risk (P3-05)

**Display** (`PriorityValue` + `PrioritySource`):
- **Derived:** "High · from RISK-003 (High, score 12): Sign-in fails for valid users". RISK-003 links to the register row.
  - With several risks, it names the highest: "Critical · from RISK-001 (Very high, 20) and 2 other risks". "2 other risks" is a button that opens a popover listing them.
  - If the highest is accepted: "High · from RISK-003 (High, accepted)".
- **No risk:** "Low · no linked risk".
- **Override:** "Low · set by Jane Doe on 13 Nov: 'Covered by the payment provider's own tests.'" A second muted line reads "Risk-based priority: High (RISK-003)". If the override is below the derived priority for High or Very high risk, an Advice item appears: "Priority lower than its risk".

**[Set priority…] dialog** (members and above; viewers don't see the button):
```
Set priority for TC-0031
Risk-based priority: High, from RISK-003 (High, score 12)
Priority   ( ) Critical  ( ) High  (●) Medium  ( ) Low
Reason *   [                                                    ]
           Explain why this case needs a different priority. Shown on the case and in reports.
[Use risk-based priority]                          [Cancel]  [Set priority]
```
- The radios are a `fieldset`. Reason is required (max 300): "Explain why you changed the priority."
- Choosing a priority below the derived one for a High or Very high risk shows an inline warning before saving: "This is lower than the risk suggests. The case will show a warning."
- **[Use risk-based priority]** clears the override, with a confirmation toast "Priority set back to High (from RISK-003)."
- An override is human content. On an approved case it reopens G5 (the dialog says so).
- **Risk changes never reopen anything.** When a risk is re-rated, derived priorities update silently. The case history does **not** gain a revision, and the list doesn't flash. The P2 risk row toast gains: "Priority updated on {n} test cases."

---

## 11. Test data tab (P3-03)

### 11.1 Layout
```
Filter: Form [Any ▾] Kind [Any ▾] Use [Any ▾]   Search [TD id, field or value]                  [Add test data]
ⓘ Synthetic data only. Values are generated for testing and aren't real people's details. Saved logins are referenced, never shown.
Form · Contact (/contact)                                                                                   (h2)
  Name                                                                                                      (h3)
  | Key     | Kind       | Value                          | Length | Used by        | Status    |          |
  | TD-0004 | Boundary   | (empty)                        | 0      | 1 case: TC-0005| Active    | [Edit] [⋯]|
  | TD-0005 | Boundary   | A                              | 1      | 1 case         | Active 🔒 | [Edit] [⋯]|
  | TD-0002 | Valid      | Ada Lovelace                   | 12     | 6 cases        | Active    | [Edit] [⋯]|
  Email
  | TD-0008 | Valid      | ada.lovelace@example.com       | 24     | 6 cases        | Active    | …        |
  | TD-0009 | Invalid    | ada.lovelace.example.com       | 24     | 1 case         | Active    | …        |
Form · Sign in (/login)
  Password
  | TD-0020 | Saved test account | Uses the saved test account (value never shown) | — | 3 cases | Active |  |
```
- **Kind badges** (text + icon): Valid (`Check`), Invalid (`X`), Boundary (`Ruler`), Saved test account (`KeyRound`).
- **Every value is labelled synthetic.** The info line at the top covers the whole tab. The detail drawer adds a "Synthetic" `Badge`.
- **Values** use the same visible-whitespace, empty and truncation rules as §7.1. Values are always escaped text.
- **"Used by"** links to the case list filtered to those cases. "Not used" items are listed under a "Not used ({n})" disclosure at the end of each field.
- **Saved test account rows:**
  - They never show a username, password, mask or asterisks.
  - Owners and admins also see a [Manage in Project settings] link.
  - **If no secret is saved:** a warning reads "No test account is saved, so cases that sign in can only be partly automated. Add one in Project settings." The link is shown to owners and admins. Others see "Ask an owner or admin to add one."
- **Detail drawer** (`?data=TD-0004`): key, field, form, kind, value, length, generator rule ("Generated by rule: required-min-length"), status, "Used by" cases with status, a condition link and revision history.

### 11.2 Edit (inline row form; members and above)
- Fields: Name (optional label) and Value (`TextArea`, max 5,000, with a live character count "0 characters").
- Saved-test-account items have no Value field. They show the secret name only ("Saved test account: login credentials").
- **If the item is used by approved cases,** a note appears above Save: "Used by 2 approved cases (TC-0002, TC-0005). Saving moves them back to Draft and Gate 5 will need approval again." The button reads [Save and reopen review].
- Toast: "TD-0004 saved as version {n}." If cases were affected: "2 approved cases moved back to Draft."

**Guard errors** (field error; focus moves to the field):

| Case | Copy |
|---|---|
| Real-looking email | "Use a reserved domain such as example.com; real-looking data isn't allowed." |
| Real-looking phone | "Use a fictional number, such as +44 20 7946 0000; real-looking numbers aren't allowed." |
| Card-like number | "This looks like a real card number. Use a published test card such as 4111 1111 1111 1111." |
| Password field with a value | "Passwords must reference saved test credentials." |
| Boundary length changed | "This item tests the 81-character boundary; change the case instead." |
| Too long | "Values can be up to 5,000 characters." |

### 11.3 Add test data
`[Add test data]` opens a dialog with these fields:
- Form and field: a picker of discovered fields.
- Kind: Valid / Invalid / Boundary. "Saved test account" is offered only for password fields, and is the only kind allowed there.
- Value.

The same guard applies. The source becomes Person.

### 11.4 Retire
- `⋯ → Retire`. If the item is unused, a `ConfirmDialog` asks "Retire TD-0011? It stays in history and can't be added to new steps." [Retire].
- **If the item is in use by a non-deprecated case,** Retire is still listed but opens an explanation dialog instead: "TD-0004 is used by TC-0005 and TC-0006. Change those cases to use other data first." [Show these cases]. The API's 409 maps to the same copy.

### 11.5 States
| State | Copy |
|---|---|
| None | "No test data yet. It's created with the test cases." |
| Filters match nothing | "No test data matches these filters." [Clear filters] |
| Loading / error | Skeleton / "Couldn't load test data. Try again." |
| Save error | "Couldn't save TD-0004. Your value is still here. Try again." |
| Viewer | No Edit, Retire or Add. Read-only table. |
| 375 px | Each item becomes a card: key + kind, field, value, length, Used by. Groups stay as headings. |

---

## 12. Regeneration and change review (P3-01b)

### 12.1 Regenerate dialog
```
Regenerate test cases?
The Test Design Agent will design test cases again from Requirements v5 and Strategy v3.
• 14 approved, edited, locked or person-written cases are kept. Any changes the agent suggests for them are shown as proposals.
• 6 rejected cases stay rejected and won't be proposed again.
• Nothing changes until you review and apply the results.
Guidance for the agent (optional)  [ e.g. "More negative cases for sign-in."            ]
                                                                   [Cancel]  [Regenerate]
```
- When AI is off, the dialog adds: "AI isn't set up, so the rules design the cases; guidance is saved but not used." The guidance field stays visible, with that hint.
- **A pending review already exists (409):** "A regeneration is waiting for review. Review or discard it before starting another." [Review changes]
- **Running:** "Regenerating test cases… The current cases stay in use until you apply changes."

### 12.2 Review screen (`/test-cases/changes?run=3`, reuse `ChangeReviewScreen` + `ChangeReview`)
```
Review regenerated test cases                                 Design run 2 (current) → proposed run 3
Summary: 5 added · 3 changed · 2 no longer found · 4 proposals for protected cases · 31 unchanged
Applies to test cases, conditions and test data.                [Accept all suggested]  [Apply 10 changes]
ADDED (5)
+ TC-0051 Sign in with an email that has no domain   [EP] Priority High · RISK-001   (●) Accept ( ) Skip
  Steps (3) · Show
CHANGED (3) — not protected
~ TC-0012 … Expected: ~~Error shown~~ ++The error "Enter a valid email" is shown++     (●) Accept ( ) Keep current
PROPOSALS FOR PROTECTED CASES (4) — approved, edited, locked or written by people
~ TC-0005 ✓ Approved · Send the form with an empty Name                               ( ) Accept (●) Keep current
NO LONGER FOUND (2)
− TC-0022 [Draft] Phone number accepts letters                                        (●) Mark rejected ( ) Keep
− TC-0009 [Approved] Message at 81 characters                                         ( ) Mark rejected (●) Keep
  The requirement or constraint behind this case changed; consider deprecating it.    [Open TC-0009]
UNCHANGED (31) — collapsed
```
- **Rows that change values** show the constraint line under the diff, e.g. "Constraint: maxlength=80 (EV-0051)". The reviewer can see why a value moved.
- **Defaults** follow the roadmap: Added → Accept; Changed (unprotected) → Accept; Protected → Keep current; Draft no longer found → Mark rejected; Approved no longer found → **Keep**, with the deprecation note.
- **Condition and test data changes** appear in the same groups, with their key prefixes (`TCOND-`, `TD-`). The filter offers "All changes · Test cases · Conditions · Test data".
- **Under the Apply button,** when G5 is approved: "Gate 5 will need approval again."
- **[Discard regeneration]:** "Discard these results? Design run 2 stays current."
- **After Apply:** the list opens filtered to "Changed in latest generation". Toast: "Design run 3 applied: 10 changes."
- **Viewer:** the screen is read-only. The radios are replaced by the default decision as text, and a neutral Callout reads "You have view-only access. A member, owner or admin can apply these changes."

---

## 13. Review · Gate 5 tab (reuse `GateReviewPanel`)

### 13.1 Layout
```
StatTiles: [Test cases 48] [Approved 30] [Draft 12] [Open questions 1] [Must fix 2]      (each links to a filtered list)

+-- Gate 5 · Test case quality -------------------------- [⚠ Waiting for your approval | Waiting for approval by someone who can approve gates] -+
| Based on Requirements v5 (Gate 3) and Strategy v2 (Gate 4) · Design run 2                                                       |
|                                                                                                                                 |
| MUST FIX BEFORE APPROVAL (2)                                                                               (h3, CircleX)         |
| ✗ 1 test case has an open question: TC-0019.                    [Show the case with an open question]                          |
| ✗ RISK-003 (High) is open and REQ-0002 has no approved test case. Approve a case for REQ-0002, or accept the risk with a comment.|
|                                                                   [Show test cases for REQ-0002]  [Open RISK-003]               |
|                                                                                                                                 |
| ADVICE (4)                                                                                                 (h3, TriangleAlert)  |
| ⚠ 12 drafts will be left out of the approved set.                [Show 12 draft test cases]                                     |
| ⚠ 2 approved requirements have no approved test case: REQ-0013, REQ-0017.  [Show uncovered requirements]                        |
| ⚠ 3 approved acceptance criteria have no test case.               [Show uncovered acceptance criteria]                           |
| ⚠ 2 drafts have checks you must fix: TC-0004, TC-0011.            [Show 2 drafts with checks to fix]                             |
|                                                                                                                                 |
| PASSED (3)                                                                         (h3, CircleCheck; collapsed under Disclosure) |
| ✓ Strategy v2 is approved, and these cases were designed from it                                                               |
| ✓ 30 test cases approved                                                                                                       |
| ✓ No approved case has checks you must fix                                                                                     |
|                                                                                                                                 |
| Accepted risks (1): RISK-008 Medium, accepted by J. Doe: "Third-party widget, out of our control."                             |
|                                                                                                                                 |
| QUALITY CHECKS BY TYPE                                                                       (Disclosure, open when any exist)   |
| Must fix                                                                                                                         |
|   Open question ......................... 1 case   [Show 1 case: open question]                                               |
|   Missing expected result ................ 1 case   [Show 1 case: missing expected result]                                     |
|   Not linked to a requirement ............ 1 case   [Show 1 case: not linked to a requirement]                                 |
| Advice                                                                                                                           |
|   Vague wording .......................... 4 cases  [Show 4 cases: vague wording]                                              |
|   Priority lower than its risk ........... 1 case   [Show 1 case: priority lower than its risk]                                |
|                                                                                                                                 |
| Recommendation: Do not approve yet. Resolve the open question and cover REQ-0002.                     [Generated by rules]       |
| Comment [                                                                   ]                                                   |
| [Approve test cases] (disabled)  [Request changes]                                    View Test Case Specification →           |
| Fix the 2 items under "Must fix before approval" to approve.                                                                   |
+---------------------------------------------------------------------------------------------------------------------------------+
```
**How severity is grouped:**
- The checks are split into three `h3` groups: **Must fix before approval**, **Advice** and **Passed**. Each group is a list.
- Every line is computed by code and names its items.
- Every line that names items has its own uniquely named link to the filtered list.
- "Quality checks by type" is the lint summary (`GET /test-design/lint`). It groups by severity, then by code, with case counts and links.

**Approve button states** (the R2-04 lesson: explain before, never after a dialog):

| Who / state | Button | Visible reason under the buttons (`aria-describedby`) |
|---|---|---|
| Approver, blockers exist | [Approve test cases] disabled | "Fix the {n} items under 'Must fix before approval' to approve." |
| Approver, no blockers, drafts left | Enabled → ConfirmDialog | Title "Approve with 12 drafts?" · Body "Only the 30 approved cases become the approved set. The 12 drafts are left out until you approve them and Gate 5 is approved again." · [Review drafts] [Approve test cases] |
| Approver, no blockers, no drafts | Enabled; approves immediately | — |
| No `can_approve` (any role without it: viewer, member, or admin with it turned off) | Both buttons disabled | Neutral Callout above the buttons: "You can review this gate, but approving needs gate-approval permission. Ask someone who can approve gates, or ask an owner or admin to give you that permission." Members also see: "You can still approve individual test cases in the list." |
| G5 approved, no changes | No buttons | Approved line (P1 pattern): "Approved by {name} · {datetime} · '{comment}'" |

- **Advice never needs a confirmation** beyond the drafts dialog.
- The recommendation is labelled with its generator, and it is never phrased "approve regardless" (P2 BUG-P2-18).

**Request changes:**
- A comment is required: "Describe what needs to change." Focus moves to the comment.
- The stage becomes "Changes requested". The panel then offers [Regenerate with this feedback] (opens §12.1 with the comment as guidance) and [Edit test cases].

**After approval:**
- "Test cases approved. The approved Test Case Specification and Traceability Matrix were saved. Automation starts in Phase 4." [Open traceability] [Open reports]
- Focus moves to the approved line, and the toast reads "Gate 5 approved."

**Reopened** (any change listed in the roadmap rule):
- The pill returns to waiting. The panel shows "Changes since approval: {n}" with [Compare with approved set], a `DiffView` listing changed cases by key.
- The info line reads: "Phase 4 will use the last approved set until Gate 5 is approved again."
- Derived changes (priority from risk, lint recomputation) never count toward "Changes since approval".

### 13.2 States
| State | Copy |
|---|---|
| Not reached (design not run) | "Gate 5 opens when test cases are designed." |
| Running | "Gate 5 opens when test design finishes." |
| Load error | "Couldn't load the Gate 5 review. Try again." |
| Approve failed (409 from a race) | InlineError: "Gate 5 can't be approved: {server reason}. The checks above are updated." The panel refetches. |

---

## 14. Traceability (P3-04)

### 14.1 Layout
```
Traceability                               Basis [Current version | Last approved (Gate 5)]   [Open RTM report]
Computed from Requirements v5 · Test design run 2 · updated just now
Tabs: Coverage & gaps | Matrix
```
- **Basis** is a `Segmented` control. "Last approved" is disabled until G5 has been approved, with the visible hint "Available after Gate 5 is approved." When selected, the line reads "Showing the set approved at Gate 5 on {date}."
- Traceability is **read-only** for everyone. Its links go to the items, where they can be edited.

### 14.2 Coverage & gaps tab
**Coverage tiles** (`StatTile`). Every number comes from the API, and each tile links to a filtered matrix or list.

| Tile | Value | Sub-line |
|---|---|---|
| Requirements covered | "18 of 22" | "approved requirements have an approved test case · 20 have any case" |
| Acceptance criteria covered | "31 of 34" | "approved criteria have a test case" |
| High-risk requirements covered | "5 of 6" | "High or Very high risk, open" |
| Technique coverage | "19 of 21" | "conditions have a case for every value" |
| Test cases | "48" | "30 approved · 12 draft · 4 rejected · 2 deprecated" |
| Cases without a requirement | "1" | Warning icon if > 0 |
| Execution coverage | "Not available" | "Available after test execution (Phase 4)". `NOT_AVAILABLE` tone; never "0" or "0%". |

Percentages appear only as secondary text ("82%"), never as bars that could be read as pass rates.

**Gap lists** (spec §12): one `Disclosure` card each, with the count in the heading. Items are links with key and title. Each card has "Show all {n}" if there are more than 10.

| Gap list | Shown as |
|---|---|
| Requirements without test cases | Two sub-lists: "No test case at all ({n})" and "Test cases, but none approved ({m})" |
| Test cases without requirements | List of TC keys. Each has [Link a requirement] (opens the edit form) for members and above. |
| Untested high-risk functionality | Open High/Very high risks whose approved requirements lack an approved case: "RISK-003 (High) · REQ-0002 not covered". A separate sub-list "Accepted, not tested ({n})" shows the risk comment. |
| Acceptance criteria without test cases | AC keys with their requirement |
| Features without requirements | From Phase 2 |
| Requirements without execution evidence | `NOT_AVAILABLE` card: "Available after test execution (Phase 4)." No count. |
| Failed tests | same |
| Outdated automation scripts | same |
| Defects without regression coverage | same |

- **Empty lists say what that means:** "None. Every approved requirement has an approved test case." They never show a bare "0".
- **The unavailable cards** are grouped under the heading "Needs test execution (Phase 4)". They come last, so they never read as "all good".

### 14.3 Matrix tab
- **Direction** is a `Segmented` control: [Forward: requirement → test case | Backward: test case → requirement].
- **Filters:** status, risk level, feature, and "Only gaps".
- **Pagination:** 50 rows per page.

**Forward (desktop):**
```
<table> caption: "Forward traceability: requirements to test cases, 22 requirements"
| Requirement                   | Risk          | Acceptance criteria | Conditions          | Test cases                   | Scripts* | Results* | Defects* |
| REQ-0004 Contact form requires| High RISK-003 | AC-0010 ✓           | TCOND-0003 BVA      | TC-0005 ✓ Approved · High    | —        | —        | —        |
| Name ✓ Approved               |               | AC-0011 ✓           | TCOND-0002 EP       | TC-0006 ○ Draft · High       |          |          |          |
| REQ-0013 Products page lists… | Low           | AC-0020 ✓           | —                   | No test case ⚠               | —        | —        | —        |
* Not available until Phase 4 (header note, one per column group)
```
- **Row headers** are the requirement cells (`th scope="row"`). Each linked cell holds a `ul` of chips. Each chip has text status and the full sr name: "Test case TC-0005, approved, priority high".
- **The Phase 4 columns** sit under one column-group header, "Later phases", with the note "Not available until Phase 4". Cells show "—", with sr text "not available until Phase 4". They are never empty and never "0".
- **Gaps are text:** "No test case ⚠" or "No condition". They are never colour alone.
- Every key opens the **chain view** (§14.4) on activation. The key link names are "Trace TC-0005".

**Backward:** one row per case. Columns: Test case (row header) · Status · Priority · Technique · Conditions · Acceptance criteria · Requirements · Risks. Deprecated cases show "Deprecated", and a case with no requirement shows "No requirement ⚠".

**375 px:** the matrix becomes stacked cards (`TraceCard`). There is no table and no sideways scroll.
```
REQ-0004 · Contact form requires Name                  ✓ Approved
Risk: High (RISK-003)
Acceptance criteria   AC-0010 ✓ · AC-0011 ✓
Conditions            TCOND-0003 BVA · TCOND-0002 EP
Test cases            TC-0005 ✓ Approved · TC-0006 ○ Draft
Scripts, results, defects: not available until Phase 4
[Trace REQ-0004]
```
- Each card is an `article` with an `h3`, and the rows are a `dl`. Backward cards mirror this.
- From `md` to `lg`, the table scrolls inside a labelled, focusable container (`role="region"`, "Traceability matrix, scrolls sideways") with a sticky first column.

### 14.4 Chain view (`/traceability/[key]`)
```
Trace TC-0005 · Send the form with an empty Name                                         (h1)
Requirement  REQ-0004 Contact form requires Name  ✓ Approved
 └ Acceptance criterion  AC-0010 "Given … Then the form is not sent"
    └ Condition  TCOND-0003 Name length (BVA)
       └ Test case  TC-0005  ✓ Approved · High   ← you are here
          └ Script · Result · Defect: not available until Phase 4
Risk  RISK-003 High (score 12) → covers REQ-0004
Other test cases for REQ-0004: TC-0006, TC-0007
```
- The chain is a nested `ul` with level text ("Requirement", "Acceptance criterion" …). It doesn't rely on indentation alone.
- Starting from a requirement, it fans out to all ACs, conditions and cases, with "Show {n} more" per level.
- The view is linked from case detail (`⋯ View traceability`), requirement detail ("View traceability"), condition cards and risk rows.

### 14.5 States
| State | Copy |
|---|---|
| Not started | "Traceability is built when test cases are designed. Approve Gate 4 and design test cases first." [Go to Test Cases] |
| Out of date (design stale) | Warning Callout: "Traceability reflects test design run 2, which is out of date. Regenerate test cases to update it." [Go to Test Cases] |
| Filters match nothing | "No rows match these filters." [Clear filters] |
| Loading | Skeleton tiles + 8 rows |
| Error | "Couldn't load traceability. Try again." |
| Unknown key in chain view | App 404: "We couldn't find {key} in this project." |

---

## 15. Reports (P3-08)

### 15.1 Reports list additions
```
Report                       Latest      Status                         Based on                   Actions
Test Case Specification      Version 2   ○ Draft · Gate 5 waiting       Design run 2                [Open] [Download ▾]
Requirements Traceability    Version 2   ✓ Approved (Gate 5)            Design run 2 · Gate 5       [Open] [Download ▾]
  Matrix
```
- **[Download ▾]** offers **PDF**, **HTML (single file)** and **CSV (spreadsheet)**.
  - The CSV hint reads "Opens in Excel, Numbers or Google Sheets."
  - The trigger shows "Preparing CSV…" while working. The trigger's accessible name includes the report name and version (existing pattern).
- **Before design:** "Not available yet · Needs test cases", with the Generate button hidden.
- **[Generate draft]** appears for members and above when no draft reflects the current version. Viewers can only open and download.
- "Older versions ({n})" works as in P2.
- The "later reports" note now lists the Phase 4+ reports only.

### 15.2 Report pages
These reuse `ReportDocument` + `ReportToc`.
- **Header actions:** [Download PDF] [Download HTML] [Download CSV] [Print].
- **Bands:**
  - Draft: "DRAFT, not approved at Gate 5".
  - Approved: "Approved at Gate 5 by {name}, {date}".
- **Source changed:** "This report reflects design run 2. The current run is 3." [Create draft from current]

**Test Case Specification sections:**
1. Scope and method (techniques with the §7.4 definitions)
2. Summary counts
3. Test cases by feature → requirement, ordered by priority. Each case shows every §7 field, the steps table, "Why this case exists", links, checks, and "Execution status: Not run".
4. Open questions
5. Not designed (types and reasons)
6. Gate 5 record

Appendices: A Conditions · B Test data (with the notice "Synthetic data only. Saved logins are named, never shown.") · C Glossary.

**RTM sections:**
1. Basis (G3, G4 and G5 approvals)
2. Coverage
3. Gap lists (Phase 4 lists shown as "Not available until Phase 4")
4. Forward matrix
5. Backward matrix

The disclaimer reads: "No tests have been run. Execution, script and defect columns are filled from Phase 4."

**File names:** `{host}-test-case-spec-v{n}-{yyyy-mm-dd}.{pdf|html|csv}` and `{host}-rtm-v{n}-….`

**States** reuse P2 §10.3. Add:
- CSV failure: "Couldn't create the CSV file. Try again."
- Not available: "The Test Case Specification is available after test cases are designed."

---

## 16. AI QA Analyst v2 (P3-06)

### 16.1 Task list
| Group | Tasks (new **in bold**) |
|---|---|
| Works without AI | **Review test coverage** (replaces "Review coverage") · What needs my attention? · Summarise project status · **Explain a test case** · **Generate more negative test cases** · **Generate regression scenarios** · **Regenerate test cases** · Create a new test plan · Reassess application risk · Add negative criteria |
| Needs AI | **Update test cases** · **Suggest missing test cases** · Update requirements · Suggest missing requirements · Ask anything |
| Later phases | Explain a failed test (Phase 4: needs test runs) · Improve existing test scripts (Phase 4) · Analyse a defect (Phase 4) |

Remove the two Phase 3 entries from `LATER_TASKS_FALLBACK`.

| Task | Form | Output |
|---|---|---|
| Review test coverage | Scope: All / a feature / a requirement | Answer: coverage numbers, uncovered requirements, untested high risks, cases without requirements, all as citation chips. Ends with "Execution coverage is available from Phase 4." |
| Explain a test case | Test case (picker, searchable by key and title) | Answer: why it exists, technique, values with their constraints, links, risk and checks |
| Generate more negative test cases | Requirement or feature (one picker with two groups) | Proposal of new draft cases, or the no-more answer |
| Generate regression scenarios | Scope (radio): High-risk cases · Changed since Gate 5 approval (disabled with "Gate 5 hasn't been approved yet" until it has) · All features | Proposal of suite changes |
| Regenerate test cases | Guidance (optional) | Starts §12 and links to the review |
| Update test cases (AI) | Test cases (1–20) · What should change (required) | Proposal (diff) |
| Suggest missing test cases (AI) | Requirements (picker) · Focus (optional) | Proposal (new cases) |

- **Context chips:** "Ask AI QA Analyst about this" on a case or requirement prefills "About: TC-0019" and the relevant task forms.
- **The answer footer** gains test design: "Based on: Requirements v5 · Strategy v2 · Test design run 2".
- **Citation chips** add `TC-`, `TCOND-` and `TD-`, with full names: "Test case TC-0019: Send the contact form with an empty Message". IDs that don't exist render as "TC-0999 (not found)" in plain text.
- **No more negative cases:** "No further negative test cases can be derived from the discovered constraints." No proposal is created.
- **"Which tests failed?"** gets: "There are no test runs in this project yet, so there are no results to report. Test execution arrives in Phase 4."

### 16.2 Proposal cards for test design (extend `ProposalCard`)
```
+-- Proposal · More negative test cases for REQ-0007 ------------------ [○ Waiting for your review] -+
| 3 new test cases · Computed from project data · based on Test design run 2                          |
| + TC (new) Send the form with an email that has no domain    [EP] High · RISK-001   (●) Accept ( ) Reject |
|   Constraint: type=email (EV-0043) · Expected label: Inferred                                       |
|   Steps · Show                                                                                       |
|     1 Enter TD (new) "ada.lovelace@" in Email  → Email shows it                                      |
|     2 Press Send message                       → Submission is blocked and Email shows a format error|
| + TC (new) Name with only spaces              [EG] Medium · Expected label: Assumed  (●) Accept ( ) Reject |
|   "Assumed: the site's handling of spaces-only input wasn't observed."                              |
| Accepted cases are added as drafts. Review and approve them in Test Cases.                           |
| Gate 5 will need approval again.                                     (only if G5 approved)          |
|                                                   [Reject all]   [Add 3 test cases]                  |
+------------------------------------------------------------------------------------------------------+
```
- Proposed cases show steps, data (new TD items are marked "new" and show the synthetic value), expected result, label, technique, priority and constraint. This is the same information a case card shows.
- **Regression proposals** show a suite diff in two lists, each item with its reason:
  - "Add to Regression ({n})", e.g. "TC-0031 · High risk (RISK-001)".
  - "Remove from Regression ({m})", e.g. "TC-0040 · Low risk, not the feature's positive case".
  - The button reads [Apply {n} suite changes].
- **Update proposals** use `DiffView` per case.
  - Approved targets show "Approved: this change moves it back to Draft."
  - Locked targets have Accept disabled, with the visible text "TC-0005 is locked. Unlock it to apply this change."
- **Statuses** are those of P2 §11.4. "Out of date" reads "TC-0012 changed after this proposal was made. Ask again to get a proposal for the current version."
- **Toast after applying:** "3 test cases added as drafts. View in Test Cases."
- **Viewers** see the proposals but not the Apply and Reject buttons. A neutral line reads "Only members, owners and admins can apply proposals." (The roadmap says read intents work for viewers and accept gives 403.)

---

## 17. Members and roles (P3-07)

### 17.1 `/settings/members`
```
Settings                                                                                 (h1)
Tabs: Profile & organisation | Members
Members (5)                                                                    [Invite people]
| Name            | Email                   | Role            | Approves gates | Joined      |            |
| Daniele Edema   | d@acme.example          | Owner           | Yes (always)   | 1 Oct 2026  | [Edit] (you)|
| Ana Lee         | ana@acme.example        | Admin           | Yes            | 3 Oct 2026  | [Edit] [Remove] |
| Sam Patel       | sam@acme.example        | Member          | No             | 13 Nov 2026 | [Edit] [Remove] |
| Kim Ito         | kim@acme.example        | Viewer          | No             | 13 Nov 2026 | [Edit] [Remove] |
What each role can do ⓘ
Pending invitations (2)
| Email                     | Role    | Approves gates | Invited by | Expires              | Status   |          |
| new.member@example.com    | Member  | No             | D. Edema   | 20 Nov 2026, 10:02   | Pending  | [Revoke] |
| old.invite@example.com    | Viewer  | No             | A. Lee     | 9 Nov 2026           | Expired  | —        |
```
- **Visibility:**
  - Owners and admins see emails and every control.
  - **Members and viewers** see a read-only list: name, role, approves gates, joined. There is no email column, no Pending invitations section, and no buttons. A neutral line reads "Only owners and admins can manage members."
- **Your own row** carries "(you)" in the name cell.
- **Role help** ("What each role can do", a popover; also used in the invite and edit dialogs):

  | Role | Description |
  |---|---|
  | Owner | "Full control, including members and other owners. Always approves gates." |
  | Admin | "Manages members (except owners), project settings and test credentials. Approves gates unless turned off." |
  | Member | "Runs agents, edits and approves requirements and test cases. Approves gates only if allowed." |
  | Viewer | "Reads everything. Can't change anything or approve." |

**Edit member dialog:**
```
Edit Sam Patel
Role  ( ) Admin  (●) Member  ( ) Viewer          [Owner only offered to owners]
[x] Can approve quality gates
    Lets this person approve or request changes at Gates 2–5. Owners always can.
                                                     [Cancel]  [Save changes]
```
- Owner role: forced on and disabled, with the text "Owners always approve gates."
- Viewer: unchecked and disabled, with "Viewers can't approve."
- The dialog confirms through its own Save, with no second dialog. The exception is the guards below.
- Toast: "Sam Patel is now a Member who can approve gates."

**Guards.** These are shown before acting, as text, not only as server errors.

| Situation | UI |
|---|---|
| Last owner (Remove or demote) | Remove is disabled. In Edit, the role radios are disabled. The visible reason reads "A workspace needs at least one owner. Make someone else an owner first." The server's 409 uses the same copy. |
| Owner changes their own role (another owner exists) | ConfirmDialog (warning). Title "Change your own role to Admin?" Body "You'll lose owner rights straight away. Only another owner can give them back." [Cancel] [Change my role] |
| Owner turns off nothing / admin edits self | Admins see their own role radios disabled: "You can't change your own role. Ask an owner." |
| Admin on an owner's row | [Edit] and [Remove] are disabled: "Only owners can change or remove an owner." |
| Admin choosing Owner | Not offered. Admins see three role options. |
| Removing someone | ConfirmDialog (danger). Title "Remove Sam Patel?" Body "They'll be signed out of this workspace straight away. Requirements, test cases and approvals they made keep their name." [Cancel] [Remove member] |
| Removing yourself (not the last owner) | ConfirmDialog (danger). Title "Leave this workspace?" Body "You'll be signed out and won't be able to come back without a new invitation." [Cancel] [Leave workspace] |

**Remove** shows the toast "Sam Patel was removed." and focus moves to the next row's name, or to the table heading.

### 17.2 Invite people
**Step 1, a form dialog:**
```
Invite people
Email *           [ new.member@example.com          ]
Role *            ( ) Admin  (●) Member  ( ) Viewer
                  [ ] Can approve quality gates   (default on for Admin, off for Member, hidden for Viewer)
We don't send emails yet. You'll get a link to share yourself.
                                                       [Cancel]  [Create invitation link]
```
- Email validation: "Enter an email address, like name@example.com."
- **The email already has an account (409, D5):** a field error reads "This email already has an account. Multi-workspace accounts aren't supported yet, so this person can't join a second workspace. Ask them to use a different email address."
- **Pending invitation for the same email:** "There's already a pending invitation for this email. Revoke it to create a new link."
- **Rate limit:** "You've created 20 invitations in the last hour. Try again later."

**Step 2, the same dialog showing the link once:**
```
Invitation link for new.member@example.com
[ https://app.example/invite/Xk3…9fQ                    ] [Copy invitation link]
Joins as Member · can't approve gates · expires 20 Nov 2026 at 10:02 (in 7 days)
This link is shown only once. Send it to new.member@example.com yourself, for example in a chat message.
Anyone with the link can join as a Member, so share it only with this person.
                                                                   [Done]
```
- The link sits in a read-only text field, selected on focus.
- **[Copy invitation link]** uses the clipboard. On success, the button text changes to "Link copied" for 3 s, and a polite live region announces "Link copied".
- If the clipboard fails: "Couldn't copy. Select the link and copy it yourself." The field gets focus and its text is selected.
- **[Done] or closing without copying:** ConfirmDialog. Title "Close without copying the link?" Body "You won't be able to see it again. To share it later, revoke this invitation and create a new one." [Go back] [Close].
- **Revoke:** ConfirmDialog. Title "Revoke the invitation for new.member@example.com?" Body "The link stops working straight away." [Cancel] [Revoke invitation]. Toast "Invitation revoked."

### 17.3 Accept invitation (`/invite/[token]`, public, `(auth)` layout)
```
Join Acme QA on QA Analyst                                              (h1)
Daniele Edema invited you as a Member.
Members run agents, edit and approve requirements and test cases.
Full name *   [                          ]
Password *    [                          ] [Show]   At least {MIN_PASSWORD} characters.
                                                     [Create account and join]
By joining you'll be signed in to Acme QA.
```
- **Same password rules and `PasswordField`** as registration (`MIN_PASSWORD`, `autocomplete="new-password"`). Paste is allowed.
- **On success:** sign in and go to `/dashboard`. Toast: "Welcome to Acme QA."
- **States:**

  | State | Copy |
  |---|---|
  | Loading | Skeleton card |
  | Invalid, used, expired or revoked (404) | `EmptyState`: "This invitation is no longer valid. Ask the person who invited you for a new link." [Go to sign in] |
  | Already signed in | Callout: "You're signed in as {email}. This invitation creates a new account. Sign out to accept it." [Sign out and continue] |
  | Field errors | P1 auth error pattern, with focus on the first error |
  | Accept rate limit | "Too many attempts. Try again in {n} minutes." |
  | Server error | "Couldn't create your account. Try again." |

- The token is never shown on the page, in the title or in analytics. Use `<meta name="referrer" content="no-referrer">` on this route.

### 17.4 Role-aware copy elsewhere
- **Waiting copy:** see §4.3.
- **The app reads `can_approve` from the server (`/me`).** `lib/auth.tsx` currently derives it from role at login (line 49). With D2 and toggleable `can_approve`, it must use the API value, or a member with `can_approve` would see disabled gates.
- **Role changes take effect on the next request.** If a 403 appears after a role change, the error reads: "Your permissions changed. Refresh to see what you can do now." [Refresh]

---

## 18. Component inventory

**Reuse (extend where noted)**

| Component | Path | Phase 3 use |
|---|---|---|
| Tabs, Segmented | `ui/Tabs.tsx` | Workspace tabs; Group by; matrix direction; basis |
| Table family | `ui/Table.tsx` | Cases, conditions coverage, data, matrix, members. Add `rowgroup` header support |
| FilterBar, FilterChips | `ui/FilterBar.tsx` | Cases, data, matrix |
| BulkActionBar | `ui/BulkActionBar.tsx` | Case bulk actions |
| ChecklistEditor | `ui/ChecklistEditor.tsx` | Preconditions |
| Modal, ConfirmDialog, Drawer, Callout, Disclosure, StatTile, StatusPill/Badge, Tooltip, Toast, States, Field, PasswordField | `ui/*` | Throughout; new tones (§3) |
| ProvenanceLabel, ProvenanceLegend, GeneratedByLabel | `domain/ObservationLabel.tsx` | Expected-result labels; "Generated by rules" |
| EvidenceDrawer, EvidenceLinks | `domain/EvidenceDrawer.tsx` | Constraint and case evidence |
| GateReviewPanel, GateBanner | `domain/GateReviewPanel.tsx` | G5. Add grouped checks (`group: "blocker" \| "advice" \| "passed"`), `blockedReason`, and role-aware pill copy |
| ChangeReviewScreen, ChangeReview, DiffView | `domain/ChangeReviewScreen.tsx`, `ChangeReview.tsx`, `DiffView.tsx` | Regeneration review; proposal diffs; G5 "Compare with approved set" |
| RevisionHistory, VersionSelect, OutOfDateCallout | `domain/*` | Cases, conditions, data; design runs; stale |
| RejectDialog | `requirements/RejectDialog.tsx` | Parameterise reasons and copy for cases and conditions |
| LifecycleProgress, `lib/lifecycle.ts`, `lib/sections.ts`, `lib/attention.ts`, ProjectHeader | — | G5, built sections, role-aware waiting copy |
| ReportDocument, ReportToc, reports list DownloadMenu | `report/*`, `reports/page.tsx` | Two reports, a CSV menu item |
| Assistant, AnswerCard, ProposalCard | `assistant/*` | v2 tasks, case proposals, suite diff |
| Risks | `strategy/Risks.tsx` | Test coverage column |
| RequirementDetail | `requirements/RequirementDetail.tsx` | Linked test cases block |

Do **not** reuse the legacy `domain/StepsEditor.tsx` or `domain/TestCaseDocument.tsx`. P3-00 deletes them, because they target the old contract.

**New**

| Component | Suggested path | Why nothing existing fits |
|---|---|---|
| TestCasesTable, TestCaseCard | `testcases/TestCasesTable.tsx` | Selectable, groupable table plus mobile cards |
| TestCaseDetail, TestCaseForm | `testcases/TestCaseDetail.tsx` | §7 specification layout plus in-place edit |
| StepEditor | `testcases/StepEditor.tsx` | Per-step action, data and expected, with keyboard reorder |
| ConditionCard, CoverageItemsTable | `testcases/Conditions.tsx` | Technique-specific value tables with constraint source |
| TechniqueChip, TechniqueLegend | `testcases/Technique.tsx` | Short and full names plus definitions |
| LintPanel, LintChip | `testcases/Lint.tsx` | Must fix / Advice with fix hints and jump links |
| PriorityValue, PrioritySource, PriorityDialog | `testcases/Priority.tsx` | Derived vs override explanation |
| DeprecateDialog | `testcases/DeprecateDialog.tsx` | Reason plus the no-delete explanation |
| TestDataTable, TestDataForm, ValueText | `testcases/TestData.tsx` | Grouped data, visible whitespace, guard errors |
| CoverageTiles, GapLists, TraceMatrix, TraceCard, ChainView | `traceability/*` | Matrix with nested lists, cards at 375 px, chain |
| MembersTable, MemberDialog, InviteDialog, InvitationsTable | `settings/Members.tsx` | Roles, guards, one-time link |
| AcceptInvitation | `app/(auth)/invite/[token]/page.tsx` | Public join flow |

---

## 19. Accessibility (WCAG 2.2 AA; additions to P1 §11 and P2 §14)
- **Names:**
  - Row checkbox: "Select TC-0019 Send the contact form with an empty Message". Header checkbox: "Select all test cases on this page".
  - Link names are unique: "Review Gate 5", "Show 2 cases missing an expected result", "Trace TC-0005". There are no duplicate "Review gate" or "Show" links on any page.
- **Status in text:**
  - Priority, lint severity, case status, open question, kind and "Not run yet" are all text plus an icon.
  - The matrix gap cells say "No test case".
  - The Phase 4 cells have sr text "not available until Phase 4".
- **Tables:** real tables with captions and `th scope`. Grouped tables use `scope="rowgroup"`. Sortable headers are buttons with `aria-sort`. Scrolling containers are focusable regions with names.
- **Focus order on case detail:** `h1` (focused on load) → header actions → open-question callout actions → main column → side column → revisions. Edit focuses Title; Save and Cancel return to [Edit]. [Write expected result] focuses the first undecided expected-result field.
- **Returning from detail** to the list restores focus to the row's link and keeps the scroll position (P3-02 AC).
- **Step editor:** each step is a `fieldset`/`legend`. Moves and removals are announced. There is no drag, and every action is a button of at least 24×24 px (44 px on coarse pointers).
- **Disabled actions with reasons:** disabled Approve and gate buttons keep `aria-describedby` pointing to the visible reason. Use `aria-disabled="true"` (not `disabled`) so they stay focusable and the reason is reachable.
- **Live regions:** one polite page status region announces selection counts, "Step moved", "Link copied", "Gate 5 approved" and "Priority updated". It never streams.
- **Values:** visible-whitespace markers have sr equivalents ("three spaces", "empty, 0 characters"). Long values are buttons ("Show full value, 81 characters").
- **Secrets:** saved logins are text ("Uses the saved test account (value never shown)"), never asterisks.
- **Dialogs** follow the P1 Modal focus contract. The invite link field is a labelled read-only input ("Invitation link").
- **Reduced motion:** no animated spinners, highlight flashes or copy-button transitions.
- **Zoom and text size:** layouts hold at 320 px, 200% and 400% zoom. Chips wrap and never truncate keys.
- **Contrast:** there are no new colour pairs. Reused pairs are AA per P2 §2/§14, and the `danger-solid` Critical chip is 4.6:1.

## 20. Responsive summary
| Width | Test cases | Detail | Test data | Traceability | Members |
|---|---|---|---|---|---|
| ≥ 1024 | Table, all columns | 2/3 + 1/3 | Table | Table | Table |
| 768–1023 | Table in a scroll region with a sticky first column | Single column, side panel below | Table | Table in a scroll region | Table |
| < 768 | Cards; filter sheet; bulk primary + `⋯` | Steps as cards | Cards | Stacked cards | Cards; dialogs full-screen |

**No page has horizontal page scroll at 375 px or 320 px.** That covers the list, detail, edit, conditions, data, review, G5, traceability (both tabs), chain, reports, assistant, members and the invite page.

---

## 21. Copy (new strings)
The strings given inline above, in states tables, dialogs and callouts, are the authoritative versions. This list collects the reusable ones.

**Buttons:** Design test cases · Regenerate… · Regenerate test cases… · Review changes · Apply {n} changes · Discard regeneration · New test case · New test case for {REQ} · Duplicate · Approve · Approve {n} · Reject… · Reject test case · Reject condition and {n} drafts · Deprecate… · Deprecate test case · Move back to draft · Restore to draft · Edit · Save changes · Unlock to edit · Write expected result · Add step · Move step {n} up · Move step {n} down · Remove step {n} · Add test data · New test data item… · Save and reopen review · Retire · Set priority… · Set priority · Use risk-based priority · Show the case with an open question · Show open questions · Approve test cases · Request changes · Regenerate with this feedback · Edit test cases · Review drafts · Compare with approved set · Open traceability · Open RTM report · Trace {key} · Show full value · Download CSV · Generate draft · Add {n} test cases · Apply {n} suite changes · Invite people · Create invitation link · Copy invitation link · Done · Go back · Revoke · Revoke invitation · Edit · Remove · Remove member · Change my role · Leave workspace · Create account and join · Sign out and continue · Go to sign in

**Labels:**
- Statuses: Draft · Approved · Rejected · Deprecated · Open question · Not run yet · Pending · Expired · Revoked · Not available
- Severity: Must fix · Advice · No issues · "Must fix before approval" · "Passed"
- Priority: Critical · High · Medium · Low · "from {RISK} ({level}, score {n})" · "set by {name}" · "no linked risk" · "Risk-based priority: {level} ({RISK})"
- Test data kinds: Valid · Invalid · Boundary · Saved test account · Synthetic
- Side effects: Submits a form · Signs in · Creates data · External transaction · "Labels only. Nothing runs in Phase 3."
- Automation (preliminary): Suitable · Partly automatable · Manual only · "Preliminary: assessed in Phase 4."
- Last result: "Not run yet" · tooltip "Execution arrives in Phase 4."
- Open question expected result: "Not decided: {REQ} asks {question}"
- Synthetic notice: "Synthetic data only. Values are generated for testing and aren't real people's details. Saved logins are referenced, never shown."
- Saved login: "Uses the saved test account (value never shown)"
- Phase 4 placeholders: "Not available until Phase 4" · "Available after test execution (Phase 4)"
- Roles: Owner · Admin · Member · Viewer (descriptions in §17.1) · "Can approve quality gates"

**Toasts:**
- "{n} test cases approved. {m} skipped."
- "TC-{n} saved as version {v}." · "TC-{n} created as a draft." · "TC-{n} created from TC-{m}."
- "Expected result saved. TC-{n} can now be approved."
- "Test cases changed since Gate 5 approval. Approve Gate 5 again so the changes become the approved set."
- "Design run {n} applied: {m} changes."
- "Gate 5 approved." · "Changes requested."
- "Priority set back to {level} (from {RISK})." · "Priority updated on {n} test cases."
- "TD-{n} saved as version {v}." · "{n} approved cases moved back to Draft."
- "{n} test cases added as drafts. View in Test Cases."
- "Invitation revoked." · "Link copied" · "{name} was removed." · "Welcome to {organisation}."

---

## 22. Design checks (Given / When / Then; QA verifies each)

**Navigation and lifecycle**
1. Given Phase 3 is deployed, then the sidebar shows Test Cases and Traceability with no phase badge. `/test-cases/x` (legacy) shows the app 404.
2. Given G5 is waiting, when a user with `can_approve` views the header and lifecycle, then they read "Waiting for your approval". When a member without `can_approve` or a viewer views them, then they read "Waiting for approval by someone who can approve gates".
3. Given test design ran and G5 is waiting, then the lifecycle shows steps 13 and 14 and a G5 diamond "Test case quality". Step 14 never shows "Running".
4. Given G2–G5 links appear on one page, then each has a unique accessible name ("Review Gate 2" … "Review Gate 5"), and Playwright strict mode finds each with one locator.
5. Given G4 is approved, when test design starts automatically, then the step 13 row and the feed say "Started automatically after Gate 4 approval."

**Workspace states and AI-off**
6. Given G4 is not approved, then Test Cases shows "Test cases are designed from the approved Test Strategy. Approve Gate 4 first." with [Review Gate 4].
7. Given AI is off, then the header shows "Generated by rules" and the rules Callout, and every generated case shows no "AI-generated" label.
8. Given a design that lists security and performance under not-designed, then the Callout names them with "They need separate approval and are designed in Phase 5."
9. Given G4 is re-approved with a new snapshot, then Test Cases and Traceability show "Out of date" in the sidebar, the lifecycle and the page Callout, and the cases stay editable.

**List**
10. Given generated cases, then every row shows key, title, technique, type, level, priority with its source, expected-result label, status, checks chip, requirement keys and "Not run yet". No row shows a pass, fail or result colour.
11. Given filters Technique = Boundary value analysis and Open question, then the URL holds both, chips show both, and browser Back restores the previous set.
12. Given Group by = Requirement, then each group header names the requirement and counts its cases, and unlinked cases appear under "Not linked to a requirement".
13. Given 12 selected cases with 2 Must-fix cases and 1 open question, when "Approve 12" is pressed, then the dialog offers "Approve 9" and lists the 3 skipped with reasons. After approval the toast offers Undo and Show skipped.
14. Given a viewer, then no checkboxes, bulk bar, New test case, Regenerate, Edit, Approve or Set priority controls render.
15. Given 375 px and 320 px, then the list renders as cards, filters open in a full-screen sheet, and `document.scrollingElement.scrollWidth` equals the viewport width.

**Conditions and values**
16. Given the demo shop design, then TCOND for Name BVA shows values "(empty) 0 characters" and "1 character" with "Constraint: required (Name)" and an evidence link. It also shows "No maximum length was discovered for Name; no upper boundary case is designed."
17. Given the fixture site with `maxlength=80` at medium risk, then the Name BVA table shows exactly 80 and 81 characters, each with "Constraint: maxlength=80". At high risk it shows 79, 80 and 81.
18. Given any BVA or EP condition, then every coverage item row shows a constraint line. None is missing.
19. Given a value of three spaces, then it renders as "␣␣␣ (3 spaces)", and a screen reader reads "three spaces".
20. Given a member rejects a condition with 2 drafts, then the dialog names both cases and the button reads "Reject condition and 2 drafts".

**Case detail and edit**
21. Given any case detail, then all spec §7 fields are visible with labels (ID, requirement, title, objective, preconditions, test data, steps with per-step expected results, overall expected result, type, level, priority, automation suitability, execution status, evidence). Empty ones read "None".
22. Given any case, then "Last result: Not run yet" and "Execution arrives in Phase 4." are shown, "Execution status: Not run" is read-only, and there is no Run button.
23. Given the automation suitability row, then it reads Suitable / Partly automatable / Manual only with a reason and "Preliminary: assessed in Phase 4."
24. Given a case with a Must-fix item, then [Approve] is focusable but disabled, with the visible reason naming the checks, and no dialog opens on press.
25. Given an approved case and G5 approved, when a step is edited and saved, then the form had warned "Saving moves it back to Draft. Gate 5 will need approval again.", the case is Draft, G5 shows waiting, and the one-time toast appears once.
26. Given the step editor, when only the keyboard is used to add, move up, move down and remove steps, then each works, focus stays on the moved control, and the status region announces the move.
27. Given a save with an empty expected result on step 2, then "Describe the expected result for step 2." appears, focus moves to that field, and an error summary links to it.
28. Given another user saved the case meanwhile, when saving, then the conflict Callout appears, the typed text is preserved, and Compare shows a diff.
29. Given the edit form, then label, risk, derived priority, execution status and lint are read-only, with the help text.
30. Given a new manual case with no requirement, then it saves as Draft, labelled Assumed and "Written by a person", with Must fix "Not linked to a requirement".
31. Given an approved case, when deprecated with a reason, then it shows "Deprecated" with the reason, stays in traceability as Deprecated, and no Delete control exists anywhere in the UI.

**Open questions (D6)**
32. Given the demo shop, then the empty-Message case shows the open-question Callout, the expected result reads "Not decided: REQ-00nn asks whether Message is optional" linking to that requirement, and Approve is disabled with "open question".
33. Given the user presses [Write expected result], then focus lands in the undecided expected-result field, which is empty. On save the open question clears, the label is Assumed with "Written by a person", and Approve becomes enabled.
34. Given that requirement's detail page, then it shows "1 test case is waiting for this answer: TC-00nn."

**Priority from risk**
35. Given RISK-004 (High) linked to the sign-in requirement, then sign-in cases show "High · from RISK-004 (High, score n)" with a link to the risk.
36. Given the user sets TC-0010 from High to Low without a reason, then "Explain why you changed the priority." appears. With a reason, the case shows "Low · set by {name}: '{reason}'", "Risk-based priority: High (RISK-004)", and Advice "Priority lower than its risk".
37. Given a risk is re-rated, then case priorities update, the case revision history gains no entry, and G5 does not reopen.

**Test data (D3)**
38. Given the Test data tab, then items are grouped by form → field, each shows kind as text, value, length, "Used by n cases", and the synthetic notice is visible.
39. Given a password field item, then it reads "Uses the saved test account (value never shown)", and no username, password, mask or asterisks appear anywhere in the DOM.
40. Given the user enters `real.person@gmail.com`, then "Use a reserved domain such as example.com; real-looking data isn't allowed." appears and focus moves to the field.
41. Given TD-0007 tests the 81-character boundary, when edited to 79 characters, then "This item tests the 81-character boundary; change the case instead." appears.
42. Given TD-0004 is used by an approved case, then the edit form warns which cases move back to Draft, and the button reads "Save and reopen review".
43. Given an item used by a draft case, when Retire is chosen, then the dialog lists the cases with [Show these cases] and nothing is retired.

**Regeneration**
44. Given TC-0003 edited, TC-0005 locked, TC-0007 rejected and TC-0009 approved with its constraint removed, when regeneration finishes, then the review lists TC-0003 and TC-0005 as protected (Keep current), omits TC-0007, and shows TC-0009 under No longer found defaulting to Keep with "consider deprecating".
45. Given a pending review, when Regenerate is pressed, then "A regeneration is waiting for review…" appears with [Review changes].

**Gate 5 (D1)**
46. Given an open question and an uncovered open High risk, then the G5 panel lists both under "Must fix before approval", each with its own uniquely named link, and [Approve test cases] is disabled with "Fix the 2 items under 'Must fix before approval' to approve."
47. Given lint items exist, then "Quality checks by type" groups them under Must fix and Advice with counts and links that filter the list to exactly those cases.
48. Given a member without `can_approve`, then both G5 buttons are disabled with the permission Callout and "You can still approve individual test cases in the list." No dialog opens, and approving an individual case succeeds.
49. Given no blockers and 12 drafts, when an approver approves, then "Approve with 12 drafts?" appears. After approval the approved line, the toast "Gate 5 approved." and the next-step copy show, and focus moves to the approved line.
50. Given G5 approved, when any case is edited, then the panel shows "Changes since approval: 1" with [Compare with approved set], and "Phase 4 will use the last approved set…".
51. Given the risk is accepted with a comment, then the risk blocker clears and the risk appears under "Accepted risks".

**Traceability**
52. Given the Coverage tab, then tile numbers equal `/traceability/coverage`, and "Execution coverage" reads "Not available" with "Available after test execution (Phase 4)", never 0 or 0%.
53. Given gap lists, then "Requirements without test cases" is split into "No test case at all" and "none approved". The four execution-dependent lists sit under "Needs test execution (Phase 4)" with no count.
54. Given an empty gap list, then it states its meaning ("None. Every approved requirement has an approved test case.") rather than "0".
55. Given the forward matrix, then it is a table with a caption and row headers. The Phase 4 columns show "—" with sr "not available until Phase 4". Gaps read "No test case".
56. Given 375 px, then the matrix renders as stacked cards with no horizontal page scroll, and each card ends with "Scripts, results, defects: not available until Phase 4".
57. Given Basis = Last approved before any G5 approval, then the option is disabled with "Available after Gate 5 is approved."
58. Given the chain view for TC-0004, then it lists its condition, ACs, requirements and risks with level names in text, and each links back.

**Reports (D4)**
59. Given test cases are designed, then the Reports list shows Test Case Specification and Requirements Traceability Matrix, and Download offers PDF, HTML and CSV only.
60. Given G5 is waiting, then the reports carry "DRAFT, not approved at Gate 5". After approval, the approved versions show the approver and date.
61. Given saved credentials, then no report page or download contains the username or password, and test data appendices say "Saved logins are named, never shown."

**Assistant v2**
62. Given AI is off, then "Review test coverage", "Explain a test case", "Generate more negative test cases" and "Generate regression scenarios" run under "Works without AI". "Update test cases" and "Suggest missing test cases" are under Needs AI. Neither Phase 3 task appears under Later phases.
63. Given "Generate more negative test cases for REQ-0002", then the proposal shows each case's steps, data, expected result, label and constraint. Nothing changes until [Add {n} test cases], after which the cases are drafts.
64. Given all derivable negatives exist, then the answer reads "No further negative test cases can be derived from the discovered constraints." and no proposal card appears.
65. Given a regression proposal, then it shows "Add to Regression" and "Remove from Regression" lists, each item with its reason.
66. Given a viewer, then proposals render without Apply or Reject, and show "Only members, owners and admins can apply proposals."

**Members and invitations (D5)**
67. Given an owner, when they invite `new.member@example.com` as Member, then the link appears once with the expiry and "This link is shown only once…". [Copy invitation link] announces "Link copied", and closing without copying asks for confirmation.
68. Given an email that already has an account, then the field error explains multi-workspace accounts aren't supported and suggests another email.
69. Given the only owner, then Remove and role change on their row are disabled with "A workspace needs at least one owner. Make someone else an owner first."
70. Given an owner changes their own role while another owner exists, then the warning dialog "Change your own role to Admin?" appears before saving.
71. Given an admin, then owner rows have Edit and Remove disabled with "Only owners can change or remove an owner", and Owner isn't offered in role choices.
72. Given a member or viewer, then `/settings/members` is read-only, with no emails, no invitations section and no buttons.
73. Given an invitation link opened when signed out, then the page shows organisation, inviter and role, and accepting with a valid name and password signs in to that workspace. Given the link is reused, expired or revoked, then "This invitation is no longer valid…" shows with no form.
74. Given a member granted `can_approve`, when they reload, then the G3, G4 and G5 buttons are enabled (the client uses the server's `can_approve`), and the header reads "Waiting for your approval". Given an admin with `can_approve` turned off, then those buttons are disabled with the reason, and no dialog opens.

**Accessibility and responsive**
75. Given an axe-core scan of every Phase 3 screen in each state listed (list, detail, edit, conditions, data, review, G5, traceability both tabs, chain, reports, assistant with a test-case proposal, members, invite), then there are zero serious or critical violations.
76. Given keyboard only, then every action in this spec is reachable and operable, focus is always visible and never hidden by the sticky bulk bar, and closing a case detail returns focus to its row.
77. Given 200% and 400% zoom and 320 px width, then no content is clipped and no page scrolls sideways.

---

## 23. Open questions (only those that change behaviour)
1. **Do open questions on draft cases block G5?**
   - D1 lists "an unresolved open question" as a hard blocker. The roadmap P3-02 lists open-question cases as a warning, because drafts are left out of the snapshot.
   - **Recommend blocking** (as designed, §2 blocker 5). Otherwise G5 can be approved while the demo's deliberate bug has no decided case.
   - The PM should align P3-02's precondition list.
2. **Show the invited email on the accept page?**
   - The public `GET /invitations/{token}` returns organisation, inviter and role only. The invitee then doesn't see which email they'll sign in with.
   - **Recommend returning a masked email** (`ne***@example.com`) and showing "You'll sign in as ne***@example.com."
3. **JSON in the download menu?**
   - The roadmap lists JSON per version, while D4 names PDF, HTML and CSV.
   - **Recommend** keeping JSON API-only and out of the menu, to keep the menu simple for non-QA users.
4. **Technique for non-functional cases** (accessibility labels, overflow, console errors) has no ISTQB technique in the rules.
   - **Recommend** that the API returns `technique: "checklist"`, shown as "Checklist: a fixed list of quality checks", rather than "Other".
   - This needs a backend value and a §7.4 row.
5. **Undo after bulk approve** reverts cases to Draft. After G5 approval, that is itself a change that reopens G5.
   - **Recommend** keeping Undo, and showing "Gate 5 will need approval again" in the toast when it applies.
