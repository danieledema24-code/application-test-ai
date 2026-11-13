import { expect, test } from "@playwright/test";
import { safeNextPath, toApiError } from "../../src/lib/api";
import { duplicateFromError } from "../../src/lib/projectStatus";

test("error envelope is parsed into code, message, field errors and request id", () => {
  const err = toApiError(422, {
    error: { code: "validation_error", message: "Invalid input", details: [{ field: "body.email", message: "Not an email" }, { field: "password", message: "Too short" }], request_id: "01J" },
  });
  expect(err.code).toBe("validation_error");
  expect(err.message).toBe("Invalid input");
  expect(err.requestId).toBe("01J");
  expect(err.fieldErrors).toEqual({ email: "Not an email", password: "Too short" });
});

test("Retry-After is read on 429", () => {
  const err = toApiError(429, { error: { code: "rate_limited", message: "Slow down" } }, new Headers({ "Retry-After": "120" }));
  expect(err.retryAfter).toBe(120);
});

test("non-envelope bodies still produce a usable error", () => {
  expect(toApiError(500, "<html>").code).toBe("internal");
  expect(toApiError(401, null).code).toBe("unauthenticated");
});

test("safeNextPath only allows same-origin app paths", () => {
  expect(safeNextPath("/projects/1?x=1")).toBe("/projects/1?x=1");
  expect(safeNextPath("//evil.com")).toBeNull();
  expect(safeNextPath("https://evil.com")).toBeNull();
  expect(safeNextPath("/\\evil.com")).toBeNull();
  expect(safeNextPath("/login")).toBeNull();
});

test("duplicate project 409 is recognised in both shapes", () => {
  const a = toApiError(409, { error: { code: "DUPLICATE_PROJECT", message: "Exists", details: { project: { id: "p1", name: "acme.com", primary_url: "https://acme.com" } } } });
  expect(duplicateFromError(a)).toEqual({ id: "p1", name: "acme.com", url: "https://acme.com" });
  const b = toApiError(409, { error: { code: "conflict", message: "Exists", details: { project_id: "p2" } } });
  expect(duplicateFromError(b)).toEqual({ id: "p2", name: null, url: null });
  const c = toApiError(409, { error: { code: "conflict", message: "Version mismatch" } });
  expect(duplicateFromError(c)).toBeNull();
});

test("server field errors are shown as product copy, never raw validator text", async () => {
  const { friendlyFieldError } = await import("../../src/components/auth/authErrors");
  expect(
    friendlyFieldError("email", "value is not a valid email address: The part after the @-sign is a special-use or reserved name that cannot be used with email."),
  ).toBe("This email domain can’t be used. Enter your work email address.");
  expect(friendlyFieldError("email", "value is not a valid email address: An email address must have an @-sign.")).toBe("Enter a valid email address, like name@company.com.");
  expect(friendlyFieldError("password", "String should have at least 12 characters")).toBe("Use at least 12 characters.");
  expect(friendlyFieldError("full_name", "String should have at least 1 character")).toBe("Enter your full name.");
  expect(friendlyFieldError("organisation_name", "Organisation name is taken.")).toBe("Organisation name is taken.");
});
