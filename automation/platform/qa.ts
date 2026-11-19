// Platform file (trusted, shipped by automation/). Readable action and assertion helpers that generated specs
// use through the `qa` fixture. Every assertion failure message starts with "QA_ASSERTION:" and says what was
// expected and what the page showed, so failure analysis can tell a failed expectation (possible application
// defect) from a script or setup error. Helpers never use fixed waits: assertions poll up to expect.timeout.
import { expect, type Locator, type Page } from "@playwright/test";

export const QA_PREFIX = "QA_ASSERTION:";

/** What the page showed when a test ended or an assertion failed (also attached as "page-state"). */
export interface PageState {
  url: string;
  title: string;
  heading: string;
  messages: string[];
}

/** Console and network lines collected by the fixtures for the current test. */
export interface QaLog {
  console: { type: string; text: string }[];
  network: string[];
  blocked: { url: string; reason: string }[];
}

const SUCCESS = /\b(thank you|thanks|message sent|has been sent|success(fully)?|submitted|received|confirm(ed|ation))\b/i;
const SIGN_OUT = /\b(sign ?out|log ?out)\b/i;
const SIGN_IN_ASKED = /\b(sign ?in|log ?in)\b/i;
const MESSAGE_SELECTOR =
  '[role="alert"], [role="status"], [aria-live], .error, .errors, .alert, .ok, .success, .invalid-feedback, .notice';

export async function pageState(page: Page): Promise<PageState> {
  try {
    return await page.evaluate((sel) => {
      const visible = (e: Element) => {
        const r = (e as HTMLElement).getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden";
      };
      return {
        url: location.pathname + location.search,
        title: document.title,
        heading: document.querySelector("h1")?.textContent?.trim().replace(/\s+/g, " ").slice(0, 200) ?? "",
        messages: Array.from(document.querySelectorAll(sel))
          .filter(visible)
          .map((e) => (e.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 200))
          .filter(Boolean)
          .slice(0, 3),
      };
    }, MESSAGE_SELECTOR);
  } catch {
    return { url: page.url(), title: "", heading: "", messages: [] };
  }
}

/** `"Thank you" (Message sent) at /contact` – the old runner's describeFailure wording. */
export function describeState(s: PageState): string {
  const shown = s.heading || s.title || "(no heading)";
  return `"${shown}"${s.messages.length ? ` (${s.messages.join(" · ")})` : ""} at ${s.url}`;
}

export class QaAssertionError extends Error {
  constructor(message: string) {
    super(`${QA_PREFIX} ${message}`);
    // Playwright prints `${name}: ${message}`; an empty name keeps "QA_ASSERTION:" at the start of the report.
    this.name = "";
  }
}

/** A form: its accessible name, a Locator, or both (page objects expose `{ name: "Contact us", locator }`). */
export interface NamedForm {
  name: string;
  locator: Locator;
}
export type FormRef = Locator | string | NamedForm;

/**
 * A field: the page object's Locator (decision D36: the check follows the locator, so repairing the locator repairs
 * the check; what is checked never changes), or its label (found by label, then placeholder; older scripts).
 */
export type FieldRef = Locator | string;

function isNamed(form: FormRef): form is NamedForm {
  return typeof form === "object" && "locator" in form && "name" in form;
}

export class Qa {
  private readonly page: Page;
  private readonly log: QaLog;
  private readonly timeout: number;

  constructor(page: Page, log: QaLog, timeout = 10_000) {
    this.page = page;
    this.log = log;
    this.timeout = timeout;
  }

  // ------------------------------------------------------------------ locating and acting

  /** The form control labelled `label` (label text first, then placeholder). */
  field(label: string): Locator {
    return this.page
      .getByLabel(label, { exact: true })
      .or(this.page.getByPlaceholder(label, { exact: true }))
      .first();
  }

  private fieldOf(field: FieldRef): Locator {
    return typeof field === "string" ? this.field(field) : field;
  }

  async fill(label: string, value: string): Promise<void> {
    await this.field(label).fill(value);
  }

  /** Presses the button (or link) named `name`. */
  async press(name: string): Promise<void> {
    await this.page
      .getByRole("button", { name, exact: true })
      .or(this.page.getByRole("link", { name, exact: true }))
      .first()
      .click();
  }

