import type { Script, TestCase } from "@prisma/client";
import { z } from "zod/v4";
import { prisma } from "../db.js";
import { parse } from "../lib/json.js";
import { checkSpec } from "../lib/spec-guard.js";
import { aiJSON } from "./ai.js";
import { isPlaywrightTestSpec, normaliseSpec } from "./playwright-project.js";

// Scripts are standard Playwright Test specs (see services/playwright-project.ts). They never
// contain credentials: logins read process.env.TEST_USERNAME / TEST_PASSWORD at run time.
export const SPEC_CONTRACT = `Standard Playwright Test spec (TypeScript):
  import { test, expect } from "../fixtures";   // re-exports @playwright/test with platform fixtures
  test("<KEY>: <title>", async ({ page }) => {
    await test.step("<manual step text>", async () => { ... });
  });
  - baseURL is configured: navigate with page.goto("/path")
  - credentials: process.env.TEST_USERNAME ?? "" and process.env.TEST_PASSWORD ?? ""`;

const Schema = z.object({ code: z.string().describe("Complete TypeScript spec file source") });

/** The page structure passed to the AI script writer: the first pages of a scan, trimmed. */
export const pageStructureHint = (pages: { url: string; title: string; forms: unknown; buttons: string[] }[] | undefined) =>
  pages?.slice(0, 6).map((p) => ({ url: p.url, title: p.title, forms: p.forms, buttons: p.buttons.slice(0, 15) }));

/** Writes a spec for the case without saving it: AI when configured and its output passes the safety check, otherwise rule-based. */
export async function writeScriptCode(tc: TestCase, discoveryHint?: unknown) {
  const steps = parse<{ action: string; expected?: string }[]>(tc.steps, []);
  const ai = await aiJSON({
    schema: Schema,
    task:
      "Convert this approved manual test case into a Playwright Test spec file.\n" +
      `Follow this contract exactly:\n${SPEC_CONTRACT}\n` +
      "Write exactly one test() named \"<KEY>: <title>\". Wrap each manual step in `await test.step(\"<step text>\", async () => { ... })`. " +
      "Prefer accessible locators (getByRole, getByLabel, getByText) and web-first assertions (await expect(locator).toBeVisible()). " +
      "Never hard-code credentials or perform real payments or destructive actions; if a step would, assert the control is present instead. " +
      "Start the file with a one-line comment naming the test case key.",
    input: { testCase: { key: tc.key, title: tc.title, preconditions: tc.preconditions, steps, expectedResult: tc.expectedResult }, pageStructure: discoveryHint ?? null },
  });
  // AI output is checked like a hand-edited script; anything rejected falls back to the rule-based spec.
  const useAi = ai?.code && checkSpec(normaliseSpec(ai.code)).ok;
  return { code: useAi ? ai!.code : heuristicScript(tc, steps), byAi: Boolean(useAi) };
}

/**
 * True when a written script can run on its own: it passes the safety check and has no step the generator
 * could not translate (those become "TODO: automate" errors that would always fail).
 */
export const isAutomatable = (code: string) => !/TODO: automate/.test(code) && checkSpec(normaliseSpec(code)).ok;

export async function saveScript(tc: TestCase, code: string, createdBy: string) {
  const last = await prisma.script.findFirst({ where: { testCaseId: tc.id }, orderBy: { version: "desc" } });
  return prisma.script.create({
    data: {
      testCaseId: tc.id, testCaseVersion: tc.version, version: (last?.version ?? 0) + 1, language: "playwright-test", code, createdBy,
    },
  });
}

export async function generateScript(tc: TestCase, userName: string, discoveryHint?: unknown) {
  const { code, byAi } = await writeScriptCode(tc, discoveryHint);
  return saveScript(tc, code, byAi ? `AI (Claude) for ${userName}` : `Rule-based generator for ${userName}`);
}

const q = (s: string) => JSON.stringify(s);
/** Single-line text for a // comment: line breaks (incl. U+2028/2029) would otherwise end the comment. */
const oneLine = (s: string) => s.replace(/[\r\n\u2028\u2029]+/g, " ");

/** Marker in rule-based scripts; older rule-based scripts without it are regenerated with the current rules. */
export const RULES_MARK = "rule-based generator v3";

