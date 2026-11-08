# UX review: first-time experience for non-QA users

_Date: 2026-11-06 · Reviewer: PM agent · Scope: web/ (Next.js) and api/ as of commit 6c3ad21_

## TL;DR

The engine is good and fast. On DemoShop via the API: discovery took about 3 s, 8 rule-based cases were generated, and an automated run finished in 15 s and **caught the real empty-message bug**. The problem is the wrapper. The app is laid out like a QA test-management tool (projects, environments, a draft/approve/ready lifecycle, categories, execution types and 9 project tabs), so a founder has to learn QA vocabulary and make about 20 clicks over 6 tabs and 5 modals before seeing a single result.

**Target user:** a founder, developer or PM who wants to know "is my site broken, and what should I fix?" They are not trying to manage a test library.

**North-star for onboarding:** % of new workspaces that see their first run result within 5 minutes of signing up.
Input metrics:
- time from signup to first run
- % of projects with an authorised environment
- % of generated cases that get run
- % of failed results that someone opens

(Instrument this with an `activation_step` event at each milestone.)

## Recommended first 5 minutes

```
Sign up (email + password only)
  -> "What site do you want to test?" [ https://... ]  [x] I own this site or have permission to test it
  -> [Scan my site]  (discovery runs, live list of pages found, ~5-30 s)
  -> "We found 6 pages and 2 forms. Here are 8 checks we suggest:" (plain-English list, all ticked)
  -> [Run 8 checks]  (one click: approve + run automated on the only environment)
  -> Live progress: "Checking Contact form... 5 of 8 done"
  -> Results: "7 checks passed. 1 problem found:
       Your Contact form accepts an empty message. [See what happened] [Mark as a bug] [This is fine, ignore]"
```

Everything else stays reachable but out of the way: environments, credentials, categories, manual runs, the API tab, Playwright export, reports and compare.

## Journey trace (as built)

| # | Step | Clicks/fields | Friction |
|---|---|---|---|
| 1 | Register | 4 fields | Asks for "Organisation"; the heading says "workspace" and the copy says "administrator" |
| 2 | Dashboard | - | All zeros, an empty chart and 5 equal-weight quick actions. "Run a test" and "Generate test cases" are enabled even with no project. Help is only in the top bar. |
| 3 | New project modal | 5 fields | "Application type: Web/API" and "Environment: DEVELOPMENT/STAGING/PRODUCTION" are jargon. Hint: "You'll confirm authorisation before any test runs" |
| 4 | Lands on Overview | - | 4 zero KPIs and an empty donut. Empty state says "Approve some test cases, then start a run" with no route to that step. 9 tabs. |
| 5 | Environments tab -> pencil icon -> large modal | ~12 controls | Environment is created **unauthorised**. Workers, slow motion, JSON config, wsEndpoint and "destructive actions" all sit around one checkbox the user actually needs |
| 6 | Discovery tab -> Start | 3 controls | "Max pages" and "Use stored credentials". Results are a crawl dump (depth, HTTP status, links). An amber "Limitations" panel comes **first** |
| 7 | "Generate test cases from this map ->" | - | Goes to the Test Cases tab but doesn't open the generator |
| 8 | Generate modal | source + text + 10 category checkboxes + count | Source **defaults to "Feature description"** even when a discovery exists. Categories use QA jargon (Boundary, Negative, Regression) |
| 9 | Result -> Done -> select all -> Approve | 4 | "Draft", "Approve" and "Mark ready" have no explained difference. Approving **clears the selection** |
| 10 | Select all again -> Run selected -> modal | 5 | Execution type (Automated/Manual/API), environment and run name. Drafts are filtered out silently |
| 11 | Run page | - | The run status shows **FAILED** when 1 of 8 checks fails, which reads as "the tool broke". A raw Playwright locator dump appears in a red "Error" box |
| 12 | Defect | manual | Each failure needs "Create defect" plus a long form. "Analyse failure" is a separate click |