  /** Signs in with TEST_USERNAME / TEST_PASSWORD (set by the platform only for runs that sign in). */
  async signIn(loginPath = process.env.ATA_LOGIN_PATH ?? "/login"): Promise<void> {
    const username = process.env.TEST_USERNAME;
    const password = process.env.TEST_PASSWORD;
    if (!username || !password) throw new Error("Saved test credentials are not available to this run");
    await this.page.goto(loginPath);
    await this.page.getByLabel(/e-?mail|user ?name|login/i).first().fill(username);
    await this.page.locator('input[type="password"]').first().fill(password);
    await this.page
      .getByRole("button", { name: /sign ?in|log ?in|continue|submit/i })
      .first()
      .click();
  }

  // ------------------------------------------------------------------ assertions

  async expectFormShown(form: FormRef): Promise<void> {
    const name = this.formName(form);
    await this.until(() => this.resolveForm(form).isVisible(), `Expected the ${name} form to be shown`);
  }

  /** The submission did not go through: the form is still shown and no confirmation appeared. */
  async expectSubmissionBlocked(form: FormRef): Promise<void> {
    const name = this.formName(form);
    await this.settle();
    const shown = await this.resolveForm(form).isVisible().catch(() => false);
    const confirmed = await this.confirmationShown();
    if (!shown || confirmed) {
      await this.fail(`Expected the ${name} form to block the submission and still be shown`);
    }
  }

  /**
   * The control has a native :invalid state, aria-invalid="true", or a visible error names it. `field` is the page
   * object's locator (or a label); `label` is the name people read, used in the message and to match an error text.
   */
  async expectFieldFlagged(field: FieldRef, label?: string): Promise<void> {
    await this.settle();
    const name = label ?? (typeof field === "string" ? field : "the field");
    const control = this.fieldOf(field);
    await this.until(async () => {
      const own = await control
        .evaluate((el) => el.matches(":invalid") || el.getAttribute("aria-invalid") === "true")
        .catch(() => false);
      if (own) return true;
      if (label === undefined && typeof field !== "string") return false;
      const named = this.page.locator(MESSAGE_SELECTOR).filter({ hasText: new RegExp(escapeRe(name), "i") });
      return (await named.count()) > 0 && (await named.first().isVisible());
    }, `Expected ${name} to be identified as needing attention (invalid or required)`);
  }

  /** The submission went through: a confirmation is shown (optionally `text`), or the form went away. */
  async expectSubmissionAccepted(form: FormRef, text?: string): Promise<void> {
    const name = this.formName(form);
    await this.settle();
    await this.until(
      async () => {
        if (text) return this.page.getByText(text).first().isVisible();
        return (await this.confirmationShown()) || !(await this.resolveForm(form).isVisible().catch(() => false));
      },
      `Expected the ${name} form to be accepted${text ? ` with "${text}"` : " and a confirmation to be shown"}`,
    );
  }

  async expectSignedIn(): Promise<void> {
    await this.settle();
    await this.until(async () => {
      const password = await this.page.locator('input[type="password"]:visible').count();
      const signOut = await this.page.getByRole("button", { name: SIGN_OUT }).or(this.page.getByRole("link", { name: SIGN_OUT })).count();
      return password === 0 && signOut > 0;
    }, "Expected to be signed in (a sign-out control shown, no password field)");
  }

  /** Not signed in: a password field is shown, the page asks to sign in, or there is no sign-out control. */
  async expectNotSignedIn(): Promise<void> {
    await this.settle();
    await this.until(async () => {
      const password = await this.page.locator('input[type="password"]:visible').count();
      if (password > 0) return true;
      const state = await pageState(this.page);
      if (SIGN_IN_ASKED.test(state.heading) || state.messages.some((m) => SIGN_IN_ASKED.test(m))) return true;
      const signOut = await this.page.getByRole("button", { name: SIGN_OUT }).or(this.page.getByRole("link", { name: SIGN_OUT })).count();
      return signOut === 0;
    }, "Expected not to be signed in");
  }

  /** The field holds exactly `n` characters (or at most `n` with `{ atMost: true }`); `field` as for expectFieldFlagged. */
  async expectFieldLength(field: FieldRef, n: number, options: { atMost?: boolean } = {}, label?: string): Promise<void> {
    const name = label ?? (typeof field === "string" ? field : "the field");
    const control = this.fieldOf(field);
    await this.until(async () => {
      const length = await control.evaluate((el) => (el as HTMLInputElement).value.length);
      return options.atMost ? length <= n : length === n;
    }, `Expected ${name} to hold ${options.atMost ? "at most " : ""}${n} characters`);
  }

