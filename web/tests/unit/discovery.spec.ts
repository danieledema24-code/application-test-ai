import { expect, test } from "@playwright/test";
import { accessGapRows, elapsed, flattenSitemap, matrixColumns, nodeStatus, normaliseCounts } from "../../src/lib/discovery";
import type { PageSummary, ScanDetail } from "../../src/lib/contract";

const page = (over: Partial<PageSummary>): PageSummary => ({
  id: "p1",
  url: "https://acme.com/",
  title: "Home",
  http_status: 200,
  depth: 0,
  page_type: "home",
  requires_auth: false,
  counts: {},
  screenshot: null,
  ...over,
});

test("counts normalise aliases and unknown keys go to Other interactive", () => {
  expect(normaliseCounts({ form: 1, inputs: 3, select: 2, accordion: 1, weird: 2 })).toEqual({ forms: 1, inputs: 3, dropdowns: 2, other: 3 });
  const cols = matrixColumns([page({ counts: { links: 4, forms: 0 } }), page({ id: "p2", counts: { forms: 1 } })]);
  expect(cols.map((c) => c.key)).toEqual(["forms", "links"]);
});

test("access gap rows are exactly the API's gaps, in order, with their reason and evidence (no double count)", () => {
  const scan = {
    auth_boundaries: [{ url: "https://acme.com/login", kind: "login_form", evidence_refs: [{ evidence_id: "e1" }] }],
    access_gaps: [
      { area: "/login", reason: "Needs credentials", description: "A sign-in form was found on /login; pages behind it were not observed.", suggestion: "Add credentials and re-scan", evidence_refs: [{ evidence_id: "e1" }] },
      { area: "Contact form (/contact)", reason: "Not performed: destructive or transactional action", description: "The contact form on /contact was not submitted.", suggestion: "Requires explicit approval in a later phase", evidence_refs: [{ evidence_id: "e2" }, { evidence_id: "e3", selector: "form#contact" }] },
    ],
  } as unknown as ScanDetail;
  const rows = accessGapRows(scan);
  expect(rows).toHaveLength(2);
  expect(rows.map((r) => r.reason)).toEqual(["Needs credentials", "Not performed: destructive or transactional action"]);
  expect(rows[0]).toMatchObject({ area: "/login", suggestion: "Add credentials and re-scan", evidence: [{ evidence_id: "e1" }] });
  expect(rows[1].evidence).toHaveLength(2);
  expect(rows[1].description).toBe("The contact form on /contact was not submitted.");
});

test("sitemap flattening respects expanded nodes", () => {
  const root = { path: "/", title: "Home", page_id: "a", children: [{ path: "/p", page_id: "b", children: [{ path: "/p/x", page_id: "c" }] }] };
  expect(flattenSitemap(root, null).map((n) => [n.path, n.level])).toEqual([
    ["/", 1],
    ["/p", 2],
    ["/p/x", 3],
  ]);
  expect(flattenSitemap(root, new Set(["a"])).map((n) => n.path)).toEqual(["/", "/p"]);
  expect(nodeStatus({ requires_auth: true }).label).toBe("Needs credentials");
  expect(nodeStatus({ page_id: "x" }).label).toBe("Visited");
  expect(nodeStatus({ http_status: 503 }).label).toBe("Couldn’t load (HTTP 503)");
});

test("elapsed formats mm:ss and h:mm:ss", () => {
  expect(elapsed("2026-11-12T10:00:00Z", "2026-11-12T10:04:12Z")).toBe("04:12");
  expect(elapsed("2026-11-12T10:00:00Z", "2026-11-12T11:00:05Z")).toBe("1:00:05");
  expect(elapsed(null)).toBe("—");
});
