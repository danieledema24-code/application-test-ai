// Relative import so the pure helpers here can be unit-tested outside Next.
import { ApiError, NETWORK_ERROR_MESSAGE } from "../../lib/api";

/** Maps an auth API failure to the design copy (§4 states). Field errors are returned separately. */
export function authErrorMessage(err: unknown, context: "login" | "register" | "reset"): string {
  if (err instanceof ApiError) {
    if (err.code === "network" || err.status === 0) return NETWORK_ERROR_MESSAGE;
    if (err.status === 429) {
      const minutes = err.retryAfter ? Math.max(1, Math.ceil(err.retryAfter / 60)) : null;
      return minutes ? `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.` : "Too many attempts. Try again in a few minutes.";
    }
    if (context === "login" && (err.status === 401 || err.code === "unauthenticated")) return "Email or password is incorrect.";
    if (err.status >= 500) return NETWORK_ERROR_MESSAGE;
    return err.message;
  }
  return NETWORK_ERROR_MESSAGE;
}

const FIELD_COPY: Record<string, string> = {
  full_name: "Enter your full name.",
  organisation_name: "Enter your organisation’s name.",
};

/**
 * Product copy for a server field error. Validator text (e.g. "value is not a valid email address:
 * The part after the @-sign is a special-use or reserved name…") is never shown as-is.
 */
export function friendlyFieldError(field: string, message: string): string {
  const m = message.toLowerCase();
  if (field === "email") {
    if (/special-use|reserved|does not accept email|not deliverable|undeliverable/.test(m)) return "This email domain can’t be used. Enter your work email address.";
    return "Enter a valid email address, like name@company.com.";
  }
  if (field === "password") {
    if (/common|breach|pwned|guess/.test(m)) return "This password is too common. Choose a less predictable one.";
    return `Use at least ${MIN_PASSWORD} characters.`;
  }
  // Short, plain messages from the API can be shown; validator-style ones are replaced.
  if (/^(value|string|input|field)\b|should have|validation|type=/.test(m)) return FIELD_COPY[field] ?? "Check this field.";
  return message;
}

export function isEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
}

export const MIN_PASSWORD = 12;

/** True when focus is moving to a submit button (used to skip blur validation, see register/login). */
export function isSubmit(el: EventTarget | null): boolean {
  return el instanceof HTMLButtonElement && el.type === "submit";
}
