# Backlog

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