## Top 10 problems (ranked by impact)

1. **Authorisation blocks the first run and is hidden in a heavy modal.**
   - Where: `NewProjectModal.tsx` creates the environment with `authorised:false`. The fix lives in `EnvironmentsTab.tsx` behind a pencil icon.
   - Why it hurts: the user hits "No authorised environments..." on Discovery and has to find a tab, an icon and a checkbox at the bottom of a 12-control form.
   - Fix: put the checkbox in the New project modal ("I own this site or have permission to test it") and send `authorised:true`. Add an inline "Confirm and continue" button on Discovery and Run instead of pointing to another tab.

2. **There's no guided path after creating a project.**
   - Where: `OverviewTab.tsx`, and the project page defaulting to Overview.
   - Fix: replace the empty Overview with a 3-step checklist card: "1 Scan your site · 2 Review suggested checks · 3 Run them". Each step has one orange CTA and a done state. Land new projects on it and hide the KPI cards until the first run.

3. **The draft/approve/ready gate adds 4+ clicks and new vocabulary before any value.**
   - Where: `TestCasesTab.tsx`, `NewRunModal.tsx`, API `POST /test-runs`.
   - Fix: after generation, show "Run these 8 checks" (approve and run in one action, recorded in the audit log as "approved by <user> on run"). Rename the statuses: Draft -> "Suggested", Approved/Ready -> "Active" (merge them, since "Mark ready" has no explained difference), Deprecated -> "Archived". Keep the selection after a bulk approve.

4. **The generator defaults to the wrong source and asks for QA taxonomy.**
   - Where: `GenerateCasesModal.tsx` (`useState("DESCRIPTION")`, 10 category checkboxes, count).
   - Fix: default to `DISCOVERY` when one exists. Collapse categories and count under "Advanced". Copy: "We'll suggest checks for your pages and forms. Want something specific? Describe it (optional): e.g. 'checkout with a coupon'". Make "Generate test cases from this map ->" open this modal directly.

5. **Run results read as a tool failure, and failure text is raw.**
   - Where: `test-runs/[id]/page.tsx` (run StatusPill FAILED) and `ResultDetail.tsx` (the `<pre>` Error box).
   - Fix: add a headline sentence: "1 problem found in 8 checks". Label the run "Completed · 1 problem" rather than FAILED, and reserve "Error" for runs that couldn't execute. Show `actualResult` as the lead ("What we expected / What happened"). Put the Playwright error in a collapsed "Technical details" section. Open failed rows by default.

6. **Failure messages are garbled for generated sentences.** Seen live:
   > Step "Verify the form is not accepted" failed: A message asks for Message and no success message appears.
   - Fix (in the api rule translator): use a template like "We left **Message** empty and submitted. Expected: the form is rejected. Actual: it showed 'Thank you' (/contact)." For assumption-based cases, add "This check assumed Message is required. If it's optional, [Ignore this check]."

7. **Environments are jargon and appear too early.**
   - Where: the "Environment" select in `NewProjectModal.tsx`, plus the Environments tab.
   - Fix: remove it from creation and default to a single unnamed target ("Your site"). Rename the tab to "Site settings" and move it near the end. Group workers, slow motion, wsEndpoint and JSON under "Advanced (for automation engineers)". Rename "Allow destructive actions" to "Let tests submit forms and change data". Rename "Credentials (write-only)" to "Test login (optional): lets us check pages behind sign-in".

8. **Too many top-level choices.** The project has 9 tabs, the sidebar has 7 items, and the dashboard has 5 quick actions.
   - Fix: reduce to 4 primary tabs: **Checks · Runs · Problems · Settings**. Move Discovery (as "Site map"), API, Reports and Defects into secondary placement, and only show API for API projects. On the dashboard, keep one primary CTA ("Test a site") until a project exists. Disable or hide "Run a test" and "Generate test cases" when there are no projects.

