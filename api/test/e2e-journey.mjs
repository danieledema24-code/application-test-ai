// End-to-end MVP journey (spec §8) against a running API (:4000) and demo target (:4100).
// Usage: node test/e2e-journey.mjs
const API = process.env.API_URL ?? "http://localhost:4000/api";
const TARGET = process.env.TARGET_URL ?? "http://localhost:4100";
let token = "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(method, path, body, tk = token) {
  const res = await fetch(API + path, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(tk ? { authorization: `Bearer ${tk}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
const checks = [];
function check(name, cond, info = "") {
  checks.push({ name, ok: Boolean(cond) });
  console.log(`${cond ? "✔" : "✘"} ${name}${info ? ` — ${info}` : ""}`);
}
async function until(fn, pred, ms = 120000) {
  const t = Date.now();
  for (;;) { const v = await fn(); if (pred(v) || Date.now() - t > ms) return v; await sleep(1500); }
}

const email = `qa+${Date.now()}@example.com`;
// AC-001
let r = await call("POST", "/auth/register", { fullName: "Quinn Tester", email, password: "S3cure-pass!", organisationName: "Acme QA" });
check("register", r.status === 200, r.data.error);
token = r.data.token;
r = await call("POST", "/auth/login", { email, password: "S3cure-pass!" });
check("login", r.status === 200 && r.data.token);
token = r.data.token;
check("wrong password rejected", (await call("POST", "/auth/login", { email, password: "nope-nope" })).status === 401);

// AC-002/003
r = await call("POST", "/projects", { name: "My Web Application", description: "DemoShop", applicationUrl: TARGET, applicationType: "WEB" });
check("create project", r.status === 200, r.data.error);
const project = r.data;
const env = project.environments[0];
r = await call("POST", `/projects/${project.id}/discovery`, { environmentId: env.id });
check("discovery blocked until authorised", r.status === 409);
r = await call("PATCH", `/environments/${env.id}`, { authorised: true, credentials: { username: "qa.tester@example.com", password: "Passw0rd!demo", bearerToken: "demo-token-7f3a9c" } });
check("authorise env + store credentials", r.status === 200 && r.data.hasCredentials && !JSON.stringify(r.data).includes("Passw0rd"));
check("SSRF: metadata endpoint blocked", (await call("POST", "/projects", { name: "x", applicationUrl: "http://169.254.169.254/latest", applicationType: "WEB" })).status === 400);

// AC-004
r = await call("POST", `/projects/${project.id}/discovery`, { environmentId: env.id, maxPages: 10, useCredentials: true });
check("start discovery", r.status === 200, r.data.error);
const disc = await until(() => call("GET", `/discovery/${r.data.discoveryId}`).then((x) => x.data), (d) => ["COMPLETED", "FAILED"].includes(d.status));
check("discovery completed", disc.status === "COMPLETED", `${disc.pages?.length} pages, ${disc.inaccessible?.length} inaccessible, authRequired=${disc.authRequired}`);
check("discovery states limitations", disc.limitations.length > 0 && /not a complete/.test(disc.coverageNote));

// AC-005
r = await call("POST", `/projects/${project.id}/test-cases/generate`, { source: "DISCOVERY", count: 15 });
check("generate cases from discovery", r.status === 200 && r.data.generated.length > 0, `${r.data.generated?.length} cases via ${r.data.generatedBy}`);
const cases = r.data.generated;
check("generated cases are DRAFT", cases.every((c) => c.status === "DRAFT"));
r = await call("POST", `/projects/${project.id}/test-cases/generate`, { source: "USER_STORY", text: "As a shopper I can send a message through the contact page so that support can reply to me." });
check("generate cases from user story", r.status === 200 && r.data.generated.length > 0);
const edited = await call("PATCH", `/test-cases/${cases[0].id}`, { title: `${cases[0].title} (reviewed)` });
check("edit case bumps version", edited.data.version === 2);
check("partial edit keeps other fields", edited.data.steps.length === cases[0].steps.length && edited.data.category === cases[0].category);

// Pick concrete cases for automation: page load + required-field validation on contact
const pick = cases.filter((c) => /loads successfully|Required field validation on Contact|Main heading/i.test(c.title)).slice(0, 4);
r = await call("POST", `/projects/${project.id}/test-runs`, { executionType: "AUTOMATED", environmentId: env.id, testCaseIds: pick.map((c) => c.id) });
check("unapproved cases cannot run", r.status === 400);
await call("POST", "/test-cases/bulk-status", { ids: pick.map((c) => c.id), status: "APPROVED" });

// AC-007/008
r = await call("POST", `/projects/${project.id}/test-runs`, { executionType: "AUTOMATED", environmentId: env.id, testCaseIds: pick.map((c) => c.id) });
check("start automated run", r.status === 200, r.data.error);
const autoRun = await until(() => call("GET", `/test-runs/${r.data.id}`).then((x) => x.data), (x) => !["QUEUED", "RUNNING"].includes(x.status), 240000);
console.log("   results:", autoRun.results.map((x) => `${x.testCaseKey}:${x.status}`).join(" "));
check("automated run finished", ["PASSED", "FAILED", "ERROR"].includes(autoRun.status), autoRun.status);
check("evidence stored", autoRun.results.every((x) => x.evidence.some((e) => e.fileType === "SCREENSHOT")));
const failedAuto = autoRun.results.find((x) => x.status !== "PASSED");
if (failedAuto) check("failure analysis attached as hypothesis", failedAuto.failureAnalysis?.hypothesis === true, failedAuto.failureAnalysis?.classification);
const shot = autoRun.results[0].evidence.find((e) => e.fileType === "SCREENSHOT");
const img = await fetch(`${API.replace(/\/api$/, "")}${shot.url}?token=${token}`);
check("evidence file downloadable", img.status === 200 && img.headers.get("content-type") === "image/png");

// Playwright Test specs + exports
const caseDetail = await call("GET", `/test-cases/${pick[0].id}`);
const code = caseDetail.data.scripts?.[0]?.code ?? "";
check("scripts are Playwright Test specs", /from "\.\.\/fixtures"/.test(code) && /\btest\(/.test(code), code.slice(0, 80));
const zipRes = await fetch(`${API}/projects/${project.id}/playwright-export?caseIds=${pick.map((c) => c.id).join(",")}&token=${token}`);
const zipBuf = Buffer.from(await zipRes.arrayBuffer());
check("playwright project export", zipRes.status === 200 && zipRes.headers.get("content-type") === "application/zip" && zipBuf.toString("latin1").includes("playwright.config.ts"));
const csvRes = await fetch(`${API}/projects/${project.id}/test-cases/export.csv?token=${token}`);
const csv = await csvRes.text();
check("test case CSV export", csvRes.status === 200 && csv.includes("Expected result") && csv.includes(cases[0].key));

// AC-006 manual
const manualCase = cases.find((c) => /Required field/i.test(c.title)) ?? cases[1];
await call("POST", `/test-cases/${manualCase.id}/status`, { status: "READY" });
r = await call("POST", `/projects/${project.id}/test-runs`, { executionType: "MANUAL", environmentId: env.id, testCaseIds: [manualCase.id] });
check("start manual run", r.status === 200 && r.data.status === "IN_PROGRESS");
const manualRun = (await call("GET", `/test-runs/${r.data.id}`)).data;
const mr = manualRun.results[0];
r = await call("PATCH", `/test-results/${mr.id}`, { stepResults: [{ index: 0, status: "PASSED" }, { index: 1, status: "FAILED", note: "Form submitted with empty message" }], actualResult: "Form submitted with an empty message; no validation shown", note: "Observed on Chrome" });
check("record manual step results", r.status === 200 && r.data.status === "FAILED");
const form = new FormData();
form.append("file", new Blob([Buffer.from("fake screenshot")], { type: "image/png" }), "observation.png");
const up = await fetch(`${API}/test-results/${mr.id}/evidence`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: form });
check("upload manual evidence", up.status === 200);
r = await call("POST", `/test-runs/${manualRun.id}/complete`);
check("complete manual run", r.data.status === "COMPLETED");
check("completed manual results are locked", (await call("PATCH", `/test-results/${mr.id}`, { status: "PASSED" })).status === 400);

// AC-010 defects
r = await call("POST", `/test-results/${mr.id}/defect-draft`);
check("defect draft from failure", r.status === 200 && r.data.title, r.data.generatedBy);
r = await call("POST", "/defects", { ...r.data, severity: "HIGH" });
check("create defect", r.status === 200 && r.data.key.startsWith("DEF-"), r.data.key);
const defect = r.data;
r = await call("PATCH", `/defects/${defect.id}`, { status: "IN_PROGRESS" });
check("update defect status", r.data.status === "IN_PROGRESS");
r = await call("GET", `/defects?severity=HIGH&status=IN_PROGRESS&projectId=${project.id}`);
check("filter defects", r.data.length === 1);

// AC-009 API testing
const spec = await (await fetch(`${TARGET}/openapi.json`)).text();
r = await call("POST", `/projects/${project.id}/api-endpoints/import-openapi`, { spec });
check("import OpenAPI", r.status === 200 && r.data.imported.length === 3, `${r.data.imported?.length} endpoints`);
const getOne = r.data.imported.find((e) => e.path === "/api/products/1");
r = await call("POST", `/api-endpoints/${getOne.id}/send`, { environmentId: env.id });
check("send API request (auth injected, redacted)", r.data.response?.status === 200 && r.data.request.headers.authorization === "[REDACTED]");
check("schema validation catches wrong type", r.data.assertions.some((a) => !a.passed && /price/.test(a.message)));
const post = (await call("GET", `/projects/${project.id}/api-endpoints`)).data.find((e) => e.method === "POST");
r = await call("POST", `/api-endpoints/${post.id}/send`, { environmentId: env.id });
check("write request requires confirmation", r.status === 409 && r.data.requiresConfirmation === true);
r = await call("POST", `/projects/${project.id}/api-endpoints/generate-tests`, {});
check("generate API tests", r.data.generated.length >= 6, `${r.data.generated.length} cases`);
const apiCases = r.data.generated;
await call("POST", "/test-cases/bulk-status", { ids: apiCases.map((c) => c.id), status: "APPROVED" });
r = await call("POST", `/projects/${project.id}/test-runs`, { executionType: "API", environmentId: env.id, testCaseIds: apiCases.map((c) => c.id) });
check("start API run", r.status === 200, r.data.error);
const apiRun = await until(() => call("GET", `/test-runs/${r.data.id}`).then((x) => x.data), (x) => !["QUEUED", "RUNNING"].includes(x.status));
console.log("   results:", apiRun.results.map((x) => `${x.testCaseTitle.slice(0, 50)}=${x.status}`).join("\n            "));
check("API run recorded", apiRun.summary.total === apiCases.length && apiRun.summary.passed > 0, JSON.stringify(apiRun.summary));
check("no secrets in API evidence", !JSON.stringify(apiRun).includes("demo-token-7f3a9c"));

// AC-011 reports
for (const format of ["PDF", "CSV"]) {
  r = await call("POST", "/reports", { projectId: project.id, format });
  const dl = await fetch(`${API}/reports/${r.data.id}/download?token=${token}`);
  const buf = Buffer.from(await dl.arrayBuffer());
  check(`${format} report`, dl.status === 200 && buf.length > 200 && (format === "CSV" || buf.subarray(0, 4).toString() === "%PDF"), `${buf.length} bytes`);
  if (format === "CSV") check("report has no secrets", !buf.toString().includes("Passw0rd") && !buf.toString().includes("demo-token"));
}
r = await call("POST", "/reports", { projectId: project.id, testRunId: autoRun.id, format: "PDF" });
check("run-level report", r.status === 200 && r.data.reportType === "RUN");

// AC-012/014 dashboard + history
r = await call("GET", "/dashboard");
check("dashboard metrics", r.data.totals.projects === 1 && r.data.totals.testsExecuted > 0 && r.data.totals.openDefects === 1, JSON.stringify(r.data.totals));
r = await call("GET", "/dashboard/trend?days=7");
check("trend 7 days", r.data.length === 7 && r.data.at(-1).passed + r.data.at(-1).failed > 0);
r = await call("GET", `/test-runs?projectId=${project.id}`);
check("run history", r.data.length >= 3);
r = await call("GET", `/test-runs/compare?a=${autoRun.id}&b=${apiRun.id}`);
check("compare runs", r.status === 200 && Array.isArray(r.data.changes));
check("activity feed", (await call("GET", "/activity")).data.length > 5);

// AC-013 assistant (rule-based mode when no API key)
r = await call("POST", "/assistant/chat", { messages: [{ role: "user", content: "Show me the latest failed tests" }], projectId: project.id });
check("assistant: latest failures", r.status === 200 && /failures|No failed/.test(r.data.reply), r.data.reply.split("\n")[0]);
r = await call("POST", "/assistant/chat", { messages: [{ role: "user", content: "Run the contact tests" }], projectId: project.id });
check("assistant: starts a real run", r.data.actions.some((a) => a.status === "DONE" && a.link?.startsWith("/test-runs/")), r.data.reply);
const aiRun = (await call("GET", `/test-runs?projectId=${project.id}`)).data.find((x) => x.initiatedByAI);
check("AI-initiated run is attributed", Boolean(aiRun));

// AC-015 isolation
const other = await call("POST", "/auth/register", { fullName: "Eve Other", email: `eve+${Date.now()}@example.com`, password: "S3cure-pass!", organisationName: "Other Org" }, "");
const ot = other.data.token;
check("other workspace cannot read project", (await call("GET", `/projects/${project.id}`, undefined, ot)).status === 404);
check("other workspace cannot read evidence", (await fetch(`${API.replace(/\/api$/, "")}${shot.url}?token=${ot}`)).status === 404);
check("other workspace cannot read defect", (await call("GET", `/defects/${defect.id}`, undefined, ot)).status === 404);
check("other workspace sees empty dashboard", (await call("GET", "/dashboard", undefined, ot)).data.totals.projects === 0);

// Password reset + logout
r = await call("POST", "/auth/forgot-password", { email });
const resetToken = new URL(r.data.devResetLink).searchParams.get("token");
check("password reset", (await call("POST", "/auth/reset-password", { token: resetToken, password: "N3w-secure-pass" })).status === 200);
check("old session revoked after reset", (await call("GET", "/auth/me")).status === 401);

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
