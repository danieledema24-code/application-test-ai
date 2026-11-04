// Types mirror docs/API.md (contract v1). Keep in sync with the backend.

export type Role = "ADMIN" | "MEMBER";
export type User = { id: string; fullName: string; email: string; role: Role; organisationId: string; createdAt: string };
export type Organisation = { id: string; name: string; subscriptionPlan: string; createdAt: string };
export type AuthResponse = { token: string; user: User; organisation: Organisation };

export type AppType = "WEB" | "API";
export type EnvName = "DEVELOPMENT" | "STAGING" | "PRODUCTION";
export const ENV_NAMES: EnvName[] = ["DEVELOPMENT", "STAGING", "PRODUCTION"];

export type Environment = {
  id: string;
  projectId: string;
  name: EnvName;
  baseUrl: string;
  configuration: Record<string, unknown>;
  hasCredentials: boolean;
  /** v1.1: a remote Playwright browser server / cloud grid (wsEndpoint) is configured. */
  hasRemoteBrowser?: boolean;
  authorised: boolean;
  allowDestructive: boolean;
};

export type ProjectStats = {
  testCases: number;
  openDefects: number;
  lastRunAt: string | null;
  lastRunStatus: RunStatus | null;
  passRate: number | null;
};

export type Project = {
  id: string;
  name: string;
  description: string;
  applicationUrl: string;
  applicationType: AppType;
  createdAt: string;
  updatedAt: string;
  environments: Environment[];
  stats?: ProjectStats;
};

export type ProjectDetail = Project & {
  stats: ProjectStats;
  recentRuns: TestRun[];
  discovery: DiscoverySummary | null;
};

export type Category =
  | "FUNCTIONAL"
  | "POSITIVE"
  | "NEGATIVE"
  | "BOUNDARY"
  | "REGRESSION"
  | "UI"
  | "FORM_VALIDATION"
  | "AUTHENTICATION"
  | "ACCESSIBILITY"
  | "API";
