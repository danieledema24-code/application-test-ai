# Full journey end-to-end test through the web UI

- **Date:** 2026-11-12
- **Branch:** `detailed-checks` (no product code changed)
- **Tester:** QA agent, headless Chromium (Playwright 1.64), viewport 1366x900
- **Environment:** web `http://localhost:3002` (Next.js dev), API `http://localhost:4000/api` (Fastify), target demo shop `http://localhost:4100`. AI not configured, so checks and failure analysis came from the rule-based generators.
- **Account:** fresh `qa+<timestamp>@example.com` per run. The generated password is written only to `api/test/ui-journey-account.local.txt`, which is gitignored.
- **Script:** `api/test/ui-full-journey.mjs`

## Verdict: PASS WITH NOTES

Every step of the journey works through the UI: sign-up, sign-in, project, scan, checks, approve and run, results, and downloads (32/32 automated checks pass on the final run). The deliberate contact-form bug is caught and has screenshot, video and trace evidence.

There is one **major** correctness bug. The failure analysis labels that real application bug as a **"Script" problem** ("the failure looks like a problem in the automation script rather than the application"), and the CSV report carries the same `SCRIPT` label. A non-QA user would conclude the tool is broken, not their site.

## Step results (final run)

Screenshots are in `/private/tmp/claude-501/-Users-danieledema-football-predictor/716cc19a-68a4-4b9a-b61c-cb2d9406cfc3/scratchpad/e2e-shots/` (abbreviated `shots/` below). Downloads are in `.../scratchpad/e2e-downloads/`.

