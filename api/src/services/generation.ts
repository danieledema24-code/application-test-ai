import { z } from "zod/v4";
import { aiJSON } from "./ai.js";
import type { DiscoveredPage } from "./discovery.js";

export const CATEGORIES = ["FUNCTIONAL", "POSITIVE", "NEGATIVE", "BOUNDARY", "REGRESSION", "UI", "FORM_VALIDATION", "AUTHENTICATION", "ACCESSIBILITY", "API"] as const;
export const PRIORITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;

const CaseSchema = z.object({
  title: z.string().describe("Short, specific outcome being verified, e.g. \"Contact form rejects an invalid email address\""),
  description: z.string().describe("Objective: one or two plain sentences on what is verified and why it matters"),
  preconditions: z.string().describe("One condition per line, starting with \"• \", e.g. the start page, user state and data that must exist"),
  steps: z.array(z.object({
    action: z.string().describe("One concrete action in the imperative, with exact paths and quoted UI labels"),
    data: z.string().describe("Exact test data typed or selected in this step, or empty string when none"),
    expected: z.string().describe("What the tester should observe immediately after this action"),
  })),
  expectedResult: z.string().describe("The overall pass criterion for the whole case"),
  category: z.enum(CATEGORIES),
  priority: z.enum(PRIORITIES),
});
export type GeneratedCase = z.infer<typeof CaseSchema>;
const ResultSchema = z.object({ cases: z.array(CaseSchema), notes: z.string().describe("Assumptions made and gaps you could not cover") });

export type GenerationSource = "DISCOVERY" | "USER_STORY" | "REQUIREMENTS" | "DESCRIPTION" | "OPENAPI";

/**
 * How a generated case is stored: AI-written cases are labelled "AI" and get the AI-draft badge; rule-based ones
 * are labelled "RULE_BASED", so editing them later (which moves them back to draft) never shows them as AI drafts.
 */
export const caseOrigin = (generatedBy: "claude" | "heuristic") =>
  generatedBy === "claude" ? { source: "AI", aiGenerated: true } : { source: "RULE_BASED", aiGenerated: false };

export async function generateCases(opts: {
  source: GenerationSource; text?: string; pages?: DiscoveredPage[]; workflows?: unknown; categories?: string[]; count?: number; applicationUrl: string;
}): Promise<{ cases: GeneratedCase[]; generatedBy: "claude" | "heuristic"; notes: string }> {
  const count = Math.min(Math.max(opts.count ?? 12, 1), 40);
  const categories = opts.categories?.length ? opts.categories : ["FUNCTIONAL", "POSITIVE", "NEGATIVE", "FORM_VALIDATION", "BOUNDARY", "UI", "AUTHENTICATION", "ACCESSIBILITY"];
  const input =
    opts.source === "DISCOVERY"
      ? { applicationUrl: opts.applicationUrl, pages: (opts.pages ?? []).map((p) => ({ url: p.url, title: p.title, headings: p.headings, nav: p.navItems, buttons: p.buttons.slice(0, 20), forms: p.forms })), workflows: opts.workflows }
      : { applicationUrl: opts.applicationUrl, [opts.source.toLowerCase()]: opts.text };
  const ai = await aiJSON({
    schema: ResultSchema,
    task:
      `Write up to ${count} manual test cases for the application, from the ${opts.source.toLowerCase().replace("_", " ")} below. ` +
      `Use only these categories: ${categories.join(", ")}. Mix positive, negative and boundary scenarios where relevant. ` +
      "Write every case so a new tester can follow it without knowing the application: " +
      "a clear objective; preconditions one per line; 4 to 10 numbered steps with exactly one action each; " +
      "the exact test data for each step in its data field (realistic sample values such as jane.doe@example.com); " +
      "and a specific, observable expected result for every step (what appears, changes or is blocked), never vague wording like \"works\" or \"is correct\". " +
      "Start with opening the exact absolute URL (the application URL plus the path, e.g. Open https://shop.example.com/contact) and end with a verification step. " +
      "Use quoted UI text captured in the input, e.g. Click \"Sign in\"; never invent headings, labels or messages. Never include real credentials; refer to \"the test account\". " +
      "Preconditions always name the browser and window size, a signed-out private window (or the test account for sign-in flows), that the site is reachable, " +
      "and for anything that sends real data: \"Use a test environment, or do not press <button> on the live site\". " +
      "Browsers flag only the first invalid field, so test one empty or invalid field per case with the other fields valid, and check in DevTools > Network that no request was sent. " +
      "Sign-up cases use a new unique plus-address email such as qa+<timestamp>@example.com. " +
      "Do not invent features that the input does not support; record assumptions in notes.",
    input,
  });
  if (ai) return { cases: ai.cases.slice(0, count), generatedBy: "claude", notes: ai.notes };
  // Discovery guidance text is applied too, so "Message is required" adds that case on top of the page-based ones.
  const fromGuidance = opts.text?.trim() ? fromText(opts.text, opts.pages ?? [], opts.applicationUrl) : [];
  const all = opts.source === "DISCOVERY" ? [...fromGuidance, ...fromPages(opts.pages ?? [], opts.applicationUrl)] : fromGuidance;
  const cases = all.filter((x, i) => all.findIndex((y) => y.title === x.title) === i);
  const filtered = cases.filter((c) => categories.includes(c.category));
  return {
    cases: (filtered.length ? filtered : cases).slice(0, count),
    generatedBy: "heuristic",
    notes: opts.source === "DISCOVERY"
      ? "Generated by the rule-based generator because AI is not configured. Cases come from the discovered pages and forms and need human review."
      : `Generated by the rule-based generator because AI is not configured. Required fields, email validation, length limits, success messages and sign-in in the text became concrete cases${opts.pages?.length ? " using the fields found by the latest discovery" : "; run a discovery so the real field labels are used"}. Sentences it could not interpret are marked "Manual check".`,
  };
}

type Step = [action: string, expected: string, data?: string];
const c = (category: GeneratedCase["category"], priority: GeneratedCase["priority"], title: string, steps: (Step | null | false | undefined | "" | 0)[], expectedResult: string, preconditions: string[] = [], description = ""): GeneratedCase => ({
  title, description: description || title, preconditions: preconditions.map((p) => `• ${p}`).join("\n"),
  steps: steps.filter((s): s is Step => Boolean(s)).map(([action, expected, data]) => ({ action, expected, data: data ?? "" })), expectedResult, category, priority,
});

