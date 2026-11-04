# Application Test AI — REST API contract (v1)

Base URL: `http://localhost:4000/api`. All bodies are JSON. All timestamps ISO-8601 strings.
Auth: `POST /auth/login` / `/auth/register` return `{ token, user, organisation }`. Send
`Authorization: Bearer <token>` on every other request. 401 → redirect to /login.
Errors: `{ error: string, details?: any }` with a 4xx/5xx status.
Every resource is scoped to the caller's organisation (workspace); cross-workspace IDs return 404.

## Shared types

```ts
type Role = "ADMIN" | "MEMBER";
type User = { id; fullName; email; role: Role; organisationId; createdAt };
type Organisation = { id; name; subscriptionPlan; createdAt };

type AppType = "WEB" | "API";
type EnvName = "DEVELOPMENT" | "STAGING" | "PRODUCTION";
type Environment = { id; projectId; name: EnvName; baseUrl; configuration: Record<string, any>;
  hasCredentials: boolean; // credentials are write-only, never returned
  authorised: boolean;     // user confirmed they are authorised to test this target
  allowDestructive: boolean }; // PRODUCTION defaults false (read-only)

type Project = { id; name; description; applicationUrl; applicationType: AppType; createdAt; updatedAt;
  environments: Environment[];
  stats?: { testCases; openDefects; lastRunAt: string | null; lastRunStatus: RunStatus | null; passRate: number | null } };

type Category = "FUNCTIONAL" | "POSITIVE" | "NEGATIVE" | "BOUNDARY" | "REGRESSION" | "UI" | "FORM_VALIDATION" | "AUTHENTICATION" | "ACCESSIBILITY" | "API";
type Priority = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
type CaseStatus = "DRAFT" | "APPROVED" | "READY" | "DEPRECATED";
type TestStep = { action: string; expected?: string };
type TestCase = { id; key: string /* e.g. TC-0012 */; projectId; title; description; preconditions;
  steps: TestStep[]; expectedResult; category: Category; priority: Priority; status: CaseStatus;
  source: "AI" | "MANUAL" | "IMPORT"; aiGenerated: boolean; version: number;
  lastResult: ResultStatus | null; hasScript: boolean; createdAt; updatedAt };

type Script = { id; testCaseId; testCaseVersion; version; language: "typescript" | "javascript"; code; createdAt; createdBy };

type RunStatus = "QUEUED" | "RUNNING" | "PASSED" | "FAILED" | "ERROR" | "CANCELLED" | "IN_PROGRESS" /* manual */ | "COMPLETED";
type ResultStatus = "PASSED" | "FAILED" | "BLOCKED" | "NOT_EXECUTED" | "ERROR";
type ExecType = "MANUAL" | "AUTOMATED" | "API" | "DISCOVERY";
type TestRun = { id; key: string /* RUN-0007 */; projectId; projectName; name; executionType: ExecType;
  environmentId; environmentName; status: RunStatus; initiatedBy: { id; fullName } ; initiatedByAI: boolean;
  startedAt; completedAt; createdAt;
  summary: { total; passed; failed; blocked; notExecuted; error; passRate: number | null; durationMs: number | null } };

type StepResult = { index: number; status: ResultStatus; note?: string; actual?: string };
type TestResult = { id; testRunId; testCaseId; testCaseKey; testCaseTitle; status: ResultStatus;
  actualResult; errorMessage; durationMs; scriptVersion: number | null; stepResults: StepResult[];
  executedBy: { id; fullName } | null; executedAt;
  failureAnalysis: FailureAnalysis | null; evidence: Evidence[]; apiExchange: ApiExchange | null; defectId: string | null };

type FailureAnalysis = { hypothesis: true; classification: "APPLICATION" | "SCRIPT" | "ENVIRONMENT" | "NETWORK" | "FLAKY" | "UNKNOWN";
  confidence: "LOW" | "MEDIUM" | "HIGH"; summary: string; possibleCauses: string[]; suggestedNextSteps: string[]; generatedBy: "claude" | "heuristic" };

type Evidence = { id; testRunId; testResultId; fileType: "SCREENSHOT" | "VIDEO" | "TRACE" | "CONSOLE_LOG" | "NETWORK_LOG" | "ATTACHMENT" | "NOTE";
  name; url: string /* GET with auth: /api/evidence/:id/file ; append ?token=<jwt> for <img> tags */; mimeType; size; createdAt };

type ApiExchange = { request: { method; url; headers: Record<string,string> /* secrets redacted */; body?: any };
  response: { status; headers; body; timeMs } | null; assertions: { name; passed: boolean; message }[] };

type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
type DefectStatus = "OPEN" | "IN_PROGRESS" | "FIXED" | "RETEST_REQUIRED" | "CLOSED" | "REOPENED";
type Defect = { id; key: string /* DEF-0003 */; projectId; projectName; testResultId; testCaseId; testCaseKey;
  title; description; severity: Severity; priority: Priority; status: DefectStatus; environmentName;
  reproductionSteps: string[]; expectedResult; actualResult; aiAnalysis: FailureAnalysis | null;
  evidence: Evidence[]; createdBy: { id; fullName }; createdAt; updatedAt };

type Report = { id; projectId; projectName; testRunId: string | null; reportType: "RUN" | "PROJECT";
  format: "PDF" | "CSV"; title; createdAt; createdBy: { id; fullName }; downloadUrl /* /api/reports/:id/download */ };

type Activity = { id; type: string /* RUN_PASSED, RUN_FAILED, DEFECT_CREATED, CASES_GENERATED, CASE_UPDATED, REPORT_GENERATED, DISCOVERY_COMPLETED, PROJECT_CREATED */;
  message; projectId; projectName; actor: { id; fullName } | null; viaAI: boolean; link: string | null /* frontend path */; createdAt };
```

