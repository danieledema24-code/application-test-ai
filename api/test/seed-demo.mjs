// Fills an existing account with demo data from the DemoShop target (:4100).
// Usage: node test/seed-demo.mjs <email> <password>
const API = process.env.API_URL ?? "http://localhost:4000/api";
const TARGET = process.env.TARGET_URL ?? "http://localhost:4100";
const [email, password] = process.argv.slice(2);
if (!email || !password) throw new Error("Usage: node test/seed-demo.mjs <email> <password>");
let token = "";
const call = async (method, path, body) => {
  const res = await fetch(API + path, { method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path}: ${data?.error ?? res.status}`);
  return data;
};
const waitFor = async (path, done) => { for (;;) { const d = await call("GET", path); if (done(d)) return d; await new Promise((r) => setTimeout(r, 1500)); } };

token = (await call("POST", "/auth/login", { email, password })).token;
const project = await call("POST", "/projects", { name: "DemoShop", description: "Sample e-commerce app with known defects", applicationUrl: TARGET, applicationType: "WEB" });
const env = project.environments[0];
await call("PATCH", `/environments/${env.id}`, { authorised: true, credentials: { username: "qa.tester@example.com", password: "Passw0rd!demo", bearerToken: "demo-token-7f3a9c" } });
const { discoveryId } = await call("POST", `/projects/${project.id}/discovery`, { environmentId: env.id, maxPages: 10, useCredentials: true });
await waitFor(`/discovery/${discoveryId}`, (d) => ["COMPLETED", "FAILED"].includes(d.status));
const { generated } = await call("POST", `/projects/${project.id}/test-cases/generate`, { source: "DISCOVERY", count: 15 });
const ui = generated.filter((c) => /loads successfully|Main heading|Required field/i.test(c.title)).slice(0, 5);
await call("POST", "/test-cases/bulk-status", { ids: ui.map((c) => c.id), status: "APPROVED" });
const run = await call("POST", `/projects/${project.id}/test-runs`, { executionType: "AUTOMATED", environmentId: env.id, testCaseIds: ui.map((c) => c.id), name: "Smoke suite" });
await waitFor(`/test-runs/${run.id}`, (r) => !["QUEUED", "RUNNING"].includes(r.status));
await call("POST", `/projects/${project.id}/api-endpoints/import-openapi`, { spec: await (await fetch(`${TARGET}/openapi.json`)).text() });
const api = (await call("POST", `/projects/${project.id}/api-endpoints/generate-tests`, {})).generated;
await call("POST", "/test-cases/bulk-status", { ids: api.map((c) => c.id), status: "APPROVED" });
const apiRun = await call("POST", `/projects/${project.id}/test-runs`, { executionType: "API", environmentId: env.id, testCaseIds: api.map((c) => c.id), name: "API regression" });
const done = await waitFor(`/test-runs/${apiRun.id}`, (r) => !["QUEUED", "RUNNING"].includes(r.status));
for (const failed of done.results.filter((r) => r.status === "FAILED")) {
  const draft = await call("POST", `/test-results/${failed.id}/defect-draft`);
  await call("POST", "/defects", draft);
}
await call("POST", "/reports", { projectId: project.id, format: "PDF" });
console.log(`Seeded project ${project.name} (${project.id})`);