  /** A button (or link) named `name` is visible and enabled. */
  async expectControlEnabled(name: string): Promise<void> {
    const control = this.page.getByRole("button", { name }).or(this.page.getByRole("link", { name })).first();
    await this.until(
      async () => (await control.isVisible()) && (await control.isEnabled()),
      `Expected the ${name} control to be shown and enabled`,
    );
  }

  async expectErrorShown(): Promise<void> {
    await this.settle();
    await this.until(async () => {
      const msgs = this.page.locator('[role="alert"], .error, .errors, .invalid-feedback');
      return (await msgs.count()) > 0 && (await msgs.first().isVisible());
    }, "Expected an error message to be shown");
  }

  async expectText(text: string): Promise<void> {
    await this.until(() => this.page.getByText(text).first().isVisible(), `Expected the text "${text}" to be shown`);
  }

  async expectUrl(path: string): Promise<void> {
    await this.until(async () => new URL(this.page.url()).pathname === path, `Expected to be at ${path}`);
  }

  async expectNoConsoleErrors(): Promise<void> {
    await this.settle();
    const errors = this.log.console.filter((c) => c.type === "error" || c.type === "pageerror");
    if (errors.length) {
      await this.fail(
        `Expected no browser console errors, found ${errors.length} (first: ${errors[0].text.slice(0, 160)})`,
      );
    }
  }

  async expectNoHorizontalOverflow(): Promise<void> {
    await this.settle();
    const widths = await this.page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    if (widths.scroll > widths.client + 1) {
      await this.fail(`Expected no sideways scrolling, but the page is ${widths.scroll}px wide in a ${widths.client}px viewport`);
    }
  }

  async expectEveryFieldLabelled(form: FormRef): Promise<void> {
    const name = this.formName(form);
    const unlabelled = await this.resolveForm(form)
      .locator("input, select, textarea")
      .evaluateAll((els) =>
        els
          .filter((e) => {
            const t = (e.getAttribute("type") ?? "").toLowerCase();
            return !["hidden", "submit", "button", "reset", "image"].includes(t);
          })
          .filter((e) => {
            const id = e.getAttribute("id");
            const byFor = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
            return !(
              (byFor && byFor.textContent?.trim()) ||
              e.closest("label")?.textContent?.trim() ||
              e.getAttribute("aria-label")?.trim() ||
              e.getAttribute("aria-labelledby")?.trim() ||
              e.getAttribute("title")?.trim()
            );
          })
          .map((e) => e.getAttribute("name") || e.getAttribute("id") || e.tagName.toLowerCase()),
      );
    if (unlabelled.length) {
      await this.fail(`Expected every field of the ${name} form to have a label; unlabelled: ${unlabelled.join(", ")}`);
    }
  }

  // ------------------------------------------------------------------ internals

  private resolveForm(form: FormRef): Locator {
    if (isNamed(form)) return form.locator;
    if (typeof form !== "string") return form;
    return this.page
      .getByRole("form", { name: form })
      .or(this.page.locator("form").filter({ has: this.page.getByRole("heading", { name: form }) }))
      .or(this.page.locator("form").filter({ has: this.page.getByText(form, { exact: true }) }))
      .first();
  }

  private formName(form: FormRef): string {
    if (isNamed(form)) return form.name;
    if (typeof form === "string") return form;
    const desc = form.toString();
    return desc.length > 80 ? `${desc.slice(0, 77)}…` : desc;
  }

  private async confirmationShown(): Promise<boolean> {
    const state = await pageState(this.page);
    return SUCCESS.test(state.heading) || state.messages.some((m) => SUCCESS.test(m));
  }

  /** Lets a submission or navigation finish (load event, then the network going quiet for 500 ms, max 5 s). */
  private async settle(): Promise<void> {
    await this.page.waitForLoadState("load").catch(() => undefined);
    await this.page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
  }

  private async until(check: () => Promise<boolean>, expected: string): Promise<void> {
    try {
      await expect.poll(async () => check().catch(() => false), { timeout: this.timeout }).toBe(true);
    } catch {
      await this.fail(expected);
    }
  }

  private async fail(expected: string): Promise<never> {
    throw new QaAssertionError(`${expected}, but the page shows ${describeState(await pageState(this.page))}.`);
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