export const CATEGORIES: Category[] = [
  "FUNCTIONAL",
  "POSITIVE",
  "NEGATIVE",
  "BOUNDARY",
  "REGRESSION",
  "UI",
  "FORM_VALIDATION",
  "AUTHENTICATION",
  "ACCESSIBILITY",
  "API",
];
export type Priority = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
export const PRIORITIES: Priority[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
export type CaseStatus = "DRAFT" | "APPROVED" | "READY" | "DEPRECATED";
export const CASE_STATUSES: CaseStatus[] = ["DRAFT", "APPROVED", "READY", "DEPRECATED"];
export type TestStep = { action: string; expected?: string };

export type TestCase = {
  id: string;
  key: string;
  projectId: string;
  title: string;
  description: string;
  preconditions: string;
  steps: TestStep[];
  expectedResult: string;
  category: Category;
  priority: Priority;
  status: CaseStatus;
  source: "AI" | "MANUAL" | "IMPORT";
  aiGenerated: boolean;
  version: number;
  lastResult: ResultStatus | null;
  hasScript: boolean;
  createdAt: string;
  updatedAt: string;
};

export type Script = {
  id: string;
  testCaseId: string;
  testCaseVersion: number;
  version: number;
  /** v1.1 scripts are Playwright Test specs ("playwright-test"); older versions may be "typescript"/"javascript". */
  language: "playwright-test" | "typescript" | "javascript";
  code: string;
  createdAt: string;
  createdBy: string | { id: string; fullName: string } | null;
};

export type TestCaseDetail = TestCase & { scripts: Script[]; history: TestResult[] };

export type RunStatus =
  | "QUEUED"
  | "RUNNING"
  | "PASSED"
  | "FAILED"
  | "ERROR"
  | "CANCELLED"
  | "IN_PROGRESS"
  | "COMPLETED";
export const RUN_STATUSES: RunStatus[] = [
  "QUEUED",
  "RUNNING",
  "IN_PROGRESS",
  "PASSED",
  "FAILED",
  "ERROR",
  "CANCELLED",
  "COMPLETED",
];
export type ResultStatus = "PASSED" | "FAILED" | "BLOCKED" | "NOT_EXECUTED" | "ERROR";
export type ExecType = "MANUAL" | "AUTOMATED" | "API" | "DISCOVERY";
export const EXEC_TYPES: ExecType[] = ["MANUAL", "AUTOMATED", "API", "DISCOVERY"];

export type Person = { id: string; fullName: string };

export type RunSummary = {
  total: number;
  passed: number;
  failed: number;
  blocked: number;
  notExecuted: number;
  error: number;
  passRate: number | null;
  durationMs: number | null;
};

export type TestRun = {
  id: string;
  key: string;
  projectId: string;
  projectName: string;
  name: string;
  executionType: ExecType;
  environmentId: string;
  environmentName: string;
  status: RunStatus;
  initiatedBy: Person | null;
  initiatedByAI: boolean;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  summary: RunSummary;
};

export type StepResult = { index: number; status: ResultStatus; note?: string; actual?: string; label?: string; durationMs?: number };

export type FailureAnalysis = {
  hypothesis: true;
  classification: "APPLICATION" | "SCRIPT" | "ENVIRONMENT" | "NETWORK" | "FLAKY" | "UNKNOWN";
  confidence: "LOW" | "MEDIUM" | "HIGH";
  summary: string;
  possibleCauses: string[];
  suggestedNextSteps: string[];
  generatedBy: "claude" | "heuristic";
};

export type EvidenceType =
  | "SCREENSHOT"
  | "VIDEO"
  | "TRACE"
  | "CONSOLE_LOG"
  | "NETWORK_LOG"
  | "ATTACHMENT"
  | "NOTE";

export type Evidence = {
  id: string;
  testRunId: string;
  testResultId: string;
  fileType: EvidenceType;
  name: string;
  url: string;
  mimeType: string;
  size: number;
  createdAt: string;
};

export type ApiAssertion = { name: string; passed: boolean; message: string };
export type ApiExchange = {
  request: { method: string; url: string; headers: Record<string, string>; body?: unknown };
  response: { status: number; headers: Record<string, string>; body: unknown; timeMs: number } | null;
  assertions: ApiAssertion[];
};

export type TestResult = {
  id: string;
  testRunId: string;
  testCaseId: string;
  testCaseKey: string;
  testCaseTitle: string;
  status: ResultStatus;
  actualResult: string | null;
  errorMessage: string | null;
  durationMs: number | null;
  scriptVersion: number | null;
  stepResults: StepResult[];
  executedBy: Person | null;
  executedAt: string | null;
  failureAnalysis: FailureAnalysis | null;
  evidence: Evidence[];
  apiExchange: ApiExchange | null;
  defectId: string | null;
  // Not in the contract's TestResult type, but useful if the backend includes it.
  steps?: TestStep[];
  note?: string | null;
};

export type TestRunDetail = TestRun & { results: TestResult[]; environment: Environment | null };

export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
export const SEVERITIES: Severity[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
export type DefectStatus = "OPEN" | "IN_PROGRESS" | "FIXED" | "RETEST_REQUIRED" | "CLOSED" | "REOPENED";
export const DEFECT_STATUSES: DefectStatus[] = [
  "OPEN",
  "IN_PROGRESS",
  "FIXED",
  "RETEST_REQUIRED",
  "CLOSED",
  "REOPENED",
];

export type Defect = {
  id: string;
  key: string;
  projectId: string;
  projectName: string;
  testResultId: string | null;
  testCaseId: string | null;
  testCaseKey: string | null;
  title: string;
  description: string;
  severity: Severity;
  priority: Priority;
  status: DefectStatus;
  environmentName: string;
  reproductionSteps: string[];
  expectedResult: string;
  actualResult: string;
  aiAnalysis: FailureAnalysis | null;
  evidence: Evidence[];
  createdBy: Person | null;
  createdAt: string;
  updatedAt: string;
};

export type DefectDraft = Partial<
  Pick<
    Defect,
    | "title"
    | "description"
    | "severity"
    | "priority"
    | "reproductionSteps"
    | "expectedResult"
    | "actualResult"
    | "environmentName"
    | "testResultId"
    | "projectId"
  >
>;

export type Report = {
  id: string;
  projectId: string;
  projectName: string;
  testRunId: string | null;
  reportType: "RUN" | "PROJECT";
  format: "PDF" | "CSV";
  title: string;
  createdAt: string;
  createdBy: Person | null;
  downloadUrl: string;
};

export type Activity = {
  id: string;
  type: string;
  message: string;
  projectId: string | null;
  projectName: string | null;
  actor: Person | null;
  viaAI: boolean;
  link: string | null;
  createdAt: string;
};

export type DashboardData = {
  totals: { projects: number; testsExecuted: number; passRate: number | null; openDefects: number };
  latestRun: TestRun | null;
  recentProjects: Project[];
  quickStats?: unknown;
};

export type TrendPoint = { date: string; passed: number; failed: number; blocked: number; other: number };

export type DiscoveryPage = {
  url: string;
  title: string;
  status: number | null;
  depth: number;
  links: string[];
  buttons: string[];
  forms: { action: string; method: string; fields: { name: string; type: string; label: string; required: boolean }[] }[];
  navItems: string[];
  screenshotEvidenceId: string | null;
};

export type DiscoverySummary = {
  id: string;
  projectId: string;
  environmentId: string;
  status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED";
  startedAt: string | null;
  completedAt: string | null;
  pages: DiscoveryPage[];
  inaccessible: { url: string; reason: string }[];
  authRequired: boolean;
  limitations: string[];
  workflows: { name: string; steps: string[] }[];
  summary: string;
  coverageNote: string;
};

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export const HTTP_METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];
export type ApiAuth = "NONE" | "BEARER" | "API_KEY" | "BASIC";
export const API_AUTHS: ApiAuth[] = ["NONE", "BEARER", "API_KEY", "BASIC"];

export type ApiEndpoint = {
  id: string;
  projectId: string;
  name: string;
  method: HttpMethod;
  path: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
  auth: ApiAuth;
  expectedStatus: number;
  maxResponseMs: number;
  requiredFields: string[];
  jsonSchema: unknown | null;
};

export type AssistantAction = {
  id: string;
  tool: string;
  label: string;
  status: "DONE" | "FAILED" | "NEEDS_CONFIRMATION";
  projectName?: string;
  detail: string;
  link?: string;
};

export type ChatMessage = { role: "user" | "assistant"; content: string };
export type AssistantResponse = { reply: string; actions: AssistantAction[]; aiEnabled: boolean };
export type AiStatus = { enabled: boolean; model: string | null };

export type Integration = {
  id: string;
  provider: "GITHUB" | "GITLAB" | "JIRA";
  connectionStatus: string;
  config: { baseUrl?: string; projectKey?: string; repo?: string };
  createdAt: string;
};

export const WEBHOOK_EVENTS = [
  "run.started",
  "run.completed",
  "test.failed",
  "defect.created",
  "report.generated",
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
export type Webhook = { id: string; url: string; events: WebhookEvent[]; secret?: string; active: boolean; createdAt?: string };
export type WebhookDelivery = { id: string; event: string; statusCode: number | null; success: boolean; createdAt: string };

export type AuditEntry = {
  id: string;
  action: string;
  actor: Person | string | null;
  target: string | null;
  metadata: unknown;
  createdAt: string;
};

export type SearchResults = {
  projects: { id: string; name: string }[];
  testCases: { id: string; key: string; title: string; projectId: string }[];
  defects: { id: string; key: string; title: string }[];
  runs: { id: string; key: string; name: string }[];
};

export type Notification = { id: string; title: string; body: string; link: string | null; read: boolean; createdAt: string };