/** The desktop window the preconditions ask for; zoom steps resize relative to it. */
const DESKTOP = { width: 1366, height: 768 };

/** Helpers a spec only gets when one of its steps needs them. */
type Needs = { field: boolean; requests: boolean; uniqueEmail: boolean };

const HELPERS: Record<keyof Needs, string[]> = {
  requests: [
    "// Requests the page sends to its own site (form posts and page loads): the automated view of DevTools > Network.",
    "const requests: string[] = [];",
    'page.on("request", (r) => { if ((r.method() !== "GET" || r.isNavigationRequest()) && new URL(r.url()).origin === new URL(page.url()).origin) requests.push(`${r.method()} ${r.url()}`); });',
  ],
  uniqueEmail: [
    "// A new address on every run, so signing up never collides with an earlier test account.",
    "const uniqueEmail = `qa+${Date.now()}@example.com`;",
  ],
  field: [
    "// A form field by its label (exact first), or by its placeholder when the field has no label.",
    "const field = async (name: string) => {",
    "  const ways = [page.getByLabel(name, { exact: true }), page.getByLabel(name), page.getByPlaceholder(name, { exact: true }), page.getByPlaceholder(name)];",
    "  await ways[1].or(ways[3]).first().waitFor();",
    "  for (const w of ways) if (await w.count()) return w.first();",
    "  return ways[1].first();",
    "};",
  ],
};

/** Best-effort translation of plain-English steps. Unrecognised steps become explicit TODOs that fail loudly. */
export function heuristicScript(tc: Pick<TestCase, "key" | "title" | "expectedResult">, steps: { action: string; data?: string; expected?: string }[]) {
  const needs: Needs = { field: false, requests: false, uniqueEmail: false };
  const body: string[] = [];
  let navigated = false;
  for (const s of steps) {
    const code = translate(s.action, s.expected, s.data, needs);
    if (!navigated && !code.some((l) => l.includes("page.goto"))) body.push(`  await page.goto("/");`);
    navigated = true;
    body.push(`  await test.step(${q(s.action)}, async () => {`, ...code.map((l) => `    ${l}`), "  });");
  }
  if (!steps.length) body.push('  await page.goto("/");');
  // The overall expected result is checked with the same rules as a step; unrecognised wording only checks
  // quoted text (the individual steps carry the specific checks).
  const spec = expectations(tc.expectedResult ?? "", q(oneLine(tc.expectedResult?.trim() || "Expected result")), needs);
  const final = [...spec.lines, ...(checks(tc.expectedResult ?? "") ?? []),
    ...(spec.matched ? [] : quoted(tc.expectedResult).map((t) => `await expect(page.getByText(${q(t)}).first(), ${q(`Expected to see "${t}"`)}).toBeVisible();`))];
  body.push(`  await test.step("Verify expected result", async () => {`, ...(final.length ? final : ['await expect(page.locator("body")).toBeVisible();']).map((l) => `    ${l}`), "  });", "});");
  // Pages the test opens itself are not "requests sent by the form": start the log afresh after each one.
  if (needs.requests) {
    for (let i = body.length - 1; i >= 0; i--) {
      if (body[i].includes("page.goto(")) body.splice(i + 1, 0, `${body[i].match(/^\s*/)![0]}requests.length = 0; // ignore the page load itself`);
    }
  }
  const helpers = (Object.keys(HELPERS) as (keyof Needs)[]).filter((k) => needs[k]).flatMap((k) => HELPERS[k].map((l) => `  ${l}`));
  return [
    `// ${oneLine(`${tc.key}: ${tc.title}`)}`,
    `// Generated by the ${RULES_MARK} (AI not configured). Review before relying on it.`,
    'import { test, expect } from "../fixtures";',
    "",
    `test(${q(`${tc.key}: ${tc.title}`)}, async ({ page }) => {`,
    ...helpers,
    ...body,
  ].join("\n") + "\n";
}

