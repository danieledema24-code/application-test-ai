import { test } from "node:test";
import assert from "node:assert/strict";

// Rule-based checks written from a site scan read like a senior tester's: absolute URLs, full preconditions,
// 6–12 concrete steps from the scanned content, one field per validation case, and scripts that still run.
process.env.JWT_SECRET ??= "test";
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.ANTHROPIC_API_KEY = "";
process.env.ANTHROPIC_AUTH_TOKEN = "";

import type { DiscoveredPage } from "../src/services/discovery.js";

const { generateCases, caseOrigin } = await import("../src/services/generation.js");
const { heuristicScript, isAutomatable } = await import("../src/services/scriptgen.js");

const base = "https://shop.example.com";
const nav = [{ text: "Home", href: `${base}/` }, { text: "Contact", href: `${base}/contact` }, { text: "Sign in", href: `${base}/auth/signin` }, { text: "Get started", href: `${base}/auth/signup` }];
const navItems = nav.map((l) => l.text);
const field = (name: string, label: string, type: string, required: boolean, extra: Record<string, unknown> = {}) => ({ name, label, type, required, placeholder: "", ...extra });
const page = (path: string, title: string, h1: string, forms: DiscoveredPage["forms"] = [], headings: string[] = []): DiscoveredPage => ({
  url: `${base}${path}`, title, status: 200, depth: path === "/" ? 0 : 1, links: [], buttons: [], navItems, navLinks: nav, headings: [h1, ...headings], h1: [h1],
  screenshotEvidenceId: null, forms,
});
const pages = [
  page("/", "Shop – Everyday things", "Everyday things for your desk", [], ["Best sellers", "Why shop with us"]),
  page("/contact", "Contact – Shop", "Get in touch", [{
    action: `${base}/contact`, method: "POST", submit: "Send message",
    fields: [field("name", "Name", "text", true), field("email", "Email", "email", true, { placeholder: "name@example.com" }), field("message", "Message", "textarea", false),
      field("topic", "Topic", "select-one", false, { options: ["Select a topic", "Orders", "Returns"] })],
  }]),
  page("/auth/signin", "Shop – Everyday things", "Welcome back", [{
    action: `${base}/auth/signin`, method: "POST", submit: "Sign in",
    fields: [field("email", "Email Address", "email", true, { placeholder: "name@example.com" }), field("password", "Password", "password", true)],
  }]),
  page("/auth/signup", "Shop – Everyday things", "Create your account", [{
    action: `${base}/auth/signup`, method: "POST", submit: "Sign up",
    fields: [field("name", "Full Name", "text", true, { placeholder: "John Doe" }), field("email", "Email Address", "email", true), field("password", "Password", "password", true)],
  }]),
];
const ALL = ["FUNCTIONAL", "POSITIVE", "NEGATIVE", "FORM_VALIDATION", "BOUNDARY", "UI", "AUTHENTICATION", "ACCESSIBILITY", "REGRESSION"];
const { cases } = await generateCases({ source: "DISCOVERY", applicationUrl: base, pages, categories: ALL, count: 40 });
const find = (re: RegExp) => {
  const c = cases.find((x) => re.test(x.title));
  assert.ok(c, `no case matching ${re}: ${cases.map((x) => x.title).join(" | ")}`);
  return c;
};
const text = (c: (typeof cases)[number]) => [c.title, c.description, c.preconditions, c.expectedResult, ...c.steps.flatMap((s) => [s.action, s.expected, s.data])].join("\n");
const script = (c: (typeof cases)[number]) => heuristicScript({ key: "TC-1", title: c.title, expectedResult: c.expectedResult }, c.steps);

test("every case states browser, window size, a signed-out private window and that the site is reachable", () => {
  assert.ok(cases.length >= 20, `${cases.length} cases`);
  for (const c of cases) {
    assert.match(c.preconditions, /Google Chrome.*1366×768/, c.title);
    assert.match(c.preconditions, /private \(incognito\) window/, c.title);
    assert.match(c.preconditions, /https:\/\/shop\.example\.com\/ is reachable/, c.title);
    assert.ok(c.description.length > 40 && c.description !== c.title, `objective for ${c.title}`);
    assert.ok(c.expectedResult.length > 30, `overall expected result for ${c.title}`);
  }
});