## Auth / workspace
- `POST /auth/register` `{ fullName, email, password, organisationName }` → `{ token, user, organisation }` (first user is ADMIN)
- `POST /auth/login` `{ email, password }` → `{ token, user, organisation }`
- `POST /auth/logout` → 204 (token revoked)
- `GET /auth/me` → `{ user, organisation }`
- `POST /auth/forgot-password` `{ email }` → `{ ok: true, devResetLink?: string }` (always 200; dev link only in dev mode since no SMTP)
- `POST /auth/reset-password` `{ token, password }` → `{ ok: true }`
- `GET /workspace/members` → `User[]`; `POST /workspace/members` (ADMIN) `{ fullName, email, role, password }` → `User`; `PATCH /workspace/members/:id` (ADMIN) `{ role }`; `DELETE /workspace/members/:id` (ADMIN)
- `GET /workspace/audit-log?limit=` (ADMIN) → `{ id, action, actor, target, metadata, createdAt }[]`

## Dashboard
- `GET /dashboard` → `{ totals: { projects, testsExecuted, passRate: number|null, openDefects }, latestRun: TestRun|null, recentProjects: Project[] (with stats), quickStats }`
- `GET /dashboard/trend?days=7|30|90` → `{ date: "YYYY-MM-DD", passed, failed, blocked, other }[]` (one entry per day)
- `GET /activity?limit=20&projectId=` → `Activity[]`

## Projects
- `GET /projects?search=` → `Project[]` (with stats)
- `POST /projects` `{ name, description, applicationUrl, applicationType, environments?: { name, baseUrl }[] }` → `Project` (if none given, creates STAGING with applicationUrl)
- `GET /projects/:id` → `Project & { stats, recentRuns: TestRun[], discovery: DiscoverySummary|null }`
- `PATCH /projects/:id` `{ name?, description?, applicationUrl?, applicationType? }` → `Project`
- `DELETE /projects/:id` `{ confirmName }` body must equal project name → 204 (deletes all data + evidence files)
- `POST /projects/:id/environments` `{ name, baseUrl, configuration?, credentials?: { username?, password?, apiKey?, bearerToken? }, authorised: boolean, allowDestructive?: boolean }` → `Environment`
- `PATCH /environments/:id` same fields optional; `DELETE /environments/:id`

## Discovery
- `POST /projects/:id/discovery` `{ environmentId, maxPages?: number (default 15), useCredentials?: boolean }` → `{ discoveryId, runId }` (async; environment must be `authorised`, URL must pass SSRF guard)
- `GET /projects/:id/discovery` → latest `DiscoverySummary | null`
- `GET /discovery/:id` → `DiscoverySummary`
```ts
type DiscoverySummary = { id; projectId; environmentId; status: "QUEUED"|"RUNNING"|"COMPLETED"|"FAILED"; startedAt; completedAt;
  pages: { url; title; status: number|null; depth; links: string[]; buttons: string[]; forms: { action; method; fields: { name; type; label; required }[] }[]; navItems: string[]; screenshotEvidenceId: string|null }[];
  inaccessible: { url; reason }[]; authRequired: boolean; limitations: string[];
  workflows: { name; steps: string[] }[]; summary: string /* AI or heuristic; never claims full coverage */; coverageNote: string };
```

## Test cases
- `GET /projects/:id/test-cases?search=&category=&priority=&status=` → `TestCase[]`
- `POST /projects/:id/test-cases` (manual create) `{ title, description, preconditions, steps, expectedResult, category, priority }` → `TestCase`
- `POST /projects/:id/test-cases/generate` `{ source: "DISCOVERY" | "USER_STORY" | "REQUIREMENTS" | "DESCRIPTION" | "OPENAPI", text?: string, discoveryId?: string, categories?: Category[], count?: number }` → `{ generated: TestCase[], generatedBy: "claude"|"heuristic", notes: string }` (all created as DRAFT)
- `GET /test-cases/:id` → `TestCase & { scripts: Script[], history: TestResult[] }`
- `PATCH /test-cases/:id` fields → `TestCase` (content edits bump `version`)
- `POST /test-cases/:id/status` `{ status }` (approve = APPROVED, ready = READY)
- `POST /test-cases/bulk-status` `{ ids: string[], status }`
- `DELETE /test-cases/:id`
- `POST /test-cases/:id/regenerate` → `TestCase` (AI rewrite of this case, back to DRAFT)
- `POST /test-cases/:id/scripts/generate` `{ language?: "typescript" }` → `Script` (case must be APPROVED or READY)
- `PUT /test-cases/:id/scripts` `{ code }` → new `Script` version