function pathOf(url: string) {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

/** Absolute address of a path on the site under test, e.g. "/contact" → "https://shop.example.com/contact". */
function absolute(base: string, path: string) {
  try {
    return new URL(path, base).href;
  } catch {
    return path;
  }
}

type Field = DiscoveredPage["forms"][number]["fields"][number];
/** What the tester sees: the label, else the placeholder (a field with only a placeholder), else the field's name. */
const label = (f: Field) => f.label || f.placeholder || f.name || f.type;
/** "Email" (placeholder "name@example.com"), for describing a form. */
const describe = (f: Field) => `"${label(f)}"${f.placeholder && f.placeholder !== label(f) ? ` (placeholder "${f.placeholder}")` : ""}`;
const isEmail = (f: Field) => f.type === "email" || /e-?mail/i.test(`${f.label} ${f.name}`);
/** Fields generated cases never fill: uploads and pickers a tester sets by hand. */
const SKIPPED = new Set(["file", "range", "color", "image", "reset"]);
const CHOICE = /^(checkbox|radio|select)/;
/** Fields the tester types into (as opposed to ticks or chooses). */
const typed = (f: Field) => !SKIPPED.has(f.type) && !CHOICE.test(f.type);

/** Realistic sample value for a field, so the tester (and the generated script) uses concrete data. */
function sample(f: Field): string {
  const k = `${f.label} ${f.name}`.toLowerCase();
  if (f.type === "textarea" || /message|comment|feedback|description/.test(k)) return "Hello, I would like to know when my order will arrive.";
  if (isEmail(f)) return "jane.doe@example.com";
  if (f.type === "tel" || /phone|mobile/.test(k)) return "+44 7700 900123";
  if (f.type === "number" || /\b(qty|quantity|amount|age)\b/.test(k)) return "2";
  if (f.type === "url" || /website|url/.test(k)) return "https://example.com";
  if (f.type === "date") return "2026-12-01";
  if (/first/.test(k)) return "Jane";
  if (/last|surname/.test(k)) return "Doe";
  if (/name/.test(k)) return "Jane Doe";
  if (/search|query/.test(k)) return "shoes";
  if (/post|zip/.test(k)) return "SW1A 1AA";
  if (/city|town/.test(k)) return "London";
  return "Sample text";
}

const joinAnd = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const quoteList = (xs: string[]) => joinAnd(xs.map((x) => `"${x}"`));
const capital = (s: string) => s.replace(/^\w/, (m) => m.toUpperCase());

// Preconditions every case starts from, in the wording a senior tester uses.
const PRE = {
  browser: "Desktop browser: latest stable Google Chrome (Firefox, Safari or Edge are fine; record which one you used), window at least 1366×768, DevTools available",
  signedOut: "Signed out of the site: use a new private (incognito) window so no session from an earlier visit is reused",
  reachable: (home: string) => `${home} is reachable from the test machine`,
  live: (button: string) => `Sends real data: use a test environment, or do not press ${button} on the live site`,
  safe: "Safe on the live site: the browser blocks the form before anything is sent",
  account: "A test account (email and password created for testing, never a real customer's) exists on this environment; use the login saved on the environment",
};
const basePre = (home: string) => [PRE.browser, PRE.signedOut, PRE.reachable(home)];

const SEP = /\s+[·|–—-]\s+/;
const titleFromPath = (p: string) => p.split("/").filter(Boolean).pop()?.replace(/[-_]+/g, " ").replace(/^\w/, (m) => m.toUpperCase()) || "Home";
/** "Sign in" → "Sign-in", and "/products/2" → "Products 2" rather than "2". */
function slugName(path: string) {
  const parts = path.split("?")[0].split("/").filter(Boolean);
  const last = titleFromPath(path).replace(/^sign ?in$/i, "Sign-in").replace(/^sign ?up$/i, "Sign-up").replace(/^log ?in$/i, "Login");
  return /^\d+$/.test(last) && parts.length > 1 ? `${titleFromPath(`/${parts.at(-2)}`)} ${last}` : last;
}

/**
 * Readable page names such as "Contact page": the page's own part of the browser title when no other page uses
 * it, otherwise a name from the path (many sites reuse one title everywhere), otherwise the path itself.
 */
function pageNamer(pages: DiscoveredPage[]) {
  const short = (p: DiscoveredPage) => (p.title.split(SEP)[0] ?? "").trim();
  const count = (f: (p: DiscoveredPage) => string) => {
    const m = new Map<string, number>();
    for (const p of pages) m.set(f(p).toLowerCase(), (m.get(f(p).toLowerCase()) ?? 0) + 1);
    return (p: DiscoveredPage) => m.get(f(p).toLowerCase()) ?? 0;
  };
  const shortUses = count(short), slugUses = count((p) => slugName(pathOf(p.url)));
  return (p: DiscoveredPage) => {
    const path = pathOf(p.url);
    if (path === "/" || p.depth === 0) return "Home page";
    const s = short(p);
    const base = s && s.length <= 40 && shortUses(p) === 1 ? s : slugUses(p) === 1 ? slugName(path) : path;
    return /\bpage$/i.test(base) ? capital(base) : `${capital(base)} page`;
  };
}

/** A password form that creates an account rather than signing in. */
const isSignUp = (path: string, fields: Field[]) =>
  /sign-?up|register|join|create-account/i.test(path) || fields.filter((x) => x.type === "password").length > 1
  || fields.some((x) => x.type !== "password" && /\bname\b/i.test(label(x)));

/** Links the scan saw in the header/navigation, on this site only, without sign-out or download links. */
const NAV_SKIP = /logout|log-out|signout|sign-out|delete|remove|unsubscribe|\.(pdf|zip|png|jpe?g|gif|svg|mp4|docx?)$/i;
function navTargets(p: DiscoveredPage) {
  const origin = (u: string) => {
    try {
      return new URL(u).origin;
    } catch {
      return "";
    }
  };
  const links = (p.navLinks ?? []).filter((l) => origin(l.href) === origin(p.url) && !NAV_SKIP.test(l.href) && !(l.href.includes("#") && l.href.split("#")[0] === p.url.split("#")[0]));
  return links.length ? links.map((l) => ({ text: l.text, href: l.href.split("#")[0] })) : p.navItems.map((text) => ({ text, href: "" }));
}

type PageCtx = { url: string; name: string; heading?: string; home: string };
type FormCtx = PageCtx & { fields: Field[]; submit?: string; formName: string; kind: "form" | "login" | "signup" };
type FillMode = "valid" | "login" | "signup";

const mainHeading = (p: DiscoveredPage) => p.h1?.[0] ?? p.headings[0];
const openStep = (p: PageCtx, shows = "the empty form"): Step =>
  [`Open ${p.url} in a new tab of the private window`, `The page loads${p.heading ? ` with the heading "${p.heading}"` : ""} and shows ${shows}`];
const submitStep = (f: { submit?: string }, expected: string, prefix = ""): Step => [`${prefix}${f.submit ? `Click "${f.submit}"` : prefix ? "submit the form" : "Submit the form"}`, expected];
const buttonName = (f: { submit?: string }) => (f.submit ? `"${f.submit}"` : "the submit button");
const networkClear: Step = ["Open DevTools > Network and clear the log", "The Network panel is recording and empty"];
const UNIQUE_EMAIL = "qa+<timestamp>@example.com, a new unique address: replace <timestamp> with the current date and time, e.g. qa+202611081530@example.com";

/** One step that fills a field with valid data: typed values, a ticked box or a chosen option. Null for fields a case can't fill. */
function fillStep(x: Field, mode: FillMode = "valid"): Step | null {
  const l = label(x);
  if (SKIPPED.has(x.type)) return null;
  if (x.type === "checkbox") return [`Tick the "${l}" checkbox`, "The checkbox shows a tick"];
  if (x.type === "radio") return [`Select the "${l}" radio button`, "The option becomes selected and any other option in its group is cleared"];
  if (x.type.startsWith("select")) {
    const option = x.options?.find((o, i) => i > 0 || !/^(select|choose|please|--|-)/i.test(o));
    return option ? [`Choose "${option}" in the "${l}" dropdown`, `The dropdown closes and shows ${option}`, option]
      : [`Choose the first real option in the "${l}" dropdown`, "The dropdown closes and shows the chosen option", "Any option other than the placeholder"];
  }
  if (x.type === "password") return mode === "login"
    ? [`Type the test account password into "${l}"`, "The password is shown masked as dots, not in plain text", "Password of the test account (from the environment's saved login)"]
    : [`Type "Str0ng-Passw0rd!" into "${l}"`, "The password is shown masked as dots, not in plain text", "Str0ng-Passw0rd!"];
  if (mode === "login") {
    const what = isEmail(x) ? "email" : "username";
    return [`Type the test account ${what} into "${l}"`, "The value appears in the field with no error message", `${capital(what)} of the test account (from the environment's saved login)`];
  }
  if (mode === "signup" && isEmail(x)) return [`Type a new unique email address into "${l}"`, "The address appears in the field with no error message", UNIQUE_EMAIL];
  return [`Type "${sample(x)}" into "${l}"`, "The value appears in the field with no error message", sample(x)];
}

/** Fill steps for a form, choosing one radio button per group. */
function fillSteps(fields: Field[], mode: FillMode = "valid") {
  const groups = new Set<string>();
  return fields.flatMap((x) => {
    if (x.type === "radio") {
      if (groups.has(x.name)) return [];
      groups.add(x.name);
    }
    return [fillStep(x, mode)].filter((s): s is Step => Boolean(s));
  });
}

/** Values for the other fields of a validation case: valid, but never the real test account (nothing is sent). */
const otherFill = (x: Field) => (x.type === "password" ? fillStep({ ...x, type: "text" }, "valid")!.map((v, i) => (i === 0 ? `Type "Any-Passw0rd" into "${label(x)}"` : i === 2 ? "Any-Passw0rd" : v)) as Step : fillStep(x));

/**
 * A form submitted with one field left empty and every other field valid. The browser's own validation flags only
 * the first invalid field, so each field gets its own case; DevTools > Network confirms nothing was sent.
 */
function blankFieldCase(f: FormCtx, field: Field, opts: { assumed?: boolean; title?: string; why?: string; extraPre?: string[] } = {}) {
  const l = label(field);
  // Only a field marked required is blocked by the browser itself; anything else may reach the site.
  const native = field.required && !opts.assumed;
  const title = opts.title ?? (f.kind === "login" ? `Sign-in on the ${f.name} is blocked while "${l}" is empty`
    : f.kind === "signup" ? `Sign-up on the ${f.name} is blocked while "${l}" is empty` : `${f.formName} is not sent while "${l}" is empty`);
  const others = f.fields.filter((x) => x !== field);
  return c("FORM_VALIDATION", opts.assumed ? "MEDIUM" : "HIGH", title, [
    openStep(f),
    networkClear,
    ...others.map(otherFill),
    [`Leave "${l}" empty`, "The field stays empty"],
    submitStep(f, !native
      ? `The form is not sent: the browser flags the "${l}" field, or an error message next to it asks for ${l}`
      : `The form is not sent: the browser flags the "${l}" field (Chrome shows: Please fill out this field.) and moves the focus to it`),
    ["Check the Network panel and the address bar", `No request was sent to the site and the address is still ${f.url}`],
  ], `The form is not submitted while "${l}" is empty: the browser flags the "${l}" field and no request reaches the site`,
  [...basePre(f.home), ...(opts.extraPre ?? []), "All form fields start empty (fresh page load)",
    ...(opts.assumed ? [`Assumption: ${l} is mandatory (the page does not mark it as required). Confirm with the requirements and delete this case if the field is optional`] : []),
    native ? PRE.safe : PRE.live(buttonName(f))],
  opts.why ?? `Checks that the ${f.kind === "form" ? f.formName.replace(/^\w/, (m) => m.toLowerCase()) : f.kind === "login" ? "sign-in form" : "sign-up form"} on ${f.url} cannot be sent while "${l}" is empty. `
    + "The other fields get valid values, because the browser flags only one invalid field at a time.");
}

/** An email address without @, then one without a domain, with every other field valid. */
function badEmailCase(f: FormCtx, email: Field, opts: { title?: string; why?: string; extraPre?: string[]; guessed?: boolean } = {}) {
  const l = label(email);
  // A guessed field (from text, not a scan) may not be a real type=email input the browser checks itself.
  const native = email.type === "email" && !opts.guessed;
  const others = f.fields.filter((x) => x !== email);
  const title = opts.title ?? `${f.kind === "login" ? `Sign-in form on the ${f.name}` : f.kind === "signup" ? `Sign-up form on the ${f.name}` : f.formName} rejects an email address without @`;
  return c("NEGATIVE", "MEDIUM", title, [
    openStep(f),
    networkClear,
    ...others.map(otherFill),
    [`Type "not-an-email" into "${l}"`, "The value appears in the field", "not-an-email"],
    submitStep(f, native ? `The form is not sent: the browser flags the "${l}" field and asks for a valid email address (Chrome shows: Please include an @ in the email address)`
      : `The form is not sent: the browser flags the "${l}" field, or an error message asks for a valid email address`),
    native && ["Check the Network panel", "No request was sent to the site"],
    [`Type "jane@" into "${l}", replacing the previous value`, "The value appears in the field", "jane@"],
    submitStep(f, `The form is still not sent: the browser flags the "${l}" field and asks for the part after the @`),
    ["Check the address bar", `${native ? "No request was sent to the site and the" : "The"} address is still ${f.url}`],
  ], `Email addresses without @ or without a domain are not accepted by the "${l}" field and the form is not submitted${native ? "; no request reaches the site" : ""}`,
  [...basePre(f.home), ...(opts.extraPre ?? []), native ? PRE.safe : PRE.live(buttonName(f))],
  opts.why ?? `Checks email format validation on ${f.url}: the other fields are valid, so the email address is the only problem the browser can flag.`);
}

/** Cases for one form: happy path, one blank-field case per required field, email format and a length boundary. */
function formCases(f: FormCtx, method: string): GeneratedCase[] {
  const out: GeneratedCase[] = [];
  const typedFields = f.fields.filter(typed);
  const required = typedFields.filter((x) => x.required).slice(0, 3);
  const email = f.fields.find(isEmail);
  if (f.kind === "login") {
    const user = f.fields.find((x) => x.type !== "password" && typed(x));
    const pwd = f.fields.find((x) => x.type === "password")!;
    const idWord = user && !isEmail(user) ? "username" : "email";
    out.push(c("AUTHENTICATION", "HIGH", `Registered user can sign in on the ${f.name} with a valid ${idWord} and password`, [
      openStep(f, "the sign-in form"),
      ["Look at the form", `The form shows the fields ${joinAnd(f.fields.filter(typed).map(describe))}${f.submit ? `; the "${f.submit}" button is shown` : ""}`],
      ...fillSteps(f.fields, "login"),
      networkClear,
      submitStep(f, "The sign-in request is sent and the browser leaves the sign-in form"),
      ["Look at the page", "The test account is signed in: an account area is shown instead of the sign-in form and no error appears"],
      ["Check the Network panel", "A request carrying the sign-in details was sent to the site"],
      [`Open ${f.home} in the same window`, "The home page loads"],
      ["Look at the page", "The site still shows you as signed in: no sign-in form is displayed"],
      ["Close the private window to end the session", "The test account is signed out when the window closes"],
    ], `With valid credentials the test account is signed in from ${f.url}, stays signed in when another page is opened, and no error appears`,
    [...basePre(f.home), PRE.account, "Before starting, confirm you are signed out: the page shows the sign-in form, not an account area"],
    `Verifies that a registered user can sign in with ${idWord} and password on ${f.url} and stays signed in. A real sign-in request is sent, so it needs the test account.`));
    for (const x of [user, pwd].filter((x): x is Field => Boolean(x))) out.push(blankFieldCase(f, x));
    out.push(c("NEGATIVE", "HIGH", `Sign-in on the ${f.name} is refused for a wrong password`, [
      openStep(f, "the sign-in form"),
      ...(user ? [fillStep(user, "login")!] : []),
      [`Type "wrong-password-123" into "${label(pwd)}"`, "The password is shown masked as dots", "wrong-password-123"],
      submitStep(f, "The sign-in is refused"),
      ["Look at the area above and around the form", "An error message says the email or password is wrong. It does not reveal whether the account exists and shows no technical code (such as CredentialsSignin or a stack trace)"],
      ["Check the address bar", `The address is still ${f.url} and the user is not signed in`],
    ], "Sign-in with a wrong password is refused with an error message, the user is not signed in and the message does not reveal whether the account exists",
    [...basePre(f.home), PRE.account, "Do not repeat this case many times in a row: repeated failed sign-ins can lock the test account"],
    `Ensures sign-in on ${f.url} fails safely with a wrong password: an error is shown, no session is created and no account details are revealed.`));
    if (email) out.push(badEmailCase(f, email));
    return out;
  }

  if (f.kind === "signup") {
    out.push(c("POSITIVE", "HIGH", `New visitor can create an account on the ${f.name} with valid details`, [
      openStep(f),
      ...fillSteps(f.fields, "signup"),
      submitStep(f, "The account is created: the sign-up form is replaced by a confirmation, a welcome page or the account area, and no error appears", "TEST ENVIRONMENT ONLY: "),
      ["Clear the cookies for this site to sign out (DevTools > Application > Storage > Clear site data)", "The site no longer treats the browser as signed in"],
      [`Open ${f.url} again`, "The empty sign-up form is shown"],
      ...fillSteps(f.fields, "signup").map((s): Step => (s[2] === UNIQUE_EMAIL ? [s[0].replace("a new unique email address", "the same email address as before"), s[1], "The same qa+<timestamp>@example.com address used above"] : s)),
      submitStep(f, "Registration is refused and an error message says the email address is already registered; no second account is created"),
    ], "A new account is created for a new unique email address, and a second sign-up with the same address is refused with an error message",
    [...basePre(f.home), PRE.live(buttonName(f)), "A new unique email address for every run: the test data uses a plus-address (qa+<timestamp>@example.com), so a rerun never collides with an earlier account",
      "Agree with the team how the created test account is deleted afterwards"],
    `Verifies that a new visitor can create an account on ${f.url}, and that the same email address cannot be registered twice.`));
  } else {
    const search = method === "GET" && typedFields.length <= 2 && f.fields.some((x) => x.type === "search" || /^(q|query|search|s)$/i.test(x.name));
    out.push(c("POSITIVE", "HIGH", search ? `${f.formName} opens a results page for a search term` : `${f.formName} can be sent with valid details and shows a confirmation`, [
      openStep(f),
      networkClear,
      ...fillSteps(f.fields),
      submitStep(f, search ? "The search is sent and a results page starts loading" : "The form is sent and the page shows the result without an error page"),
      search ? ["Look at the page", "A results page loads and no server error is shown"]
        : ["Look at the page", "A confirmation such as a thank-you or message-sent notice is shown, and no error appears"],
      ["Check the Network panel", "A request carrying the entered data was sent to the site and returned a 2xx or 3xx status"],
    ], search ? "A search with a valid term opens a results page without an error page or server error"
      : `The form on ${f.url} is sent with valid details and a confirmation is shown; no error appears`,
    [...basePre(f.home), ...(search ? [] : [PRE.live(buttonName(f))])],
    `Verifies the happy path of the ${f.formName.replace(/^\w/, (m) => m.toLowerCase())} on ${f.url} with realistic valid data.`));
  }

  for (const x of required) out.push(blankFieldCase(f, x));
  // Fields the page does not mark as required but that a form like this normally needs. These are assumptions:
  // the case says so, and a tester deletes it if the field really is optional.
  if (f.kind === "form") for (const x of typedFields.filter((x) => !x.required && ["text", "textarea", "email"].includes(x.type) && !/optional/i.test(label(x))).slice(0, 2))
    out.push(blankFieldCase(f, x, { assumed: true, why: `Checks that the ${f.formName.replace(/^\w/, (m) => m.toLowerCase())} on ${f.url} cannot be sent without ${label(x)}. Generated as an assumption because the field is not marked required.` }));
  if (email) out.push(badEmailCase(f, email));

  const text = typedFields.find((x) => ["text", "textarea"].includes(x.type));
  if (text) {
    const l = label(text);
    out.push(c("BOUNDARY", "LOW", `${f.kind === "signup" ? `Sign-up "${l}" field on the ${f.name}` : `${f.formName} "${l}" field`} handles a 256-character value`, [
      openStep(f),
      [`Paste the 256-character value from the test data into "${l}"`, "The field accepts the paste without freezing and the page layout does not break", `256 × the letter A: ${"A".repeat(256)}`],
      ["Look at the field after pasting", `"${l}" keeps all 256 characters, or stops at the maximum length the field allows (record the number); the field keeps its width and does not overflow the form`],
      ["Switch to a 375×667 phone screen (DevTools device toolbar: Ctrl/Cmd+Shift+M)", "The field and the long value still fit inside the screen; no horizontal scrollbar appears"],
      ["Switch back to the 1366×768 desktop window", "The form returns to its desktop layout"],
      ...fillSteps(f.fields.filter((x) => x !== text), f.kind === "signup" ? "signup" : "valid"),
      submitStep(f, "Either the form is accepted or a clear message about the field length is shown; the page never shows a server error (5xx), blank page or broken layout", "TEST ENVIRONMENT ONLY: "),
      ["Look at the page after submitting", "No server error, exception or blank page is shown"],
    ], `A 256-character value in the ${l} field is handled gracefully: the field and the layout stay intact and the form is either accepted or answered with a clear message, never a server error, blank page or broken layout`,
    [...basePre(f.home), PRE.live(buttonName(f)), "The steps before the submit are safe on the live site; the submit step needs a test environment"],
    `Checks the upper length boundary of the ${l} field on ${f.url}: the page layout with a long value, and how the site answers when it is sent.`));
  }
  return out;
}

/** Page-load and heading cases for one page. */
function pageCases(p: DiscoveredPage, name: string, home: string): GeneratedCase[] {
  const url = p.url, path = pathOf(url), h = mainHeading(p), h1 = Boolean(p.h1?.length);
  const nav = navTargets(p).slice(0, 8);
  const hover = nav.find((l) => l.href && pathOf(l.href) !== path);
  const sections = p.headings.filter((x) => x !== h && !(p.h1 ?? []).includes(x)).slice(0, 6);
  const form = p.forms[0];
  const visibleFields = form?.fields.filter((x) => !SKIPPED.has(x.type)).slice(0, 8) ?? [];
  const parts = [p.title && "its title", h && "heading", nav.length && "navigation", form && "form"].filter((x): x is string => Boolean(x));
  const out = [c("FUNCTIONAL", "HIGH", `${name} loads successfully with ${joinAnd(parts) || "its content"}`, [
    [`Open ${url} in a new tab of the private window (type the address into the address bar and press Enter)`, `The page finishes loading at ${url} with no error page, blank screen, 404 or browser security warning`],
    ['Open DevTools > Network, tick "Disable cache" and reload the page (Ctrl/Cmd+R)', `The document request for ${path} returns ${p.status ? `HTTP status ${p.status}` : "a 2xx status"} (not a redirect to another page, 4xx or 5xx)`],
    p.title && ["Look at the browser tab title", `The tab title reads exactly "${p.title}"`],
    h && ["Look at the main heading of the page", h1 ? `The main heading (h1) reads exactly "${h}" and is visible without scrolling` : `The heading "${h}" is shown near the top of the page without scrolling`],
    nav.length && ["Look at the navigation at the top of the page", `The navigation shows the links ${quoteList(nav.map((l) => l.text))}`],
    visibleFields.length && ["Look at the form", `The form shows the fields ${joinAnd(visibleFields.map(describe))}${form.submit ? `; the "${form.submit}" button is shown` : ""}`],
    hover && [`Hover over "${hover.text}" in the navigation (do not click)`, `The browser status bar shows the link target ${hover.href}`],
    ["Scroll slowly to the bottom of the page", sections.length ? `The sections ${quoteList(sections)} are shown, and their images load (no broken-image icons)` : "The rest of the page appears as you scroll and its images load (no broken-image icons)"],
    ["Open DevTools > Console and reload the page once more", "No red JavaScript errors are logged while the page loads (warnings, and failed requests for files such as a favicon, do not fail the case)"],
  ], `${url} returns ${p.status ? `HTTP ${p.status}` : "a 2xx status"} and opens with${p.title ? ` the tab title "${p.title}"` : " its content"}${h ? `, the heading "${h}"` : ""}${nav.length ? " and the navigation links" : ""}, with no error page or JavaScript errors`,
  basePre(home), `Confirms that the ${name} (${url}) can be opened directly by a signed-out visitor and shows its ${joinAnd(parts) || "content"} without errors.`)];

  if (h) out.push(c("UI", "MEDIUM", `${name} main heading "${h}" is visible and readable`, [
    [`Open ${url} in a new tab of the private window`, `The ${name} loads with no error page or blank screen`],
    ["Without scrolling, look at the main heading", `The heading "${h}" is fully visible above the fold at 1366×768, not cut off, overlapped or hidden behind the header`],
    ["Read the heading text character by character", `The text is exactly "${h}": correct spelling and capitalisation, no placeholder text such as Lorem ipsum or undefined`],
    p.h1?.length === 1 && ["Open DevTools > Elements, press Ctrl/Cmd+F and search for <h1", `Exactly one h1 element exists on the page and it contains "${h}"`],
    ["Switch to a 375×667 phone screen (DevTools device toolbar: Ctrl/Cmd+Shift+M, choose iPhone SE) and reload", `The heading "${h}" wraps onto more lines if needed but stays fully visible and readable inside the screen width; no horizontal scrollbar appears`],
    ["Switch back to the desktop window and zoom the page to 200% (Ctrl/Cmd and + until the zoom shows 200%)", `The heading "${h}" is still fully readable, not cut off and does not overlap other content`],
    ["Reset the zoom to 100% (Ctrl/Cmd+0)", "The page returns to its normal desktop layout"],
  ], `The heading "${h}" is shown at the top of the ${name}, correctly spelled, fully visible on a desktop window and readable without being cut off at 375 px width and at 200% zoom`,
  basePre(home), `Checks that the main heading of the ${name} (${url}) is shown, correctly worded and readable on a desktop window, a phone-sized screen and at 200% zoom.`));
  return out;
}

/** Site-wide cases: navigation, keyboard use and accessible names. */
function siteCases(pages: DiscoveredPage[], home: string, homePage: DiscoveredPage | undefined): { nav: GeneratedCase[]; a11y: GeneratedCase[] } {
  const byUrl = new Map(pages.map((p) => [p.url.replace(/\/$/, ""), p]));
  const source = homePage ?? pages[0];
  const links = navTargets(source).filter((l, i, all) => all.findIndex((x) => x.text === l.text) === i).slice(0, 5);
  const nav: GeneratedCase[] = [];
  if (links.length) nav.push(c("REGRESSION", "MEDIUM", "Navigation links open the right pages", [
    [`Open ${home} in a new tab of the private window`, "The home page loads with the navigation visible"],
    ...links.flatMap((l, i): Step[] => {
      const target = l.href ? byUrl.get(l.href.replace(/\/$/, "")) : undefined;
      const th = target && mainHeading(target);
      return [
        ...(i ? [[`Open ${home} again`, "The home page loads"] as Step] : []),
        [`Click "${l.text}" in the navigation`, l.href ? `The browser goes to ${l.href}${th ? ` and the heading "${th}" is shown` : ""} without an error page` : `A page for ${l.text} opens without an error page or 404`],
      ];
    }),
  ], "Every navigation link opens its page without an error page", basePre(home),
  `Checks that each item in the main navigation of ${home} leads to the right, working page.`));
  nav.push(c("ACCESSIBILITY", "MEDIUM", "Home page can be used with the keyboard and shows a visible focus indicator", [
    [`Open ${home} in a new tab of the private window`, "The home page loads"],
    ["Press Tab once", "Focus moves to the first link or control on the page (often a skip link or the first navigation link)"],
    ["Look at the focused element", "It has a clearly visible focus outline or highlight"],
    ["Press Tab repeatedly through the navigation links", "Focus moves through the links in the order they appear on screen, left to right and top to bottom, without skipping any"],
    ["Look at the focused element", "The focused element always has a visible focus indicator and is never hidden behind other content"],
    ["Press Shift+Tab once", "Focus moves back to the previous element"],
    ["Look at the focused element", "The previous element now shows the focus indicator"],
  ], "Links, buttons and fields can be reached with Tab and Shift+Tab in a logical order and the focused element always has a visible focus indicator",
  [...basePre(home), "Use the keyboard only (no mouse) once the page has loaded"], "Checks that keyboard-only users can reach every interactive element and always see where the focus is."));

  const formPages = pages.filter((p) => p.forms.length).slice(0, 2);
  const a11y = [c("ACCESSIBILITY", "LOW", "Images have alt text and form fields have labels", [
    [`Open ${home} in a new tab of the private window`, "The home page loads"],
    ["Check that every image has alt text (DevTools > Elements: each img element has an alt attribute; decorative images use an empty one)", "Every meaningful image has alt text"],
    ...formPages.flatMap((p): Step[] => [
      [`Open ${p.url}`, "The page with the form loads"],
      ["Check that every form field has a label or accessible name (clicking a label moves the cursor into its field)", "Every field has a visible label, or an accessible name for screen readers when it only has a placeholder"],
    ]),
  ], "Every meaningful image has alt text and every form field has a label or accessible name",
  [...basePre(home), "Browser developer tools or a screen reader is available"], "Checks basic accessible naming for screen-reader users.")];
  return { nav, a11y };
}

function fromPages(pages: DiscoveredPage[], applicationUrl: string): GeneratedCase[] {
  const nameOf = pageNamer(pages);
  const homePage = pages.find((p) => p.depth === 0) ?? pages.find((p) => pathOf(p.url) === "/");
  const home = homePage?.url ?? absolute(pages[0]?.url || applicationUrl, "/");
  const site = siteCases(pages, home, homePage);
  const out: GeneratedCase[] = [];
  for (const [i, p] of pages.slice(0, 8).entries()) {
    const name = nameOf(p);
    const path = pathOf(p.url);
    out.push(...pageCases(p, name, home));
    for (const [j, f] of p.forms.slice(0, 2).entries()) {
      const pwd = f.fields.some((x) => x.type === "password");
      const kind = pwd ? (isSignUp(path, f.fields) ? "signup" : "login") : "form";
      const formName = kind === "login" ? `Sign-in form on the ${name}` : kind === "signup" ? `Sign-up form on the ${name}`
        : j === 0 && name !== "Home page" ? `${name.replace(/ page$/, "")} form` : f.submit ? `"${f.submit}" form on the ${name}` : `Form ${j + 1} on the ${name}`;
      out.push(...formCases({ url: p.url, name, heading: mainHeading(p), home, fields: f.fields, submit: f.submit || undefined, formName, kind }, f.method));
    }
    // Navigation and keyboard checks come straight after the home page, so a large site never pushes them out.
    if (i === 0) out.push(...site.nav);
  }
  if (pages.length) out.push(...site.a11y);
  return out;
}


/** The discovered page the text is about: an explicit path wins, then a page named in the text, then a form whose fields are mentioned. */
function findPage(text: string, pages: DiscoveredPage[], login: boolean): DiscoveredPage | undefined {
  const t = text.toLowerCase();
  const path = text.match(/(?:^|\s)(\/[\w\-./]*)/)?.[1]?.replace(/[.,]$/, "");
  const score = (p: DiscoveredPage) => {
    const name = (p.title.split(/[·|–-]/)[0] ?? "").trim().toLowerCase();
    const labels = p.forms.flatMap((f) => f.fields.map((x) => label(x).toLowerCase()));
    return (path && pathOf(p.url) === path ? 10 : 0) + (name && t.includes(name) ? 3 : 0)
      + labels.filter((l) => l.length > 2 && t.includes(l)).length + (login && p.forms.some((f) => f.fields.some((x) => x.type === "password")) ? 2 : 0);
  };
  const best = [...pages].sort((a, b) => score(b) - score(a))[0];
  return best && score(best) > 0 ? best : undefined;
}

/** Field names from "X, Y and Z are required" and "the X field", for when no discovered form is available. */
function fieldsFromText(sentences: string[], login: boolean): Field[] {
  const names = sentences.flatMap((s) => [
    ...(s.match(/^(.*?)\b(?:is|are)\s+(?:required|mandatory)\b/i)?.[1].replace(/^(the|all|both)\s+/i, "").split(/,|\band\b|&/) ?? []),
    ...[...s.matchAll(/(?:^|\s)[Tt]he\s+["“]?([A-Z][\w ]{0,24}?)["”]?\s+field\b/g)].map((m) => m[1]),
  ]).map((n) => n.replace(/\b(the|fields?)\b/gi, "").trim()).filter((n) => n && n.split(/\s+/).length <= 3);
  if (sentences.some((s) => /e-?mail/i.test(s)) && !names.some((n) => /e-?mail/i.test(n))) names.push("Email");
  if (login && !names.some((n) => /password/i.test(n))) names.push("Password");
  return [...new Set(names)].map((n) => ({ name: n.toLowerCase(), label: n, required: false, type: /e-?mail/i.test(n) ? "email" : /message|comment|description/i.test(n) ? "textarea" : /password/i.test(n) ? "password" : "text" }));
}

/**
 * Rule-based cases from a feature description, user story or requirements. Sentences about required fields,
 * email validity, success messages, sign-in and length limits become concrete, automatable cases. The page and
 * its fields come from the latest discovery when it found the page, otherwise from the text. Anything else
 * becomes a case marked for manual completion.
 */
function fromText(text: string, pages: DiscoveredPage[] = [], applicationUrl = ""): GeneratedCase[] {
  const sentences = text.split(/\n+|(?<=[.!?])\s+/).map((s) => s.replace(/^[-*•\d.)\s]+/, "").trim()).filter((s) => s.length > 3);
  const login = /\b(sign|log)[\s-]?in\b|\blogin\b|password/i.test(text);
  const page = findPage(text, pages, login);
  const explicitPath = text.match(/(?:^|\s)(\/[\w\-./]*)/)?.[1]?.replace(/[.,]$/, "");
  const path = explicitPath ?? (page ? pathOf(page.url) : login ? "/login" : "/");
  const form = page?.forms.find((f) => login === f.fields.some((x) => x.type === "password")) ?? page?.forms[0];
  // A page without the form (e.g. /login discovered while signed in) only lends its path, not its title.
  const pageName = form ? page!.title : login ? "the sign-in page" : page?.title || titleFromPath(path);
  const fields = form?.fields.length ? form.fields : fieldsFromText(sentences, login);
  const isLoginForm = fields.some((x) => x.type === "password");
  const home = absolute(page?.url || applicationUrl, "/");
  const url = page && pathOf(page.url) === path ? page.url : absolute(page?.url || applicationUrl, path);
  const ctx: FormCtx = { url, name: pageName, heading: form && page ? mainHeading(page) : undefined, home, fields, submit: form?.submit || undefined, formName: pageName, kind: isLoginForm ? "login" : "form" };
  const open = openStep(ctx, isLoginForm ? "the sign-in form" : "the empty form");
  const assumptions = [
    ...(form ? [] : ["Field labels are taken from the text; adjust them if the page uses different wording (run a discovery to use the real ones)"]),
    ...(!explicitPath && !page ? [`The page address ${url} is assumed; change the first step if the page lives elsewhere`] : [])];
  const pre = [...basePre(home), ...assumptions];
  const live = PRE.live(buttonName(ctx));
  const find = (n: string) => fields.find((f) => label(f).toLowerCase() === n.toLowerCase()) ?? fields.find((f) => label(f).toLowerCase().includes(n.toLowerCase()));
  const out: GeneratedCase[] = [];
  const unmatched: string[] = [];
  let happy = false;
  // The sentence that describes success (if any) supplies the happy path's confirmation; context sentences
  // ("lets a visitor send…", "I want to…") are covered by that same happy path.
  const SUCCESS = /thank|success|confirm|\b(is|are) (shown|displayed)\b|\bappears?\b|redirect/i;
  const CONTEXT = /\b(lets|allows|enables|can)\b|\bi want\b|\bso that\b/i;
  const successSentence = sentences.find((s) => SUCCESS.test(s) && !/\b(error|wrong|invalid)\b/i.test(s));

  for (const s of sentences) {
    if (isLoginForm && /\b(wrong|invalid|incorrect)\b.*\bpassword\b|\bpassword\b.*\b(wrong|invalid|incorrect)\b/i.test(s)) continue; // covered by the wrong-password case below
    if (happy && fields.length && (s === successSentence || CONTEXT.test(s))) continue;
    const req = s.match(/^(.*?)\b(?:is|are)\s+(?:required|mandatory)\b/i);
    const max = s.match(/\b(?:max(?:imum)?|at most|up to|no more than|limited to)\s+(\d+)\s*(?:characters|chars)\b/i);
    if (req && fields.length) {
      const named = req[1].replace(/^(the|all|both)\s+/i, "").split(/,|\band\b|&/).map((n) => n.replace(/\b(the|fields?)\b/gi, "").trim()).filter(Boolean);
      for (const f of named.map(find).filter((x): x is Field => Boolean(x)))
        out.push(blankFieldCase(ctx, f, { title: `"${label(f)}" is required on ${pageName}`, extraPre: assumptions, why: `From the requirement "${s}": the form must not be sent without ${label(f)}.` }));
    } else if (/e-?mail/i.test(s) && /\bvalid\b/i.test(s) && fields.some((x) => x.type === "email" || /e-?mail/i.test(label(x)))) {
      const email = fields.find((x) => x.type === "email" || /e-?mail/i.test(label(x)))!;
      out.push(badEmailCase(ctx, email, { title: `Invalid email address is rejected on ${pageName}`, extraPre: assumptions, guessed: !form, why: `From the requirement "${s}".` }));
    } else if (max && fields.some((x) => ["text", "textarea"].includes(x.type))) {
      const n = Number(max[1]);
      const target = fields.find((x) => s.toLowerCase().includes(label(x).toLowerCase())) ?? fields.find((x) => ["text", "textarea"].includes(x.type))!;
      out.push(c("BOUNDARY", "MEDIUM", `"${label(target)}" longer than ${n} characters on ${pageName}`, [
        open,
        ...fields.filter((x) => x !== target).map((x) => fillStep(x)),
        [`Paste the ${n + 1}-character value from the test data into "${label(target)}"`, `The field stops at ${n} characters or the value is refused`, `${n + 1} × the letter A: ${"A".repeat(n + 1)}`],
        submitStep(ctx, "The application limits or refuses the value", "TEST ENVIRONMENT ONLY: "),
        ["Verify no server error is shown", "No server error, exception or blank page is displayed"],
      ], `Input over ${n} characters is limited or refused without a server error`, [...pre, live], `From the requirement "${s}".`));
    } else if ((s === successSentence || CONTEXT.test(s)) && fields.length && !happy) {
      happy = true;
      const shown = [...(successSentence ?? s).matchAll(/["“]([^"”]{2,80})["”]/g)].map((m) => m[1]);
      out.push(c(isLoginForm ? "AUTHENTICATION" : "POSITIVE", "HIGH", isLoginForm ? `Sign in on ${pageName} with valid credentials` : `Submit ${pageName} with valid data`, [
        open,
        ...fillSteps(fields, isLoginForm ? "login" : "valid"),
        submitStep(ctx, "The form is sent"),
        isLoginForm ? ["Verify the user is signed in", "The sign-in form is no longer shown and no error message appears"]
          : ["Verify a confirmation message is shown", shown.length ? `The message "${shown[0]}" appears` : "A success or thank-you message appears and no error message is shown"],
      ], isLoginForm ? "The user is signed in and sees their account area" : `The form is sent and a confirmation is shown${shown.length ? `: "${shown[0]}"` : ""}`,
      isLoginForm ? [...pre, PRE.account] : [...pre, live], `From "${[s, successSentence].filter((x, i, a) => x && a.indexOf(x) === i).join(" ")}".`));
    } else unmatched.push(s);
  }

  if (isLoginForm) {
    const user = fields.find((x) => x.type !== "password");
    out.push(c("NEGATIVE", "HIGH", `Sign-in with a wrong password is refused on ${pageName}`, [
      open,
      fillStep(user ?? { name: "email", label: "Email", type: "email", required: false }, "login"),
      ['Type "wrong-password-123" into "Password"', "The password is shown masked as dots", "wrong-password-123"],
      submitStep(ctx, "The sign-in attempt is refused"),
      ["Verify an error message about invalid credentials is displayed", "An error message is shown and the user stays on the sign-in page"],
      ["Check the address bar", `The address is still ${url} and the user is not signed in`],
    ], "An error message is displayed and the user is not signed in",
    [...pre, PRE.account, "Do not repeat this case many times in a row: repeated failed sign-ins can lock the test account"], "Ensures sign-in fails safely with a wrong password."));
  }
  if (fields.length && !happy && !isLoginForm) out.push(c("POSITIVE", "HIGH", `Submit ${pageName} with valid data`, [
    open, ...fillSteps(fields), submitStep(ctx, "The form is sent"),
    ["Verify a confirmation message is shown", "A success or thank-you message appears and no error message is shown"],
  ], "The form is sent and a confirmation is shown", [...pre, live], "Happy path with realistic valid data for every field."));

  // Sentences no rule understood: kept as manual cases rather than dropped, and clearly marked.
  for (const req of unmatched.filter((s) => s.length > 12)) {
    const short = req.length > 70 ? `${req.slice(0, 67)}…` : req;
    out.push(c("FUNCTIONAL", "MEDIUM", `Manual check: ${short}`, [
      open,
      [`Perform the behaviour described: ${req}`, "Each action is accepted without errors", "Valid, realistic data for this feature"],
      ["Check the outcome on screen", "The result described in the requirement is visible to the user"],
    ], `The system satisfies the requirement: ${req}`, [...pre, "Complete these steps with exact actions and quoted UI text before automating this case"], req));
  }
  return out;
}
