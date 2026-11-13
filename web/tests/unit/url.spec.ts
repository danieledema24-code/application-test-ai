import { expect, test } from "@playwright/test";
import { URL_COPY, checkUrlClientSide, interpretUrlCheck, reportFileName, scanNumber } from "../../src/lib/url";
import type { UrlCheckResult } from "../../src/lib/contract";

test.describe("checkUrlClientSide (design §6.1 C1–C5)", () => {
  test("C1 empty", () => {
    expect(checkUrlClientSide("   ")).toEqual({ ok: false, code: "C1", message: "Enter a website URL." });
  });

  test("adds https:// when there is no scheme, and says so", () => {
    const r = checkUrlClientSide("example.com");
    expect(r).toEqual({ ok: true, url: "https://example.com", host: "example.com", addedScheme: true });
  });

  test("keeps http and paths, drops the fragment", () => {
    const r = checkUrlClientSide("http://shop.example.org/cart?x=1#top");
    expect(r.ok && r.url).toBe("http://shop.example.org/cart?x=1");
    expect(r.ok && r.addedScheme).toBe(false);
  });

  test("host with a port but no scheme is still a web URL", () => {
    const r = checkUrlClientSide("example.com:8080/path");
    expect(r.ok && r.url).toBe("https://example.com:8080/path");
  });

  test("C2 not a URL", () => {
    for (const bad of ["not a url", "hello", "https://", "exa mple.com"]) expect(checkUrlClientSide(bad)).toMatchObject({ ok: false, code: "C2" });
  });

  test("C3 non-web schemes", () => {
    for (const bad of ["ftp://example.com", "file:///etc/passwd", "javascript:alert(1)", "data:text/html,hi"])
      expect(checkUrlClientSide(bad)).toMatchObject({ ok: false, code: "C3", message: URL_COPY.C3 });
  });

  test("C4 credentials in the URL", () => {
    expect(checkUrlClientSide("https://user:pw@example.com")).toMatchObject({ ok: false, code: "C4" });
  });

  test("C5 obviously private hosts", () => {
    for (const bad of ["localhost:3000", "http://127.0.0.1", "10.1.2.3", "http://192.168.0.10/admin", "http://169.254.169.254/", "intranet.local", "db.internal", "http://[::1]/"])
      expect(checkUrlClientSide(bad), bad).toMatchObject({ ok: false, code: "C5" });
    expect(checkUrlClientSide("http://172.15.0.1").ok).toBe(true);
    expect(checkUrlClientSide("http://169.254.169.254/latest/meta-data")).toMatchObject({ ok: false, message: URL_COPY.metadata });
  });

  test("private hosts defer to the server check unless the server says it blocks them; metadata is always blocked", () => {
    const defer = { blockPrivate: false };
    for (const local of ["http://localhost:4100", "http://127.0.0.1:8765/", "http://10.0.0.1", "http://192.168.1.1"])
      expect(checkUrlClientSide(local, defer), local).toMatchObject({ ok: true });
    expect(checkUrlClientSide("http://localhost:4100", defer)).toMatchObject({ url: "http://localhost:4100", host: "localhost" });
    for (const meta of ["http://169.254.169.254/", "http://metadata.google.internal/"])
      expect(checkUrlClientSide(meta, defer), meta).toMatchObject({ ok: false, code: "C5", message: URL_COPY.metadata });
  });
});

const base: UrlCheckResult = {
  input_url: "https://acme.com",
  normalised_url: "https://acme.com",
  allowed: true,
  blocked_reason: null,
  reachable: true,
  http_status: 200,
  final_url: "https://acme.com",
  redirects: [],
  cross_site_redirect: false,
  tls: { valid: true, error: null },
  content_type: "text/html",
  robots: { found: true, disallows_start: false },
  checked_at: "2026-11-12T10:00:00Z",
};

test.describe("interpretUrlCheck (S1–S9)", () => {
  test("ok", () => {
    const v = interpretUrlCheck(base);
    expect(v).toMatchObject({ ok: true, error: null, scopeHost: "acme.com", warnings: [], info: [] });
  });
  test("S1 private address", () => {
    const v = interpretUrlCheck({ ...base, allowed: false, blocked_reason: "Private network address", reachable: false, resolved_ip: "10.0.0.5" });
    expect(v.error).toBe("acme.com resolves to a private or internal address (10.0.0.5). For safety, only public websites can be analysed.");
  });
  test("S2 metadata", () => {
    expect(interpretUrlCheck({ ...base, allowed: false, blocked_reason: "Cloud metadata endpoint" }).error).toBe(URL_COPY.metadata);
  });
  test("S3 redirect to a blocked address", () => {
    const v = interpretUrlCheck({ ...base, allowed: false, blocked_reason: "Redirect to private address", redirects: [{ url: "http://10.0.0.1", status: 302 }] });
    expect(v.error).toBe(URL_COPY.redirectBlocked);
  });
  test("S4 DNS / S5 timeout", () => {
    expect(interpretUrlCheck({ ...base, reachable: false, http_status: null, error: "DNS resolution failed" }).error).toBe("We couldn't find acme.com. Check the address for typos.");
    expect(interpretUrlCheck({ ...base, reachable: false, http_status: null }).error).toContain("We couldn't reach https://acme.com (no response after 10 s)");
  });
  test("S6 5xx / S7 404 block", () => {
    expect(interpretUrlCheck({ ...base, http_status: 503 }).error).toBe("acme.com responded with a server error (HTTP 503). Try again later.");
    expect(interpretUrlCheck({ ...base, http_status: 404 }).error).toBe(URL_COPY.notFound);
  });
  test("S8 sign-in is a warning, S9 cross-host redirect is info", () => {
    expect(interpretUrlCheck({ ...base, http_status: 401 })).toMatchObject({ ok: true });
    expect(interpretUrlCheck({ ...base, http_status: 403 }).warnings[0]).toContain("requires sign-in (HTTP 403)");
    const v = interpretUrlCheck({ ...base, final_url: "https://www.acme.com/", cross_site_redirect: true });
    expect(v.info).toEqual(["Redirects to https://www.acme.com/. We'll analyse that address."]);
    expect(v.scopeHost).toBe("www.acme.com");
  });
});

test("report file name follows {host}-discovery-report-scan{n}-{yyyy-mm-dd}.pdf", () => {
  expect(reportFileName("www.acme.com", 2, new Date(2026, 10, 12))).toBe("www.acme.com-discovery-report-scan2-2026-11-12.pdf");
  expect(scanNumber("SCAN-0002")).toBe(2);
  expect(scanNumber(null)).toBeNull();
});
