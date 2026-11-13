// UI behaviour against the stubbed API in ./fixtures.ts (development aid; the real-backend journeys live in ../).
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { ACCESS_GAPS, HOSTILE_DOM, event, mockApi, newState, project, signedIn, type MockState } from "./fixtures";

async function axe(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  return r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`);
}

test.describe("auth", () => {
  test("sign up lands on the first-run dashboard with no metric tiles", async ({ page }) => {
    const s = newState();
    await mockApi(page, s);
    await page.goto("/register");
    await page.getByLabel("Full name").fill("Daniele Edema");
    await page.getByLabel("Work email").fill("daniele@acme.test");
    await page.getByRole("textbox", { name: "Password", exact: true }).fill("correct horse battery");
    await page.getByLabel("Organisation name").fill("Acme Ltd");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Welcome, Daniele");
    await expect(page.getByText("What happens next")).toBeVisible();
    await expect(page.getByText("Active projects")).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
    await expect(page.getByText("Acme Ltd").first()).toBeVisible();
    expect(s.requests.find((r) => r.path === "/auth/register")?.body).toMatchObject({ full_name: "Daniele Edema", organisation_name: "Acme Ltd" });
    expect(await axe(page)).toEqual([]);
  });

  test("server email errors are shown as product copy, not validator text", async ({ page }) => {
    await mockApi(
      page,
      newState({ registerFieldError: { field: "email", message: "value is not a valid email address: The part after the @-sign is a special-use or reserved name that cannot be used with email." } }),
    );
    await page.goto("/register");
    await page.getByLabel("Full name").fill("Erin Example");
    await page.getByLabel("Work email").fill("erin@acme.test");
    await page.getByRole("textbox", { name: "Password", exact: true }).fill("correct horse battery");
    await page.getByLabel("Organisation name").fill("Acme Ltd");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByText("This email domain can’t be used. Enter your work email address.")).toBeVisible();
    await expect(page.getByText(/special-use or reserved/)).toHaveCount(0);
    await expect(page.getByLabel("Work email")).toBeFocused();
  });

  test("weak password is caught before submit", async ({ page }) => {
    await mockApi(page, newState());
    await page.goto("/register");
    await page.getByRole("textbox", { name: "Password", exact: true }).fill("short");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByText("Use at least 12 characters.")).toBeVisible();
    await expect(page.getByLabel("Full name")).toBeFocused();
  });

  test("wrong credentials clear and focus the password", async ({ page }) => {
    await mockApi(page, newState({ wrongPassword: true }));
    await page.goto("/login");
    await page.getByLabel("Email").fill("x@acme.test");
    await page.getByRole("textbox", { name: "Password", exact: true }).fill("not-the-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "incorrect" })).toHaveText("Email or password is incorrect.");
    await expect(page.getByRole("textbox", { name: "Password", exact: true })).toHaveValue("");
    await expect(page.getByRole("textbox", { name: "Password", exact: true })).toBeFocused();
    expect(await axe(page)).toEqual([]);
  });

  test("password toggle is a real pressed button", async ({ page }) => {
    await mockApi(page, newState());
    await page.goto("/login");
    const toggle = page.getByRole("button", { name: "Show password" });
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await toggle.click();
    await expect(page.getByRole("button", { name: "Hide password" })).toHaveAttribute("aria-pressed", "true");
  });

  test("sign out returns to login with a notice", async ({ page }) => {
    const s = newState();
    await mockApi(page, s);
    await signedIn(page, s);
    await page.goto("/dashboard");
    await page.getByRole("button", { name: /Account menu/ }).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByText("You’ve signed out.")).toBeVisible();
  });
});

test.describe("dashboard and Gate 1", () => {
  test("bare host gets an https hint and goes to /projects/new", async ({ page }) => {
    const s = newState();
    await mockApi(page, s);
    await signedIn(page, s);
    await page.goto("/dashboard");
    await page.getByLabel("Website URL").fill("example.com");
    await expect(page.getByText("We’ll analyse https://example.com")).toBeVisible();
    await expect(page.getByText("Reachable")).toBeVisible();
    await page.getByRole("button", { name: "Start QA Analysis" }).click();
    await expect(page).toHaveURL(/\/projects\/new\?url=https%3A%2F%2Fexample\.com/);
  });

  test("client-side checks block private and non-web URLs when the server blocks private targets", async ({ page }) => {
    const s = newState({ allowPrivateTargets: false });
    await mockApi(page, s);
    await signedIn(page, s);
    await page.goto("/dashboard");
    const field = page.getByLabel("Website URL");
    for (const [value, copy] of [
      ["", "Enter a website URL."],
      ["ftp://example.com", "Only http:// and https:// websites can be analysed."],
      ["https://user:pw@example.com", "Remove the username and password from the URL."],
      ["http://localhost:3000", "resolves to a private or internal address"],
    ]) {
      await field.fill(value);
      await page.getByRole("button", { name: "Start QA Analysis" }).click();
      await expect(page.getByText(copy)).toBeVisible();
      await expect(field).toHaveAttribute("aria-invalid", "true");
    }
    expect(s.requests.some((r) => r.path === "/projects" && r.method === "POST")).toBe(false);
  });

  test("BUG-4: with private targets allowed by the server, localhost defers to the server check and can be started", async ({ page }) => {
    const s = newState({ allowPrivateTargets: true });
    await mockApi(page, s);
    await signedIn(page, s);
    await page.goto("/dashboard");
    await page.getByLabel("Website URL").fill("http://localhost:4100");
    await expect(page.getByText("Reachable")).toBeVisible();
    await page.getByRole("button", { name: "Start QA Analysis" }).click();
    await expect(page).toHaveURL(/\/projects\/new\?url=http%3A%2F%2Flocalhost%3A4100/);
    await expect(page.getByText("Reachable")).toBeVisible();
    await page.getByRole("checkbox", { name: /I am authorised to test this site/ }).check();
    await page.getByRole("button", { name: "Start QA Analysis" }).click();
    await expect(page).toHaveURL(/\/projects\/p1\/discovery/);
    expect(s.requests.find((r) => r.path === "/projects" && r.method === "POST")?.body).toMatchObject({ url: "http://localhost:4100" });
    // The metadata address stays blocked in the browser even then.
    await page.goto("/dashboard");
    await page.getByLabel("Website URL").fill("http://169.254.169.254/");
    await page.getByRole("button", { name: "Start QA Analysis" }).click();
    await expect(page.getByText("This is a cloud metadata address. It can't be analysed.")).toBeVisible();
  });

  test("BUG-4: when /health doesn't say, private hosts go to the server, which blocks them with the same copy", async ({ page }) => {
    const s = newState();
    await mockApi(page, s);
    await signedIn(page, s);
    await page.goto(`/projects/new?url=${encodeURIComponent("http://localhost:3000")}`);
    await expect(page.getByText("resolves to a private or internal address").first()).toBeVisible();
    await expect(page.getByLabel("Website URL")).toHaveAttribute("aria-invalid", "true");
    expect(s.requests.some((r) => r.path === "/projects/url-check")).toBe(true);
  });

  test("metadata address is blocked by the server check with no way to continue", async ({ page }) => {
    const s = newState();
    await mockApi(page, s);
    await signedIn(page, s);
    await page.goto(`/projects/new?url=${encodeURIComponent("http://169.254.169.254/")}`);
    await expect(page.getByText("This is a cloud metadata address. It can't be analysed.").first()).toBeVisible();
    await expect(page.getByLabel("Website URL")).toHaveAttribute("aria-invalid", "true");
    await page.getByRole("checkbox", { name: "I am authorised to test this site." }).check();
    await page.getByRole("button", { name: "Start QA Analysis" }).click();
    expect(s.requests.some((r) => r.path === "/projects" && r.method === "POST")).toBe(false);
  });

  test("unticked authorisation shows the error and focuses the checkbox; button never disabled", async ({ page }) => {
    const s = newState();
    await mockApi(page, s);
    await signedIn(page, s);
    await page.goto(`/projects/new?url=${encodeURIComponent("https://acme.com")}`);
    await expect(page.getByText("Reachable")).toBeVisible();
    const submit = page.getByRole("button", { name: "Start QA Analysis" });
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(page.getByText("Confirm you're authorised to test this site.")).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "I am authorised to test this site." })).toBeFocused();
    expect(await axe(page)).toEqual([]);
  });

  test("invalid scan settings expand the disclosure", async ({ page }) => {
    const s = newState();
    await mockApi(page, s);
    await signedIn(page, s);
    await page.goto(`/projects/new?url=${encodeURIComponent("https://acme.com")}`);
    await page.getByRole("button", { name: "Show scan settings (optional)" }).click();
    await page.getByLabel("Maximum pages").fill("500");
    await page.getByRole("button", { name: "Hide scan settings" }).click();
    await page.getByRole("checkbox", { name: "I am authorised to test this site." }).check();
    await page.getByRole("button", { name: "Start QA Analysis" }).click();
    await expect(page.getByText("Enter a whole number from 1 to 100.")).toBeVisible();
    await expect(page.getByLabel("Maximum pages")).toBeFocused();
  });

  test("valid submission lands on Discovery live with a toast; duplicate offers Create anyway", async ({ page }) => {
    const s = newState({ duplicateOnce: true });
    await mockApi(page, s);
    await signedIn(page, s);
    await page.goto(`/projects/new?url=${encodeURIComponent("https://acme.com")}`);
    await page.getByRole("checkbox", { name: "I am authorised to test this site." }).check();
    await page.getByRole("button", { name: "Start QA Analysis" }).click();
    await expect(page.getByText("You already have a project for acme.com.")).toBeVisible();
    await expect(page.getByRole("link", { name: /Open project/ })).toHaveAttribute("href", "/projects/p1");
    await page.getByRole("button", { name: "Create anyway" }).click();
    await expect(page.getByText("Project created. Discovery has started.")).toBeVisible();
    await expect(page).toHaveURL(/\/projects\/p1\/discovery/);
    await expect(page.getByRole("tab", { name: "Live" })).toHaveAttribute("aria-selected", "true");
    const creates = s.requests.filter((r) => r.path === "/projects" && r.method === "POST");
    expect(creates).toHaveLength(2);
    expect(creates[1].body).toMatchObject({ confirmDuplicate: true, authorisation: { attested: true }, scan: { max_pages: 30 } });
  });
});

function runningProject(s: MockState) {
  s.projects = [project()];
  s.events = [
    event(1, { agent_key: "orchestrator", type: "stage.status_changed", message: "Started Application Discovery", data: { stage_key: "discovery", from: "queued", to: "running" } }),
    event(2, { type: "log", message: "Visiting /contact" }),
    event(3, { type: "page.discovered", message: "Found form: Contact (3 fields)", data: { url: "https://acme.com/contact", title: "Contact us", screenshot: { id: "ev2", content_url: "http://localhost:8200/api/v1/evidence/ev2/content?exp=1&sig=x" } } }),
  ];
}

test.describe("project workspace", () => {
  test("sidebar lists 12 sections; unbuilt ones are labelled and honest", async ({ page }) => {
    const s = newState();
    runningProject(s);
    await mockApi(page, s);
    await signedIn(page, s);
    await page.goto("/projects/p1");
    const nav = page.getByRole("navigation", { name: "Project sections" });
    await expect(nav.getByRole("link")).toHaveCount(12);
    await expect(nav.getByRole("link", { name: "Requirements, coming in Phase 2" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "AI QA Analyst, coming in Phase 2" })).toBeVisible();
    await nav.getByRole("link", { name: "Test Cases, coming in Phase 3" }).click();
    await expect(page.getByText("Test Cases: coming in Phase 3")).toBeVisible();
    await expect(page.getByRole("table")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Go to Application Discovery" })).toBeVisible();
  });

  test("overview: lifecycle running step, 21 steps, feed with evidence, pause", async ({ page }) => {
    const s = newState();
    runningProject(s);
    await mockApi(page, s);
    await signedIn(page, s);
    await page.goto("/projects/p1");
    const lifecycle = page.getByRole("list", { name: "QA lifecycle" });
    await expect(lifecycle.getByText("Running, step 4 of 8")).toBeVisible();
    await expect(lifecycle.getByText("Phase 5")).toBeVisible();
    await page.getByRole("button", { name: "Show all 21 steps" }).click();
    await expect(page.getByText("Release readiness assessment")).toBeVisible();
    await expect(page.getByText("Gate 9 · Release readiness")).toBeVisible();

    const feed = page.getByRole("list", { name: "Agent events, newest first" });
    const row = feed.getByRole("listitem").filter({ hasText: "Found form: Contact (3 fields)" });
    await expect(row).toBeVisible();
    await expect(row.getByText("Observed")).toBeVisible();
    await expect(row.getByRole("button", { name: /Screenshot evidence for Found form/ })).toBeVisible();
    // Replayed events (reconnects send Last-Event-ID) never duplicate rows.
    await page.waitForTimeout(2500);
    await expect(feed.getByText("Visiting /contact", { exact: true })).toHaveCount(1);

    await page.getByRole("button", { name: "Pause analysis" }).click();
    await expect(page.getByRole("button", { name: "Resume analysis" })).toBeVisible();
    await expect(page.getByText("Analysis paused. Resume any time; nothing is lost.")).toBeVisible();
    expect(await axe(page)).toEqual([]);
  });

  test("evidence drawer renders hostile DOM as inert text", async ({ page }) => {
    const s = newState({ phase: "awaiting" });
    runningProject(s);
    await mockApi(page, s);
    await signedIn(page, s);
    await page.goto("/projects/p1/discovery?view=functionality");
    await page.getByRole("button", { name: "Contact form", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: /evidence for Contact form/ }).nth(1).click();
    const pre = page.getByLabel("DOM snippet, shown as text");
    await expect(pre).toHaveText(HOSTILE_DOM);
    await expect(pre.locator("a, script")).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: boolean }).__pwned)).toBeUndefined();
  });

  test("BUG-2: Gate 2 under the default recommended policy offers review and approval, each finding once", async ({ page }) => {
    const s = newState({ phase: "awaiting" });
    runningProject(s);
    await mockApi(page, s);
    await signedIn(page, s);
    await page.goto("/projects/p1/discovery");
    await expect(page.getByRole("tab", { name: "Live" })).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "Summary" })).toHaveAttribute("aria-selected", "true");
    const panel = page.locator("section").filter({ has: page.getByRole("heading", { name: "Gate 2 · Discovery completeness" }) });
    await expect(panel.getByText("Ready for review")).toBeVisible();
    await expect(panel.getByText("Not reached")).toHaveCount(0);
    await expect(panel.getByText("Approval is recommended but not required.", { exact: false })).toBeVisible();
    await expect(panel.getByText("Agent assessment: Partially complete")).toBeVisible();
    await expect(panel.getByText("Generated by rules (AI not configured)").first()).toBeVisible();
    // The same finding arrives as a completeness reason, a checklist line and a recommendation reason.
    await expect(panel.getByText("1 area needs credentials (/account)")).toHaveCount(1);
    await expect(panel.getByText("Signed-in area not observed")).toHaveCount(1);
    expect(await axe(page)).toEqual([]);
    await panel.getByLabel("Comment").fill("Public site only for now.");
    await panel.getByRole("button", { name: "Approve discovery" }).click();
    const approvedLine = page.getByText(/by Daniele Edema, .* · “Public site only for now.”/);
    await expect(approvedLine).toBeVisible();
    await expect(page.locator(":focus")).toContainText("Public site only for now.");
    expect(s.requests.find((r) => r.path.endsWith("/gates/G2/decision"))?.body).toEqual({ decision: "approve", comment: "Public site only for now.", stage_run_version: 1 });
  });

  test("BUG-2: Gate 2 under the required policy says approval is required", async ({ page }) => {
    const s = newState({ phase: "awaiting", g2Policy: "required" });
    runningProject(s);
    await mockApi(page, s);
    await signedIn(page, s);
    await page.goto("/projects/p1/discovery");
    const panel = page.locator("section").filter({ has: page.getByRole("heading", { name: "Gate 2 · Discovery completeness" }) });
    await expect(panel.getByText("Waiting for your approval")).toBeVisible();
    await expect(panel.getByText("Approval is required before the next stage can start.", { exact: false })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Approve discovery" })).toBeVisible();
  });

  test("BUG-9: after Pause the Live card follows the stage, not the stale scan record", async ({ page }) => {
    const s = newState();
    runningProject(s);
    await mockApi(page, s);
    await signedIn(page, s);
    await page.goto("/projects/p1/discovery");
    await expect(page.getByRole("heading", { name: "Exploring acme.com" })).toBeVisible();
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Paused on acme.com" })).toBeVisible();
    await expect(page.getByRole("heading", { name: /Exploring/ })).toHaveCount(0);
    await expect(page.getByText("Discovery is paused.")).toBeVisible();
    await expect(page.getByText("2 pages visited so far.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Pause", exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Scan")).toContainText("paused");
  });

  test("BUG-5: journey steps show the API's own labels, not guesses from their wording", async ({ page }) => {
    const s = newState({ phase: "awaiting" });
    runningProject(s);
    await mockApi(page, s);
    await signedIn(page, s);
    await page.goto("/projects/p1/discovery?view=journeys");
    const steps = page.getByRole("list", { name: "Steps of Contact the company" }).getByRole("listitem");
    await expect(steps).toHaveCount(3);
    await expect(steps.nth(0)).toContainText("Go to Sign in · Acme");
    await expect(steps.nth(0)).toContainText("Observed");
    await expect(steps.nth(0)).not.toContainText("Inferred");
    await expect(steps.nth(2)).toContainText("Fill in the contact form");
    await expect(steps.nth(2)).toContainText("Inferred");
    await expect(page.getByText("Steps 1–2 were navigated; filling in and sending the form was not performed (read-only).")).toBeVisible();
  });

  test("BUG-6: access gaps are exactly the API's gaps, counted once, with reason and evidence", async ({ page }) => {
    const s = newState({ phase: "awaiting" });
    runningProject(s);
    await mockApi(page, s);
    await signedIn(page, s);
    await page.goto("/projects/p1/discovery?view=gaps");
    const table = page.getByRole("table", { name: "Access gaps" });
    await expect(table.getByRole("row")).toHaveCount(ACCESS_GAPS.length + 1);
    await expect(page.getByRole("tab", { name: /Access gaps/ })).toContainText(String(ACCESS_GAPS.length));
    const account = table.getByRole("row").filter({ hasText: "/account" });
    await expect(account).toContainText("Needs credentials");
    await expect(account.getByRole("button", { name: /evidence for access gap \/account/ })).toBeVisible();
    const form = table.getByRole("row").filter({ hasText: "Contact form (/contact)" });
    await expect(form).toContainText("Not performed: destructive or transactional action");
    // Two refs → one "Evidence (2)" button that opens both in the drawer.
    await expect(form.getByRole("button", { name: /evidence for access gap Contact form/ })).toHaveText("Evidence (2)");
    await expect(table.getByText("Evidence missing")).toHaveCount(0);
    await expect(table.getByText("Couldn’t observe")).toHaveCount(0);
    await page.getByRole("tab", { name: "Summary" }).click();
    await expect(page.getByText("Access gaps").first()).toBeVisible();
  });

  test("BUG-7: Responsive shows desktop and mobile per page, and an empty state when nothing differs", async ({ page }) => {
    const s = newState({ phase: "awaiting" });
    runningProject(s);
    await mockApi(page, s);
    await signedIn(page, s);
    await page.goto("/projects/p1/discovery?view=responsive");
    await expect(page.getByRole("img", { name: /Screenshot of Home .*Desktop/ })).toBeVisible();
    await expect(page.getByRole("img", { name: /Screenshot of Home .*Mobile/ })).toBeVisible();
    await expect(page.getByRole("img", { name: /Screenshot of Contact us .*Mobile/ })).toBeVisible();
    await expect(page.getByText("2 of 2 pages show a difference between desktop and mobile.")).toBeVisible();

    const same = newState({ phase: "awaiting", responsiveDiffs: false });
    runningProject(same);
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await mockApi(page, same);
    await signedIn(page, same);
    await page.reload();
    await expect(page.getByRole("img", { name: /Screenshot of Home .*Desktop/ })).toBeVisible();
    await expect(page.getByText("0 of 2 pages show a difference between desktop and mobile.")).toBeVisible();
    await page.getByRole("checkbox", { name: "Only pages with differences" }).check();
    await expect(page.getByText("No layout differences observed.")).toBeVisible();
    await expect(page.getByRole("img", { name: /Screenshot of Home/ })).toHaveCount(0);
  });

  test("BUG-10: at 375 px the sitemap doesn't scroll sideways and the functionality map is cards", async ({ page }) => {
    const s = newState({ phase: "awaiting" });
    runningProject(s);
    await mockApi(page, s);
    await signedIn(page, s);
    await page.setViewportSize({ width: 375, height: 800 });
    for (const view of ["sitemap", "functionality", "gaps", "summary"]) {
      await page.goto(`/projects/p1/discovery?view=${view}`);
      await expect(page.getByRole("heading", { level: 1, name: "Application Discovery" })).toBeVisible();
      await page.waitForLoadState("networkidle");
      const width = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(width, `${view} document width`).toBeLessThanOrEqual(375);
    }
    await page.goto("/projects/p1/discovery?view=sitemap");
    await expect(page.getByRole("list", { name: "Pages found" }).getByRole("listitem")).toHaveCount(3);
    await expect(page.getByRole("table", { name: "Pages found" })).toBeHidden();
    await page.goto("/projects/p1/discovery?view=functionality");
    await expect(page.getByRole("region", { name: "Functionality map" })).toBeHidden();
    // Per-page cards: the /contact card shows its counts as buttons.
    await expect(page.locator("li").filter({ hasText: "/contact" }).getByRole("button", { name: /1 form on \/contact/ })).toBeVisible();
  });

  test("reports list marks a report based on an older scan", async ({ page }) => {
    const s = newState({ phase: "awaiting", rescanned: true });
    runningProject(s);
    await mockApi(page, s);
    await signedIn(page, s);
    await page.goto("/projects/p1/reports");
    const table = page.getByRole("table", { name: "Discovery reports" });
    await expect(table.getByRole("row").filter({ hasText: "v1" })).toContainText("Based on an older scan");
    await expect(table.getByRole("row").filter({ hasText: "v2" })).not.toContainText("Based on an older scan");
  });

  test("sitemap tree keyboard and list mode", async ({ page }) => {
    const s = newState({ phase: "awaiting" });
    runningProject(s);
    await mockApi(page, s);
    await signedIn(page, s);
    await page.goto("/projects/p1/discovery?view=sitemap");
    const tree = page.getByRole("tree", { name: "Sitemap" });
    const first = tree.getByRole("treeitem").first();
    await first.focus();
    await page.keyboard.press("End");
    await expect(tree.getByRole("treeitem").last()).toBeFocused();
    await page.keyboard.press("Home");
    await expect(first).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toContainText("Contact us");
    await page.keyboard.press("Escape");
    await page.getByRole("radio", { name: "List" }).click();
    await expect(page.getByRole("table", { name: "Pages found" }).getByRole("row")).toHaveCount(4);
  });

  test("report shows sections 1–8, A–B and downloads the PDF with the right name", async ({ page }) => {
    const s = newState({ phase: "awaiting" });
    runningProject(s);
    await mockApi(page, s);
    await signedIn(page, s);
    await page.goto("/projects/p1/reports/discovery");
    await expect(page.getByRole("heading", { level: 1, name: "Application Discovery Report" })).toBeVisible();
    for (const h of ["Summary", "Scope & approach", "Sitemap", "Functionality", "User journeys", "Responsive", "Access gaps & limitations", "Completeness (Gate 2)", "Evidence index", "Labels & glossary"])
      await expect(page.getByRole("heading", { level: 2, name: new RegExp(h.replace(/[()&]/g, ".")) })).toBeVisible();
    await expect(page.getByText("Discovery observes the user interface only. Backend behaviour, data handling and security have not been verified.")).toBeVisible();
    await expect(page.getByText("Draft — awaiting Gate 2")).toBeVisible();
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download PDF" }).click();
    expect((await download).suggestedFilename()).toMatch(/^acme\.com-discovery-report-scan1-\d{4}-\d{2}-\d{2}\.pdf$/);
  });

  test("mobile drawer traps focus and Escape returns to the hamburger", async ({ page }) => {
    const s = newState();
    runningProject(s);
    await mockApi(page, s);
    await signedIn(page, s);
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto("/dashboard");
    const burger = page.getByRole("button", { name: "Open navigation" });
    await burger.click();
    await expect(page.getByRole("button", { name: "Close navigation" })).toBeFocused();
    for (let i = 0; i < 12; i++) await page.keyboard.press("Tab");
    expect(await page.evaluate(() => !!document.activeElement?.closest('[aria-label="Navigation"]'))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(burger).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