| # | Step | Result | Evidence |
|---|------|--------|----------|
| 1.1 | Opening the app sends a signed-out visitor to Sign in | PASS | `shots/01-login.png` |
| 1.2 | Sign-up rejects a short password | PASS | Browser native tooltip "Please lengthen this text to 8 characters or more" (see UX note U6) |
| 1.3 | "Create a workspace" with a fresh account lands on the dashboard | PASS | `shots/02-dashboard-empty.png`, empty state "Test a site" |
| 2.1 | Log out from the user menu | PASS | Back on /login, `ata_token` removed from localStorage |
| 2.2 | /dashboard after logout redirects to sign-in | PASS | `/login?next=%2Fdashboard` |
| 2.3 | Wrong password rejected with a clear message | PASS | "Incorrect email or password", `shots/03-wrong-password.png` |
| 2.4 | Sign back in | PASS | /dashboard |
| 3.1 | Create project for http://localhost:4100 (permission box left unticked on purpose) | PASS | `shots/05-project-overview.png` |
| 3.2 | Site scan tab asks for permission; "I have permission — continue" unlocks the scan | PASS | `shots/06-permission-prompt.png`, `shots/07-scan-form.png`; API shows env `authorised: true` |
| 4.1 | Start scan; live view appears while scanning | PASS (note) | Live panel and "Scanning…" shown. The scan of 6 pages takes about 4 s, so the frame `<img>` appeared but never painted before the scan ended. The API served frames (`hasFrame: true`). See U1. `shots/08-scan-live.png` |
| 4.2 | Scan completes; "Your checks are ready" shows counts | PASS | "We wrote 20 checks for the 6 pages we found": **20** step-by-step, **20** with an automated test. `shots/09-scan-ready.png` |
| 4.3 | Panel counts match the API generation record | PASS | UI 20/20 = API 20/20 |
| 5.1 | "See the checks" opens Test Cases filtered to this scan | PASS | 20 rows, `?tab=test-cases&scan=…`, `shots/10-checks-list.png` |
| 5.2 | A check has numbered steps, expected results, links and a script | PASS | TC-0001: 8 numbered steps, 8 "Expected", overall expected result, `http://localhost:4100/` links, 52-line Playwright spec. `shots/11-check-detail.png` |
| 6.1 | "Approve all and run" approves the drafts and opens the run dialog | PASS | Toast "20 checks approved"; dialog button "Run 20 checks"; API 20/20 APPROVED. `shots/12-run-dialog.png` |
| 6.2 | Run starts; live view and progress appear | PASS | 2 worker live frames painted; "Run is running — updating every 2 seconds". `shots/13-run-live.png` |
| 6.3 | Run completes with a plain-language outcome | PASS | "1 problem found in 20 checks", about 23 s. `shots/15-run-finished.png` |
| 7.1 | Pass/fail counts on page match recorded results | PASS | Chips All 20 / Failed 1 / Blocked 2 / Passed 17 = API; pass rate 94.4% |
| 7.2 | Contact-form bug reported as a failure with evidence | PASS (see B1) | TC-0011 'Contact form is not sent while "Message" is empty' FAILED. What we expected / What happened panels, failed step 6, final screenshot ("Thank you" page), video and trace. `shots/16-contact-failure-detail.png` |
| 7.3 | Blocked checks explain why | PASS | TC-0016, TC-0019: "Needs a test login: add a username and password for this site under Sites & logins, then run it again." `shots/17-blocked-detail.png` |
| 8.1 | Reports tab: run report as PDF, downloaded via the UI | PASS | `localhost-Run-RUN-0002-QA-report.pdf`, 19,358 bytes, `%PDF-1.3`, 2 pages, `%%EOF` present |
| 8.2 | Reports tab: run report as CSV; contents match the run | PASS | `localhost-Run-RUN-0002-QA-report.csv`, 3,553 bytes, 20 result rows, every key and status matches the API; summary Passed 17 / Failed 1 / Blocked 2 / Pass % 94.4 |
| 8.3 | Project PDF report downloaded from the report list's Download link | PASS | `localhost-Project-QA-report.pdf`, 19,342 bytes, 2 pages. `shots/21-reports-list.png` |
| 8.4 | Test Cases "Export CSV" | PASS | `test-cases.csv`, 38,553 bytes, 20 rows for 20 cases; columns ID, Title, Description, Preconditions, Steps, Expected result, Category, Priority, Status, Source, Version, Last result |
| 8.5 | "Download Playwright project" | PASS | `playwright-tests.zip`, 36,371 bytes, contains `playwright.config.ts` |
| 9.1 | Refresh a check page | PASS | Stays loaded, still signed in |
| 9.2 | Back button from check to list | PASS | Returns to the filtered list |
| 9.3 | Refresh the run page mid-run | PASS | Progress keeps updating. `shots/14-run-after-refresh.png` |
| 9.4 | Refresh the project page on a deep tab | PASS | Reports tab stays selected |
| 9.5 | Back from the run page | PASS | Returns to `?tab=reports` |
| 9.6 | Console errors across the journey | PASS | 0 unexpected. The only one is the 401 from the deliberate wrong-password attempt |
| 9.7 | Failed network requests | PASS | 0 unexpected. The only one is `POST /auth/login 401` from step 2.3 |

**Totals: 32 PASS, 0 FAIL, 0 BLOCKED, no workarounds needed.** Earlier runs had 6.2, 8.2, 8.3, 5.2 and 9.6/9.7 failing. Every one of those was a defect in the test script (non-waiting `isVisible`, an ambiguous "Close" button, the script being in a `<textarea>`, the expected 401). All were fixed in the script; none were product defects.

## Bugs