test("every step that opens a page gives the absolute URL; no relative 'Open /path'", () => {
  for (const c of cases) for (const s of c.steps) {
    if (/^open\b(?! devtools)/i.test(s.action)) assert.match(s.action, /^Open https:\/\/shop\.example\.com\//, `${c.title}: ${s.action}`);
    assert.doesNotMatch(s.action, /^Open \//, c.title);
  }
  assert.match(find(/^Contact page loads/).steps[0].action, /^Open https:\/\/shop\.example\.com\/contact /);
});

test("cases have 6 to 12 steps, each with an action and a specific expected result", () => {
  for (const c of cases) {
    assert.ok(c.steps.length >= 6 && c.steps.length <= 12, `${c.title}: ${c.steps.length} steps`);
    for (const s of c.steps) {
      assert.ok(s.action.length > 5 && s.expected.length > 10, `${c.title}: ${s.action}`);
      assert.doesNotMatch(s.expected, /^(works|is correct|the page loads completely)$/i);
    }
  }
});

test("titles and sentences read naturally: no 'The the', 'page page' or paths in titles", () => {
  for (const c of cases) {
    assert.doesNotMatch(text(c), /\bthe the\b|\bpage page\b/i, c.title);
    assert.doesNotMatch(c.title, /\(\//, c.title);
  }
  assert.ok(find(/^Home page loads successfully with its title, heading and navigation$/));
  assert.ok(find(/^Contact page main heading "Get in touch" is visible and readable$/));
  // Pages that share one browser title are named from their path.
  assert.ok(find(/^Registered user can sign in on the Sign-in page/));
});

test("steps use the scanned headings, navigation, buttons, labels and placeholders, and invent no UI text", () => {
  const load = find(/^Contact page loads/);
  const all = text(load);
  for (const s of ['"Contact – Shop"', '"Get in touch"', '"Home", "Contact", "Sign in" and "Get started"', '"Email" (placeholder "name@example.com")', '"Send message" button'])
    assert.ok(all.includes(s), `missing ${s}`);
  assert.ok(find(/^Home page loads/).steps.some((s) => s.expected.includes('"Best sellers" and "Why shop with us"')), "section headings");
  // Every double-quoted string in a step is scanned content or fixed test data, never made-up UI text.
  const scanned = new Set(pages.flatMap((p) => [p.title, ...p.headings, ...p.navItems, ...p.forms.flatMap((f) => [f.submit, ...f.fields.flatMap((x) => [x.label, x.placeholder, ...(x.options ?? [])])])]));
  const testData = new Set(["Disable cache", "not-an-email", "jane@", "wrong-password-123", "Str0ng-Passw0rd!", "Any-Passw0rd", "Jane Doe", "jane.doe@example.com", "Hello, I would like to know when my order will arrive."]);
  for (const c of cases) for (const s of c.steps)
    for (const m of `${s.action} ${s.expected}`.matchAll(/"([^"]+)"/g))
      assert.ok(scanned.has(m[1]) || testData.has(m[1]), `${c.title}: invented text "${m[1]}" in "${s.action}" / "${s.expected}"`);
});

test("validation cases test one empty field at a time, fill the others and check Network for no request", () => {
  const validation = cases.filter((c) => c.category === "FORM_VALIDATION");
  assert.ok(validation.length >= 6, `${validation.length} validation cases`);
  for (const c of validation) {
    const empty = c.steps.filter((s) => /^Leave "[^"]+" empty$/.test(s.action));
    assert.equal(empty.length, 1, `${c.title}: exactly one field left empty`);
    const left = empty[0].action.match(/"([^"]+)"/)![1];
    assert.ok(c.title.includes(`"${left}"`), c.title);
    assert.ok(c.steps.some((s) => s.action === "Open DevTools > Network and clear the log"), c.title);
    assert.ok(c.steps.some((s) => /No request was sent/.test(s.expected)), c.title);
    assert.ok(c.steps.some((s) => new RegExp(`flags the "${left}" field`).test(s.expected)), c.title);
  }
  const name = find(/^Contact form is not sent while "Name" is empty$/);
  assert.deepEqual(name.steps.filter((s) => /^(Type|Choose)/.test(s.action)).map((s) => s.action),
    ['Type "jane.doe@example.com" into "Email"', 'Type "Hello, I would like to know when my order will arrive." into "Message"', 'Choose "Orders" in the "Topic" dropdown']);
  assert.match(name.preconditions, /Safe on the live site/);
  // A field the page does not mark required is an assumption, and pressing submit may really send it.
  const message = find(/^Contact form is not sent while "Message" is empty$/);
  assert.match(message.preconditions, /Assumption: Message is mandatory/);
  assert.match(message.preconditions, /Use a test environment, or do not press "Send message" on the live site/i);
  // Invalid email: everything else valid, two malformed values, Network check.
  const email = find(/^Contact form rejects an email address without @$/);
  assert.ok(email.steps.some((s) => s.data === "not-an-email") && email.steps.some((s) => s.data === "jane@"));
  assert.ok(email.steps.some((s) => s.action === 'Type "Jane Doe" into "Name"'));
});

test("cases that send real data warn about the live site, naming the real button", () => {
  for (const re of [/^Contact form can be sent/, /^New visitor can create an account/, /"Name" field handles a 256-character value/])
    assert.match(find(re).preconditions, /Use a test environment, or do not press "(Send message|Sign up)" on the live site/i, String(re));
  assert.ok(find(/^Contact form can be sent/).steps.some((s) => s.action === 'Click "Send message"'));
});

test("sign-up uses a new unique plus-address email, and re-uses it to check duplicates are refused", () => {
  const signup = find(/^New visitor can create an account on the Sign-up page/);
  const emails = signup.steps.filter((s) => /qa\+<timestamp>@example\.com/.test(s.data));
  assert.equal(emails.length, 2);
  assert.match(emails[0].data, /a new unique address/);
  assert.match(emails[0].action, /^Type a new unique email address into "Email Address"$/);
  assert.match(signup.steps.at(-1)!.expected, /already registered/);
  const code = script(signup);
  assert.ok(isAutomatable(code), code);
  assert.match(code, /const uniqueEmail = `qa\+\$\{Date\.now\(\)\}@example\.com`;/);
  assert.equal(code.match(/\.fill\(uniqueEmail\)/g)?.length, 2, "both sign-ups use the same unique address");
  assert.match(code, /clearCookies\(\)/);
});

test("sign-in cases need the test account and never contain credentials", () => {
  const signin = find(/^Registered user can sign in/);
  assert.match(signin.preconditions, /A test account .* exists on this environment/);
  assert.match(find(/is refused for a wrong password/).preconditions, /lock the test account/);
  const code = script(signin);
  assert.ok(isAutomatable(code));
  assert.match(code, /fill\(process\.env\.TEST_USERNAME \?\? ""\)/);
  assert.match(code, /fill\(process\.env\.TEST_PASSWORD \?\? ""\)/);
});

test("every generated case still gets an automatable script that navigates relative to baseURL", () => {
  const scripted = cases.filter((c) => isAutomatable(script(c)));
  assert.equal(scripted.length, cases.length, cases.filter((c) => !isAutomatable(script(c))).map((c) => c.title).join(", "));
  for (const c of cases) {
    const code = script(c);
    assert.doesNotMatch(code, /page\.goto\("http/, c.title);
    assert.doesNotMatch(code, /TODO: automate/, c.title);
  }
  const load = script(find(/^Contact page loads/));
  assert.match(load, /page\.goto\("\/contact"\)/);
  assert.match(load, /toHaveTitle\("Contact – Shop"\)/);
  assert.match(load, /toHaveURL\(\(u\) => .* === "\/contact"\)/);
  assert.match(load, /page\.reload\(\);\n\s+expect\(res\?\.status\(\), .*\)\.toBe\(200\)/, "DevTools > Network reload checks the status");
  assert.match(load, /page\.on\("pageerror"/, "DevTools > Console reload checks for script errors");
  assert.match(load, /link\.hover\(\);\n\s+expect\(new URL\(.*\)\.pathname, .*\)\.toBe\("\/"\)/, "hover step checks the link target");
  const heading = script(find(/^Contact page main heading/));
  assert.match(heading, /setViewportSize\(\{ width: 375, height: 667 \}\)/);
  assert.match(heading, /toHaveCount\(1\)/, "exactly one h1");
  assert.match(heading, /exact: true/);
  const blank = script(find(/^Contact form is not sent while "Name" is empty$/));
  assert.match(blank, /const requests: string\[\] = \[\];/);
  assert.match(blank, /expect\(requests, .*\)\.toEqual\(\[\]\)/);
  assert.match(blank, /input:invalid/);
  assert.match(blank, /getByRole\("button", \{ name: "Send message" \}\)/);
});

test("translator: the page load itself is not counted as a request sent by the form", () => {
  const code = heuristicScript({ key: "TC-1", title: "x", expectedResult: "" }, [
    { action: "Open http://localhost:4100/login in a new tab", expected: "The page loads" },
    { action: "Leave \"Email\" empty", expected: "The field stays empty" },
    { action: "Click \"Sign in\"", expected: "No request was sent to the site" },
  ]);
  assert.match(code, /page\.goto\("\/login"\);?\n\s+requests\.length = 0;/);
  // "Click Sign in" must hit the form's button, not a "Sign in" link in the navigation.
  assert.match(code, /await \(await page\.getByRole\("button", \{ name: "Sign in" \}\).*\.count\(\) \? .* : page\.getByRole\("link"/);
});

test("translator: absolute URLs become baseURL paths; manual-only DevTools steps are skipped, not TODOs", () => {
  const code = heuristicScript({ key: "TC-1", title: "x", expectedResult: "" }, [
    { action: "Open https://staging.example.com/blog?page=2 in a new tab" },
    { action: "Open DevTools > Elements and inspect the header", expected: "The header is a <header> element" },
    { action: 'Hover over "Blog" in the navigation (do not click)', expected: "The browser status bar shows the link target https://staging.example.com/blog" },
    { action: "Zoom the page to 200%" },
    { action: "Close the private window to end the session" },
  ]);
  assert.ok(isAutomatable(code), code);
  assert.match(code, /page\.goto\("\/blog\?page=2"\)/);
  assert.match(code, /Manual-only step \(browser developer tools\)/);
  assert.match(code, /pathname, .*\)\.toBe\("\/blog"\)/);
  assert.match(code, /setViewportSize\(\{ width: 683, height: 384 \}\)/);
  // A verification nobody can automate still fails loudly rather than passing silently.
  assert.ok(!isAutomatable(heuristicScript({ key: "TC-2", title: "y", expectedResult: "" }, [{ action: "Verify the vibe is immaculate" }])));
});

test("rule-based cases are stored as RULE_BASED, AI cases as AI", () => {
  assert.deepEqual(caseOrigin("heuristic"), { source: "RULE_BASED", aiGenerated: false });
  assert.deepEqual(caseOrigin("claude"), { source: "AI", aiGenerated: true });
});