function quoted(text = "") {
  return [...text.matchAll(/["“']([^"”']{1,300})["”']/g)].map((m) => m[1]).filter((s) => s.trim().length > 1);
}
/** Only double-quoted strings: used where an apostrophe ("don't") must not start a quote. */
const dquoted = (text = "") => [...text.matchAll(/["“]([^"”]{1,300})["”]/g)].map((m) => m[1]).filter((s) => s.trim().length > 0);

// Locators shared by the checks below. ERROR_UI covers common inline error and validation markup.
const ERROR_UI = `page.locator('[role="alert"], .error, .errors, .alert-danger, .invalid-feedback, .field-error, [aria-invalid="true"]')`;
const ERROR_TEXT = String.raw`/invalid|incorrect|wrong|not recogni[sz]ed|failed|already (registered|exists|in use|taken)/i`;
const SUCCESS_TEXT = String.raw`/\b(thank you|thanks for|successfully|message sent|has been (sent|submitted|received|saved))\b/i`;
const INVALID_FIELD = `page.locator("input:invalid, textarea:invalid, select:invalid")`;
const visible = (loc: string) => `${loc}.filter({ visible: true }).first()`;
/** A control by name, preferring the first role (e.g. the form's "Sign in" button over a "Sign in" link in the nav). */
const preferred = (name: string, [first, second]: string[]) => {
  const a = visible(`page.getByRole("${first}", { name: ${q(name)} })`);
  return `(await ${a}.count() ? ${a} : ${visible(`page.getByRole("${second}", { name: ${q(name)} })`)})`;
};

/**
 * Assertions for a verification sentence the generator (or a tester) writes in plain English, or null when the
 * wording isn't recognised. Each assertion carries the expected behaviour as its message, so a failure reads as
 * "what should have happened" rather than a raw locator error.
 */
function checks(text: string, expected?: string): string[] | null {
  const t = text.toLowerCase();
  const msg = q(oneLine(expected?.trim() || text.trim()));
  if (/\bnot (be )?(accepted|submitted)\b|validation message|stays on the form|nothing is submitted/.test(t)) return [
    "// Rejected means: still on the form, or an error is shown, and never a success message.",
    `await expect(page.locator("form").or(${ERROR_UI}).first(), ${msg}).toBeVisible();`,
    `await expect(page.getByText(${SUCCESS_TEXT}), ${msg}).toHaveCount(0);`,
  ];
  if (/error message|invalid credentials/.test(t)) return [
    `await expect(${ERROR_UI}.or(page.getByText(${ERROR_TEXT})).first(), ${msg}).toBeVisible();`,
  ];
  if (/\b(signed|logged) in\b/.test(t) && !/\bnot (signed|logged) in\b/.test(t)) return [
    `await expect(page.locator('input[type="password"]:visible'), ${msg}).toHaveCount(0);`,
    `await expect(${ERROR_UI}, ${msg}).toHaveCount(0);`,
  ];
  if (/confirmation|success message|\bsucceeds\b|thank/.test(t)) return [
    `await expect(page.getByText(${SUCCESS_TEXT}).first(), ${msg}).toBeVisible();`,
    `await expect(${ERROR_UI}, ${msg}).toHaveCount(0);`,
  ];
  if (/\bfocus\b/.test(t)) return [`await expect(page.locator(":focus"), ${msg}).toBeVisible();`];
  if (/alt text|accessible name/.test(t)) return [
    `await expect(page.locator("img:not([alt])"), ${msg}).toHaveCount(0);`,
    `const unlabelled = await page.locator("input:not([type=hidden]), select, textarea").evaluateAll((els) => els.filter((e) => !(e as HTMLInputElement).labels?.length && !e.getAttribute("aria-label") && !e.getAttribute("aria-labelledby")).length);`,
    `expect(unlabelled, ${msg}).toBe(0);`,
  ];
  if (/\bno (server )?errors?\b|server error/.test(t)) return [
    `await expect(page.getByText(/internal server error|unexpected error|stack trace|exception/i), ${msg}).toHaveCount(0);`,
  ];
  return null;
}

/** Path (and query) of an absolute URL: scripts navigate relative to the run's baseURL, so a case written against one environment runs on another. */
function relative(url: string) {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}
const URL_IN_TEXT = /https?:\/\/[^\s"”,;)]+/;
const cleanUrl = (u: string) => u.replace(/[.:]+$/, "");
const pathOf = (url: string) => {
  try {
    return new URL(cleanUrl(url)).pathname;
  } catch {
    return url;
  }
};
/** Compares paths ignoring a trailing slash, so /about and /about/ are the same page. */
const urlCheck = (url: string, msg: string) =>
  `await expect(page, ${msg}).toHaveURL((u) => u.pathname.replace(/(.)\\/$/, "$1") === ${q(pathOf(url).replace(/(.)\/$/, "$1"))});`;

/**
 * Assertions for the specific expected-result phrases the generator writes (and a tester would): page address,
 * tab title, headings, navigation links, form fields, native validation, DevTools Network, layout. `matched` says
 * whether any phrase was recognised, in which case quoted text is not also looked for as page text.
 */
function expectations(expected = "", msg: string, needs: Needs): { lines: string[]; matched: boolean } {
  const e = expected;
  const out: string[] = [];
  let matched = false;
  const hit = (...lines: string[]) => { matched = true; out.push(...lines); };
  const quotedList = (m: RegExpMatchArray | null) => dquoted(m?.[1] ?? "");

  for (const m of e.matchAll(new RegExp(String.raw`\b(?:loading at|goes to|is still|navigates to|opens at|lands on)\s+(${URL_IN_TEXT.source})`, "gi"))) hit(urlCheck(m[1], msg));
  const title = e.match(/\btab title(?: reads exactly| reads| is| shows)? ["“]([^"”]+)["”]/i);
  if (title) hit(`await expect(page, ${msg}).toHaveTitle(${q(title[1])});`);
  const exact = /\bis exactly\b|\breads exactly\b/i.test(e);
  const headings = [...e.matchAll(/\bheading(?: \(h1\))?(?: reads(?: exactly)?| text is exactly)? ["“]([^"”]+)["”]/gi)].map((m) => m[1]);
  const textIs = e.match(/\btext is exactly ["“]([^"”]+)["”]/i);
  if (textIs) headings.push(textIs[1]);
  headings.push(...quotedList(e.match(/\bsections? ((?:["“][^"”]+["”](?:,\s*|\s+and\s+)?)+)/i)));
  for (const [i, h] of [...new Set(headings)].entries()) {
    // Scanned headings are cut at 80 characters, so only a shorter one can be compared exactly.
    const loc = visible(`page.getByRole("heading", { name: ${q(h)}${exact && h.length < 80 ? ", exact: true" : ""} })`);
    hit(`await expect(${loc}, ${msg}).toBeVisible();`, ...(i === 0 && /without scrolling|above the fold/i.test(e) ? [`await expect(${loc}, ${msg}).toBeInViewport();`] : []));
  }
  for (const link of quotedList(e.match(/\bnavigation shows the links? ((?:["“][^"”]+["”](?:,\s*|\s+and\s+)?)+)/i)))
    hit(`await expect(${visible(`page.getByRole("link", { name: ${q(link)} })`)}, ${msg}).toBeVisible();`);
  const fields = e.match(/\bform shows the fields? ([^;]+)/i);
  if (fields) {
    needs.field = true;
    for (const f of dquoted(fields[1].replace(/\(placeholder ["“][^"”]*["”]\)/g, ""))) hit(`await expect(await field(${q(f)}), ${msg}).toBeVisible();`);
  }
  for (const m of e.matchAll(/\bthe ["“]([^"”]+)["”] button is shown/gi)) hit(`await expect(${visible(`page.getByRole("button", { name: ${q(m[1])} })`)}, ${msg}).toBeVisible();`);
  const one = e.match(/\bexactly one h1\b[^"“]*(?:["“]([^"”]+)["”])?/i);
  if (one) hit(`await expect(page.locator("h1"), ${msg}).toHaveCount(1);`, ...(one[1] ? [`await expect(page.locator("h1"), ${msg}).toContainText(${q(one[1])});`] : []));
  if (/\bno broken.image/i.test(e)) hit(
    `const broken = await page.locator("img").evaluateAll((imgs) => imgs.filter((i) => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth === 0).length);`,
    `expect(broken, ${msg}).toBe(0);`,
  );
  if (/\bno horizontal scroll/i.test(e)) hit(`expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), ${msg}).toBe(true);`);
  // The browser's own validation leaves the field :invalid; script-based validation shows an error instead.
  const flagged = e.match(/\bflags the ["“]([^"”]+)["”] field\b/i);
  if (flagged) hit(
    `await expect(${INVALID_FIELD}.or(${ERROR_UI}).first(), ${msg}).toBeVisible();`,
    `await expect(page.getByText(${SUCCESS_TEXT}), ${msg}).toHaveCount(0);`,
  );
  if (/\bno request\b/i.test(e)) {
    needs.requests = true;
    hit(`expect(requests, ${msg}).toEqual([]);`);
  } else if (/\ba request\b[^.]*\bwas sent\b/i.test(e)) {
    needs.requests = true;
    hit(`expect(requests.length, ${msg}).toBeGreaterThan(0);`);
  }
  const kept = e.match(/["“]([^"”]+)["”] keeps all (\d+) characters\b/i);
  if (kept) {
    needs.field = true;
    hit(`const kept = (await (await field(${q(kept[1])})).inputValue()).length;`, `expect(kept, ${msg}).toBeGreaterThan(0);`, `expect(kept, ${msg}).toBeLessThanOrEqual(${Number(kept[2])});`);
  }
  if (/\bform is (?:replaced|no longer shown)\b/i.test(e)) hit(
    `await expect(page.locator('input[type="password"]:visible'), ${msg}).toHaveCount(0);`,
    `await expect(${ERROR_UI}, ${msg}).toHaveCount(0);`,
  );
  if (/\brefused\b[^.]*\berror message\b/i.test(e)) hit(`await expect(${ERROR_UI}.or(page.getByText(${ERROR_TEXT})).first(), ${msg}).toBeVisible();`);
  return { lines: out, matched };
}

function fieldName(a: string, strs: string[]) {
  return a.match(/\b(?:in|into)\s+(?:the\s+)?["“']([^"”']+)["”']/i)?.[1]
    ?? a.match(/\b(?:in|into)\s+(?:the\s+)?([\w\s-]+?)\s*(?:field|input|box)?$/i)?.[1]
    ?? (strs.length > 1 ? strs.at(-1) : undefined);
}

/** Test data written as "256 × the letter A" (optionally followed by the value) is typed as that many characters. */
function typedValue(data = "") {
  const rep = data.match(/^(\d{1,5})\s*[×x]\s*(?:the letter\s+)?(\S)/i);
  return rep ? q(rep[2].repeat(Number(rep[1]))) : q(data.trim() || "test");
}

function translate(action: string, expected: string | undefined, data: string | undefined, needs: Needs): string[] {
  const a = action.trim();
  const out: string[] = [];
  const strs = quoted(a);
  const url = a.match(/(https?:\/\/\S+|\s(\/[\w\-./?=&]*))/);
  const msg = q(oneLine(expected?.trim() || a));
  const spec = expectations(expected, msg, needs);
  const manual = (why: string) => out.push(`// Manual-only step (${why}); the checks below cover what it verifies.`);
  const locate = (name: string) => {
    needs.field = true;
    return `(await field(${q(name)}))`;
  };
  if (/^open devtools\b/i.test(a)) {
    // DevTools itself can't be automated; each use is mapped to what it lets the tester observe.
    if (/\bnetwork\b/i.test(a) && /\breload\b/i.test(a)) {
      const status = expected?.match(/\bHTTP status (\d{3})\b/i)?.[1];
      out.push("const res = await page.reload();", status ? `expect(res?.status(), ${msg}).toBe(${Number(status)});` : `expect(res?.status() ?? 200, ${msg}).toBeLessThan(400);`);
    } else if (/\bnetwork\b/i.test(a)) {
      needs.requests = true;
      out.push("requests.length = 0; // start a clean log, like clearing DevTools > Network");
    } else if (/\bconsole\b/i.test(a) && /\breload\b/i.test(a)) {
      out.push(
        "// Uncaught script errors while the page loads (failed file requests such as a missing favicon are not counted).",
        "const errors: string[] = [];",
        'page.on("pageerror", (err) => errors.push(err.message));',
        "await page.reload();",
        `expect(errors, ${msg}).toEqual([]);`,
      );
    } else manual("browser developer tools");
  } else if (/^hover\b/i.test(a) && strs.length) {
    out.push(`const link = ${visible(`page.getByRole("link", { name: ${q(strs[0])} }).or(page.getByRole("button", { name: ${q(strs[0])} }))`)};`, "await link.hover();");
    const target = expected?.match(new RegExp(String.raw`status bar shows (?:the link target )?(${URL_IN_TEXT.source})`, "i"))?.[1];
    if (target) out.push(`expect(new URL(await link.evaluate((el) => (el as HTMLAnchorElement).href)).pathname, ${msg}).toBe(${q(pathOf(target))});`);
  } else if (/\bzoom\b/i.test(a) && /(\d{2,3})\s*%/.test(a)) {
    // Browser zoom lays the page out like a proportionally smaller window, which is what is set here.
    const pct = Number(a.match(/(\d{2,3})\s*%/)![1]) || 100;
    out.push(`await page.setViewportSize({ width: ${Math.round((DESKTOP.width * 100) / pct)}, height: ${Math.round((DESKTOP.height * 100) / pct)} }); // ${pct}% zoom`);
  } else if (/(\d{3,4})\s*[×x]\s*(\d{3,4})/.test(a) && /\b(phone|screen|window|device toolbar|viewport)\b/i.test(a)) {
    const [, w, h] = a.match(/(\d{3,4})\s*[×x]\s*(\d{3,4})/)!;
    out.push(`await page.setViewportSize({ width: ${Number(w)}, height: ${Number(h)} });`, ...(/\breload\b/i.test(a) ? ["await page.reload();"] : []));
  } else if (/\bclear site data\b|\bclear (?:the |this site'?s? )?cookies\b/i.test(a)) {
    out.push("await page.context().clearCookies(); // signs the browser out of the site");
  } else if (/^reload\b/i.test(a)) {
    out.push("await page.reload();");
  } else if (/^scroll\b/i.test(a)) {
    out.push("await page.mouse.wheel(0, 20000);", "await page.waitForTimeout(300); // let lazy content appear");
  } else if (/^(close\b.*\bwindow\b|sign out\b)/i.test(a)) {
    manual("the automated browser is closed when the test ends");
  } else if (/^(open|navigate|go to|visit|load)\b/i.test(a)) {
    const target = url?.[1]?.startsWith("http") ? q(relative(cleanUrl(url[1]).replace(/,$/, ""))) : url?.[2] ? q(url[2].trim()) : '"/"';
    out.push(`const res = await page.goto(${target});`, `expect(res?.status() ?? 200, ${msg}).toBeLessThan(400);`);
  } else if (/\bleave\b.*\bempty\b|^clear\b/i.test(a)) {
    const name = strs[0] ?? fieldName(a, strs);
    out.push(name ? `await ${locate(name)}.fill("");` : `throw new Error(${q(`TODO: automate step — field not identified: ${a}`)});`);
  } else if (/\bdropdown\b|\bselect list\b/i.test(a)) {
    const name = fieldName(a, strs) ?? strs.at(-1);
    const option = strs.find((s) => s !== name);
    out.push(name ? `await ${locate(name)}.selectOption(${option ? `{ label: ${q(option)} }` : "{ index: 1 }"});` : `throw new Error(${q(`TODO: automate step — list not identified: ${a}`)});`);
  } else if (/\b(tick|check)\b.*\bcheckbox\b|\bradio button\b/i.test(a) && strs.length) {
    out.push(`await ${locate(strs[0])}.check();`);
  } else if (/\b(enter|type|fill|input|paste)\b/i.test(a)) {
    const isPwd = /password/i.test(a);
    const name = fieldName(a, strs) ?? (isPwd ? "Password" : /email/i.test(a) ? "Email" : null);
    const value = /test account password/i.test(a) || (isPwd && /\bvalid\b/i.test(a)) ? 'process.env.TEST_PASSWORD ?? ""'
      : /valid (user(name)?|email)|test account (email|username|user name|login)/i.test(a) ? 'process.env.TEST_USERNAME ?? ""'
      : /<timestamp>/.test(`${a} ${data ?? ""}`) ? "uniqueEmail"
      : strs.find((s) => s !== name) !== undefined ? q(strs.find((s) => s !== name)!) : typedValue(data);
    if (value === "uniqueEmail") needs.uniqueEmail = true;
    out.push(name ? `await ${locate(name)}.fill(${value});` : `throw new Error(${q(`TODO: automate step — field not identified: ${a}`)});`);
  } else if (/\bpress\b.*\b(tab|enter|escape|esc)\b/i.test(a)) {
    const key = /\bshift\s*\+\s*tab\b/i.test(a) ? "Shift+Tab" : /\btab\b/i.test(a) ? "Tab" : /\benter\b/i.test(a) ? "Enter" : "Escape";
    // Repeated presses stop at the page's last control, so focus never leaves the page on a short page.
    out.push(/repeatedly|several|multiple|through/i.test(a)
      ? `for (let i = 0; i < 5; i++) { await page.keyboard.press(${q(key)}); if (!(await page.locator(":focus").count())) { await page.keyboard.press(${q(key === "Tab" ? "Shift+Tab" : key)}); break; } }`
      : `await page.keyboard.press(${q(key)});`);
  } else if (/\b(click|press|tap|select|submit)\b/i.test(a)) {
    const name = strs[0] ?? a.match(/(?:click|press|tap|select)\s+(?:on\s+)?(?:the\s+)?([\w\s-]+?)(?:\s+(?:button|link|tab))?$/i)?.[1];
    const target = /submit/i.test(a) && !name ? `page.locator("form [type=submit], form button").first()`
      : name ? preferred(name, /\blink\b/i.test(a) ? ["link", "button"] : ["button", "link"]) : null;
    if (!target) out.push(`throw new Error(${q(`TODO: automate step — control not identified: ${a}`)});`);
    else out.push(
      // A submit or link may navigate: wait for that page to load before the next check (or give up after 3 s
      // when nothing navigates, e.g. the browser's own validation blocked the submit).
      `const navigated = page.waitForEvent("framenavigated", { predicate: (f) => f === page.mainFrame(), timeout: 3000 }).catch(() => null);`,
      `await ${target}.click();`,
      "if (await navigated) await page.waitForLoadState();",
    );
  } else if (/\b(verify|check|confirm|see|should|displayed|visible|appears|look|read)\b/i.test(a)) {
    if (/\btitle\b/i.test(a) && strs.length) out.push(`await expect(page, ${msg}).toHaveTitle(new RegExp(${q(strs[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))}));`);
    else if (strs.length) for (const s of strs) out.push(`await expect(page.getByText(${q(s)}).first(), ${msg}).toBeVisible();`);
    else {
      const own = checks(a, expected);
      if (own) out.push(...own);
      else if (!spec.matched) out.push(...(checks(expected ?? "", expected) ?? [`throw new Error(${q(`TODO: automate check — wording not recognised: ${a}`)});`]));
    }
  } else {
    out.push(`throw new Error(${q(`TODO: automate step manually: ${a}`)});`);
  }
  out.push(...spec.lines);
  if (!spec.matched) for (const s of quoted(expected)) out.push(`await expect(page.getByText(${q(s)}).first(), ${msg}).toBeVisible();`);
  return out;
}

/**
 * Latest script for a case, ready to write to disk. Stale, legacy or machine-written scripts that fail the safety check are
 * regenerated; a hand-edited script that fails is returned with the reason so the caller can reject just that case.
 */
export async function scriptForRun(tc: TestCase, userName: string): Promise<{ script: Script; code: string; problem: string | null }> {
  let script = await prisma.script.findFirst({ where: { testCaseId: tc.id }, orderBy: { version: "desc" } });
  const stale = !script || script.testCaseVersion !== tc.version || !isPlaywrightTestSpec(script.code);
  // Machine-written scripts are regenerated when they fail the check, and rule-based ones when the rules have improved.
  const outdatedRules = !script?.createdById && script?.createdBy?.startsWith("Rule-based") && !script.code.includes(RULES_MARK);
  if (stale || outdatedRules || (!script!.createdById && !checkSpec(normaliseSpec(script!.code)).ok)) script = await generateScript(tc, userName);
  const code = normaliseSpec(script!.code);
  const check = checkSpec(code);
  return { script: script!, code, problem: check.ok ? null : check.error };
}