### B1. A real application bug is classified as a "Script" problem (major) — FIXED
- **Fix:** failed `expect(...)` checks (runner kind `assertion`, or the assertion text when no kind is passed) are now classed as APPLICATION before the script rule, and the bare `locator` match was removed from the script rule. Covered by `api/test/analysis.test.ts`. Verified by re-running TC-0011 (RUN-0003): FAILED, classification APPLICATION, confidence MEDIUM.
- **Where:** `api/src/services/analysis.ts:69`, the heuristic `if (ev.kind === "script" || /locator|strict mode violation|.../i.test(msg))`.
- **Steps:** Run the journey (or any automated run where a check's assertion fails). Open TC-0011 'Contact form is not sent while "Message" is empty' on the run page.
- **Expected:** The failure analysis says the application behaved differently from what was expected (APPLICATION). The final screenshot shows the form was sent ("Thank you") with an empty Message, which is exactly the deliberate bug.
- **Actual:** "Likely category: **Script** · Confidence: Medium. The failure looks like a problem in the automation script rather than the application." Possible causes: "A selector no longer matches the page…". The run CSV report's "AI classification (hypothesis)" column also says `SCRIPT`, and the PDF observations are built from the same field.
- **Cause:** Every Playwright assertion error contains `expect(locator).toBeVisible…`, so the `/locator/` pattern matches all ordinary assertion failures. Real app defects therefore get mislabelled as script issues.
- **Impact:** A non-QA user is told the tool's own test is broken and is steered away from filing the bug. That defeats the main value of the product.

### B2. Session token in download, image and video URLs (minor, security hygiene)
- **Where:** `web/src/lib/api.ts:150` `fileUrl()` appends `?token=<JWT>` to report download links, evidence images and videos.
- **Impact:** The full session token can land in browser history, server or proxy access logs, and the `Referer` header. Short-lived signed download URLs would be safer. It works functionally.

## UX notes for non-QA users

- **U1. Scan live view flashes by.** On a small site the scan takes about 4 s. The live panel appears, but the browser frame never paints, so the user sees a black "Waiting for the browser…" box and then the results. Consider keeping the last frame visible, or saying "Scan finished in 4 s".
- **U2. Misleading failure analysis** (B1). The purple "Hypothesis: Script" box is the most prominent explanation under the failure.
- **U3. Checks meant for a person run as automated steps.** Steps such as "Open DevTools > Network, tick Disable cache" and "Open DevTools > Network and clear the log" are shown as **Passed** in an automated run, which is meaningless to a reader. They are also intimidating for non-QA users following the steps by hand.
- **U4. Checks that can't run are approved and run anyway.** The scan already knows "Some pages need a sign-in" and no test login is saved, yet "Approve all and run" includes the two login checks, which then come back **Blocked**. The run is "Finished · 1 problem" plus 2 blocked. Either skip them with a clear "add a login to run these" prompt, or ask for the login first.
- **U5. Mixed terminology and defaults.**
  - The run is named "Automated run — 20 case(s)" while the rest of the UI says "checks".
  - The default environment is labelled **STAGING** even though the user only pasted one address.
  - The project is named "localhost" (taken from the hostname).
  - Badges say "Source: Rule based" and "Draft — check before approving".
- **U6. Short password message comes only from the browser.** The `minLength` attribute triggers the native tooltip before the friendly inline "Password must be at least 8 characters." can show. That's acceptable, but the inline message is effectively dead code.
- **U7. Duplicated quote in "What happened".** It reads `Step "Click "Send message"" failed…` (the closing quote is doubled).
- **U8. The floating "Ask AI" button covers content.** At 1366 px wide it overlapped the "Completed" value on the run summary card while the run was active.
- **U9. The PDF/CSV choice is a radio inside a modal, and the download is a second click.** That is fine, but "Generate" followed by "Download PDF" could be one action.

## Not covered by automation (check by hand)

- The visual content of the PDF (layout, the observation text containing "script issues"). Only the header, trailer, size and page count were verified.
- Behaviour on a slow or large site (live view, scan time), mobile viewport, keyboard-only navigation of the scan and run pages.
- Password reset by email, multiple users in one workspace, cancelling a run mid-way.
- Whether the MJPEG live view paints in Safari and Firefox (only Chromium was tested).

## How to re-run

With the web app (:3002), API (:4000) and demo shop (:4100) running:

```sh
cd api
node test/ui-full-journey.mjs                 # headless; writes to api/.runs/ui-journey/ (gitignored)
HEADED=1 node test/ui-full-journey.mjs        # watch it
SHOTS_DIR=/some/dir DOWNLOADS_DIR=/some/dir OUT_DIR=/some/dir node test/ui-full-journey.mjs
```

The script prints one PASS/FAIL line per step, writes `journey-result.json` (steps, notes, console errors, failed requests, downloads) and exits non-zero if any step fails. A full run takes about 1.5 minutes. Each run creates a new account and workspace.