## Test runs
- `GET /test-runs?projectId=&status=&type=&limit=` → `TestRun[]`
- `POST /projects/:id/test-runs` `{ executionType: "MANUAL"|"AUTOMATED"|"API", environmentId, testCaseIds: string[], name? }` → `TestRun`. AUTOMATED/API queue immediately; MANUAL starts IN_PROGRESS with NOT_EXECUTED results. Only APPROVED/READY cases allowed.
- `GET /test-runs/:id` → `TestRun & { results: TestResult[], environment: Environment }`
- `POST /test-runs/:id/cancel`
- `PATCH /test-results/:id` (manual) `{ status, stepResults?, actualResult?, errorMessage?, note? }` → `TestResult`
- `POST /test-results/:id/evidence` multipart `file` (+ optional `note`) → `Evidence`
- `POST /test-runs/:id/complete` (manual) → `TestRun`
- `POST /test-results/:id/analyse` → `FailureAnalysis` (stored on the result; labelled hypothesis)
- `GET /test-runs/compare?a=&b=` → `{ a: TestRun, b: TestRun, changes: { testCaseKey, title, from, to }[] }`
- `GET /evidence/:id/file` → binary

## API testing
- `GET /projects/:id/api-endpoints` → `ApiEndpoint[]`; `POST` create; `PATCH /api-endpoints/:id`; `DELETE /api-endpoints/:id`
```ts
type ApiEndpoint = { id; projectId; name; method: "GET"|"POST"|"PUT"|"PATCH"|"DELETE"; path; headers: Record<string,string>; query: Record<string,string>; body: any; auth: "NONE"|"BEARER"|"API_KEY"|"BASIC" /* values from env credentials */; expectedStatus; maxResponseMs; requiredFields: string[]; jsonSchema: any|null };
```
- `POST /projects/:id/api-endpoints/import-openapi` `{ spec: string /* JSON or YAML text */ }` → `{ imported: ApiEndpoint[] }`
- `POST /api-endpoints/:id/send` `{ environmentId }` → `ApiExchange` (ad-hoc request, Postman-like; DELETE/PUT/PATCH/POST against an env with allowDestructive=false returns 409 `{ error, requiresConfirmation: true }` unless `{ confirm: true }`)
- `POST /projects/:id/api-endpoints/generate-tests` `{ endpointIds?: string[] }` → `{ generated: TestCase[] }` (category API, each linked via `apiSpec` to an endpoint)

## Defects
- `GET /defects?projectId=&severity=&status=&environment=&from=&to=&search=` → `Defect[]`
- `POST /defects` `{ projectId, testResultId?, title, description, severity, priority, reproductionSteps, expectedResult, actualResult, environmentName }` → `Defect`
- `POST /test-results/:id/defect-draft` → draft defect fields pre-filled from the failure (+AI description), not saved
- `GET /defects/:id`, `PATCH /defects/:id` (any fields incl. status), `DELETE /defects/:id`
- `POST /ai/defect-from-notes` `{ projectId, notes }` → draft defect fields

## Reports
- `GET /reports?projectId=` → `Report[]`
- `POST /reports` `{ projectId, testRunId?: string, format: "PDF"|"CSV" }` → `Report`
- `GET /reports/:id/download` → file (supports `?token=`)

## AI assistant
- `POST /assistant/chat` `{ messages: { role: "user"|"assistant", content: string }[], projectId?: string, confirmations?: string[] /* pendingAction ids user approved */ }` →
  `{ reply: string, actions: { id, tool, label, status: "DONE"|"FAILED"|"NEEDS_CONFIRMATION", projectName?, detail, link? }[], aiEnabled: boolean }`
  Actions with NEEDS_CONFIRMATION must be shown with Confirm/Cancel; confirming re-sends the same messages plus `confirmations:[id]`.
- `GET /ai/status` → `{ enabled: boolean, model: string | null }`

## Integrations
- `GET /integrations` → `{ id, provider: "GITHUB"|"GITLAB"|"JIRA", connectionStatus, config: { baseUrl?, projectKey?, repo? }, createdAt }[]`
- `POST /integrations` `{ provider, config, token }` (token encrypted at rest) ; `DELETE /integrations/:id`
- `GET /webhooks` / `POST /webhooks` `{ url, events: ("run.started"|"run.completed"|"test.failed"|"defect.created"|"report.generated")[] }` → `{ id, url, events, secret (shown once), active }` ; `DELETE /webhooks/:id`
- `GET /webhooks/:id/deliveries` → `{ id, event, statusCode, success, createdAt }[]`

## Search / notifications
- `GET /search?q=` → `{ projects: {id,name}[], testCases: {id,key,title,projectId}[], defects: {id,key,title}[], runs: {id,key,name}[] }`
- `GET /notifications` → `{ id, title, body, link, read, createdAt }[]`; `POST /notifications/read-all`