9. **Defects need manual triage that founders won't do.**
   - Where: `ResultDetail.tsx` "Create defect" + `DefectFormModal`, plus a separate "Analyse failure" click.
   - Fix: auto-attach the analysis to failed results. Use one-click "Mark as bug" (pre-filled, severity defaulted) and "Not a bug, ignore". Rename "Defects" to "Bugs" and "Severity/Priority" to a single "How bad?" field.

10. **Discovery output is a technical crawl dump and leads with caveats.**
    - Where: `DiscoveryTab.tsx` (`AppMap` shows Limitations first, then depth, HTTP status, links).
    - Fix: lead with "Found 6 pages and 2 forms (Contact, Sign in). Sign-in detected: add a test login to check pages behind it." Show page screenshots as a grid, then move limitations to a footnote. Replace "Max pages" with a sensible default under Advanced.

Also worth noting:
- the register form says "Organisation" but the heading says "workspace"
- Help (`help/page.tsx`) repeats the jargon, and Help isn't in the sidebar
- `NewRunModal` starts with nothing selected unless cases were pre-selected
- the README describes the product as an "AI-assisted QA platform", which signals "for QA people"

## Quick wins (under half a day each)

| ID | Change | Files |
|---|---|---|
| QW-1 | Authorisation checkbox in New project modal; send `authorised:true` | `NewProjectModal.tsx` |
| QW-2 | Generator defaults to Discovery when available; categories and count behind "Advanced" | `GenerateCasesModal.tsx` |
| QW-3 | "Generate test cases from this map" opens the modal (`?tab=test-cases&generate=1`) | `DiscoveryTab.tsx`, `TestCasesTab.tsx` |
| QW-4 | Keep selection after bulk approve; pre-select all eligible cases in Run modal | `TestCasesTab.tsx`, `NewRunModal.tsx` |
| QW-5 | Run headline "N problems found in M checks"; failed rows open by default; Error `<pre>` collapsed as "Technical details" | `test-runs/[id]/page.tsx`, `ResultDetail.tsx` |
| QW-6 | Copy pass: Draft -> Suggested, Defects -> Bugs, Environment select removed from create, plain-English hints | various + `StatusPill.tsx` labels |
| QW-7 | Overview empty state becomes a 3-step checklist with deep links | `OverviewTab.tsx` |
| QW-8 | Dashboard: single "Test a site" CTA when there are 0 projects; hide KPIs/trend until first run | `dashboard/page.tsx` |

## Bigger changes (1-5 days each)

| ID | Change | Notes |
|---|---|---|
| BC-1 | "Paste URL -> scan -> suggest -> run" onboarding wizard after signup | Chains existing endpoints. Needs UX design (ux-designer). M |
| BC-2 | "Run suggested checks" = approve and run in one action | API: allow `autoApprove` on the run with audit log entry. M |
| BC-3 | Plain-English failure narratives from the rule translator | `api` scriptgen and runner message templates. M |
| BC-4 | IA consolidation to 4 project tabs plus Advanced settings | Needs UX design. M-L |
| BC-5 | One-click "Mark as bug / Ignore" with auto analysis | API + UI. M |
| BC-6 | Activation instrumentation (signup -> first result funnel) | S-M |

**Deliberately not doing now:** removing manual runs, the API tab or the Playwright export. They are valid for the secondary QA/dev persona; hide them, don't delete them.

## Evidence notes

- A throwaway workspace "UX-REVIEW-pm" was created via the API. Its project "UX-REVIEW demo" points at the DemoShop target on :4100. No existing projects were touched.
- Confirmed via API: a new environment is `authorised:false`; discovery before authorisation returns 409 with "Confirm that you are authorised to test ... (Environments tab)". Running drafts returns "Only approved or ready test cases can be executed. Not approved: TC-0001, ...". The 8-case run completed in 15 s, 7 passed and 1 failed (TC-0006, the empty message bug), and the run status was `FAILED`.
