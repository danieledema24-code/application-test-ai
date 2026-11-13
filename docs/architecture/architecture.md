# Architecture

## 1. System overview

```mermaid
flowchart LR
  subgraph Browser
    UI[web/ Next.js :3002]
  end
  subgraph backend/ :8200
    API[FastAPI REST + SSE]
    ORCH[Lead QA Orchestrator<br/>deterministic state machine]
    AG[Specialist agents A-I]
    LLM[LLM provider interface<br/>Claude / Disabled]
    Q[(Job queue interface)]
    W[Worker<br/>asyncio, inline or separate process]
    BW[Browser worker<br/>Playwright Python, Chromium]
    EX[Execution engine<br/>Node toolkit automation/ - Phase 4]
    REP[Reporting<br/>Jinja2 HTML -> PDF]
  end
  DB[(SQLite now / PostgreSQL)]
  ST[(Object storage<br/>local FS now / S3)]
  TGT[[Target website<br/>UNTRUSTED]]
  UI -- REST / SSE --> API
  API --> DB
  API -- enqueue --> Q
  Q --> W --> ORCH --> AG
  AG --> LLM
  AG --> BW -- SSRF-guarded --> TGT
  AG --> EX -- SSRF-guarded --> TGT
  AG --> REP
  W --> DB
  BW --> ST
  REP --> ST
```

### Module boundaries

| Module | Owns | May call | Must not |
|---|---|---|---|
| `web/` | Presentation, client state | REST + SSE only | Hold secrets; compute report numbers |
| `api/` (routers) | HTTP, auth, validation, mapping DTOs | services | Touch Playwright, LLM or storage internals directly; run long work inline (> 2 s) |
| `services/` | Use cases (create project, decide gate, regenerate stage) | repositories, queue, orchestrator commands | Bypass the tenant scope |
| `orchestrator/` | Stage order, gate enforcement, dedupe, pause/resume, stale propagation | agents, repositories, event bus | Call the LLM; make decisions from free text |
| `agents/` | One QA responsibility each, typed in/out | tools granted in its permission set, LLM interface | Write outside their own artefact tables; approve gates |
| `llm/` | Provider adapters, prompt assembly, untrusted-content wrapping, output validation | provider SDK | Receive secrets (redaction runs first) |
| `browser/` | Isolated contexts, network policy, capture | Playwright | Navigate without SSRF policy |
| `queue/` | Job persistence, claiming, retries, cancellation | DB | Contain business logic |
| `storage/` | Blobs (screenshots, DOM, traces, reports) | FS / S3 | Serve files without tenant check (API does that) |
| `reports/` | Rendering artefacts into HTML/PDF (later DOCX/XLSX/CSV) | repositories, storage | Let the LLM author numbers |
| `automation/` (Node, Phase 4) | TS spec validation (tsc, eslint, spec-guard), Playwright Test runs | `@playwright/test` | Access network beyond policy |

**Key principle: "LLM proposes, code disposes."** The orchestrator is code. LLM output is data that must pass Pydantic validation plus domain validation (evidence ids exist, provenance rules, no duplicate ids) before it is stored. No LLM output can change workflow state, permissions or approvals.

## 2. Lead QA Orchestrator

A deterministic service (`orchestrator/orchestrator.py`) driven by jobs:

- `advance(project_id)`: finds the next runnable stage (all upstream stages `completed`/`approved`, gate not blocking, project not paused) and enqueues an `agent_task` for it. Idempotent: a unique `(project_id, stage_key, status in queued/running)` guard prevents duplicate tasks.
- `run_stage(task_id)`: builds the agent's typed input from the **current** approved upstream versions and the project context pack, calls the agent, validates the output, persists it as a new `stage_run` version, emits events, evaluates the stage's quality gate.
- `regenerate(stage)`, `pause()`, `resume()`, `cancel()`: commands from the API (see §4).
- Conflict control: one running task per project per stage; artefacts written only by their owning agent; regenerate creates a new version and marks downstream stages `stale` instead of overwriting.

## 3. Specialist agents

Common contract (`agents/base.py`):

```python
class Agent(Protocol[In, Out]):
    key: AgentKey                      # e.g. "discovery"
    input_model: type[In]              # Pydantic, extra="forbid"
    output_model: type[Out]            # Pydantic, extra="forbid"
    tools: frozenset[ToolName]         # enforced by ToolRegistry, not by the prompt
    async def run(self, inp: In, ctx: AgentContext) -> Out: ...
    def validate(self, out: Out, ctx: AgentContext) -> list[ValidationIssue]: ...  # domain rules
```

`AgentContext` carries: tenant scope, project context pack (§6), `EventEmitter`, `EvidenceWriter`, `LLMClient` (may be `DisabledLLM`), cancellation token, budgets (time, tokens, pages).

Every AI-produced item carries `provenance ∈ {observed, inferred, assumed, unverified}`, `confidence ∈ [0,1]`, `evidence_refs: list[EvidenceRef]`, `generated_by ∈ {ai, rules, human}`.

Shared error handling for every agent:
1. LLM output fails Pydantic or domain validation → one repair attempt with the validation errors appended → if still invalid, rule-based fallback (labelled `generated_by=rules`) or, where no fallback exists, stage `failed` with a user-readable reason.
2. Tool error → retried by the tool's own policy (navigation: 1 retry; LLM: 2 retries with backoff on 429/5xx/overloaded).
3. Timeout/budget exhausted → partial output saved with explicit `limitations`, stage `completed` with `partial=true` (never silently truncated).
4. Cancellation checked between units of work; partial evidence is kept.

### Agent contracts

| Agent | Phase | Input (key fields) | Output (key fields) | Tools allowed | Validation rules |
|---|---|---|---|---|---|
| **A. Application Discovery** | 1 | `DiscoveryInput{scan_session_id, start_url, allowed_hosts[], limits{max_pages≤100, max_depth≤5, page_timeout_s, total_timeout_s, viewports[]}, respect_robots, credentials_ref?(P2)}` | `DiscoveryOutput{pages[], sitemap(tree), features[FeatureCandidate], journeys[JourneyCandidate], auth_boundaries[], access_gaps[], console_issues[], network_issues[], completeness{score 0-100, rating, reasons[]}, limitations[], generated_by}` | `browser.navigate` (same-site, policy-checked), `browser.extract`, `browser.aria_snapshot`, `browser.screenshot`, `browser.capture_console/network`, `http.probe` (robots.txt, sitemap.xml), `evidence.write`, `kb.propose`. **No clicks that submit, no form fills** (P1). LLM: no tools. | Every feature/journey references existing `page_id`s and evidence from this scan; `observed` needs ≥1 evidence ref else downgraded to `unverified`; journeys use only discovered pages; names deduped; LLM-suggested URLs ignored unless already discovered. |
| **B. Requirements Engineering** | 2 | Current discovery output, KB, optional uploaded docs (untrusted), prior user edits/rejections | `RequirementSet{requirements[Requirement §6 fields], acceptance_criteria[GWT], definition_of_ready[], definition_of_done[]}` | `artefact.read(discovery)`, `evidence.read`, `kb.read`, `kb.propose` | IDs unique/stable across regen (match by feature + title); classification enum; backend/data-integrity behaviour may never be `observed`; each requirement ≥1 AC; human-edited requirements are locked (regen proposes diffs, never overwrites). |
| **C. Test Strategy** | 2 | Approved requirements, features, risk inputs, project constraints (environments, approval policy) | `TestStrategy{scope_in/out, levels[], types[], techniques_by_feature, entry/exit criteria, environments, test_data_approach}` plus a separate `risks` table (the risk register, one row per risk). `TestPlan{items, approach, deliverables, suspension/resumption, roles}` is generated in code **after G4** from the approved strategy, not by the agent. | `artefact.read`, `kb.read` | Risk score = likelihood × impact computed in code; every high risk mapped to ≥1 test type; performance/security/load items flagged `requires_approval`. |
| **D. Test Design** | 3 | Approved strategy, requirements + AC, discovered forms/constraints | `TestConditions[]`, `TestCases[§7 fields]`, `TestDataSets[]` | `artefact.read`, `kb.read`, `evidence.read` | Each case links ≥1 requirement (else flagged orphan); BVA/EP values derived in code from discovered `min/max/maxlength/pattern/required`; duplicate detection; every step has an expected result; Gate 5 lint. |
| **E. Test Automation Engineer** | 4 | Approved, automatable test cases; page model (discovered elements + locator candidates); conventions | `AutomationBundle{page_objects[], fixtures, factories, specs[{test_case_id, path, code}], config, ci_templates}` | `ts.validate` (tsc, eslint, spec-guard, secret scan), `locator.verify` (read-only, policy-checked), `artefact.read` | Static validation must pass; spec titles carry test case ID; no `waitForTimeout`, no hardcoded secrets, locator preference order (getByRole > Label > Placeholder > Text > TestId > CSS); up to 3 repair loops, then rule-based translator (ported `scriptgen`). |
| **F. Test Execution** | 4 | Gate-7-approved `RunRequest{script_versions[], environment, browsers[], viewports[], workers, retries, destructive_allowed}` | `ExecutionRun`, `ExecutionResults[]` with evidence (trace, video, screenshots, console, network) | `runner.execute` (sandboxed subprocess), `evidence.write` | No LLM. Results only from Playwright JSON reporter; never synthesised; script version pinned per result. |
| **G. Performance Testing** | 5 | Approved `PerfProfile{type, vus, ramp, duration, thresholds, max_rps, target}` + authorisation | `k6 script`, `PerformanceRun{p50/p90/p95/p99, rps, error_rate, thresholds[]}` | `k6.generate`, `k6.run` | Profile ≤ org hard ceilings (code-enforced); target must be an authorised project URL; auto-abort on error-rate/latency kill switch. |
| **H. Defect Analysis** | 4 | Failed/errored results, evidence, history, script, test case | `FailureAnalysis{classification(application_defect, script_defect, selector_failure, test_data_issue, environment_failure, network_failure, flaky, unknown), confidence, evidence_refs, reasoning, heal_suggestions[], defect_draft?}` | `evidence.read`, `artefact.read`, `runner.rerun_once` (flake check) | Defect draft only for `application_defect` and status `draft` until Gate 8; heal suggestion diff rejected if it changes any assertion expected value (AST compare). |
| **I. QA Reporting & Release Assessment** | 5–6 | All approved artefacts + metrics computed in code | Reports (§17 list), `ReleaseReadiness{recommendation(go/conditional/no_go), exit_criteria_eval[], open_risks[], residual_risk}` | `artefact.read`, `metrics.compute`, `report.render` | All numbers come from `metrics.compute`; LLM writes narrative only, with placeholders for figures; recommendation is advisory and needs Gate 9. |

The **AI QA Assistant** (spec §16, from Phase 2; test-design intents in Phase 3) is not a tenth specialist: it is a tool-calling conversational layer whose tools map to orchestrator commands and read-only queries (the same service functions the REST API uses, as in the old `actions.ts`). It cannot approve gates or report results that are not in the database.

## 4. URL-to-QA workflow as a stage state machine

### Stages (spec §5 steps grouped)

| # | Stage key | Spec steps | Agent | Gate after | Phase |
|---|---|---|---|---|---|
| 1 | `intake` | 1–2 URL validation, accessibility, project creation | orchestrator (code) | **G1** URL validation & authorisation | 1 |
| 2 | `discovery` | 3–7 browser session, inspection, sitemap/feature map, evidence, access gaps | A | **G2** Discovery completeness | 1 |
| 3 | `discovery_report` | 8 | I (template + optional AI narrative) | – | 1 |
| 4 | `requirements` | 9–10 | B | **G3** Requirements review | 2 |
| 5 | `readiness_criteria` | 11 DoR/DoD | B | (part of G3) | 2 |
| 6 | `test_strategy` | 12 strategy + plan | C | **G4** Strategy approval | 2 |
| 7 | `test_design` | 13 | D | **G5** Test case quality | 3 |
| 8 | `traceability` | 14 (derived, recomputed on change) | code | – | 3 |
| 9 | `automation_assessment` | 15 | D/E | – | 4 |
| 10 | `automation` | 16–17 | E | **G6** Script validation | 4 |
| 11 | `execution` | 18 | F | **G7** Execution authorisation (before) | 4 |
| 12 | `failure_analysis` | 19 | H | – | 4 |
| 13 | `defects_summary` | 20 | H + I | **G8** Defect review | 4 |
| 14 | `release_readiness` | 21 | I | **G9** Release readiness | 6 |
| – | `performance` (optional branch after G4) | §9 | G | approval before run | 5 |

### Stage status machine

```mermaid
stateDiagram-v2
  [*] --> not_started
  not_started --> queued: advance()
  queued --> running: worker claims task
  running --> awaiting_approval: output valid, gate requires approval
  running --> completed: output valid, gate auto/recommended
  running --> failed: unrecoverable error
  running --> paused: pause() (checkpoint reached)
  queued --> paused: pause()
  paused --> queued: resume()
  awaiting_approval --> approved: gate decision = approve
  awaiting_approval --> changes_requested: decision = reject / request changes
  changes_requested --> queued: regenerate()
  failed --> queued: retry / regenerate()
  completed --> stale: upstream stage regenerated
  approved --> stale: upstream stage regenerated
  stale --> queued: regenerate()
  completed --> queued: regenerate()
  approved --> queued: regenerate()
  state "candidate run (review_status)" as candidate {
    pending_review --> applied: review/apply
    pending_review --> discarded: review/discard
  }
  completed --> candidate: regenerate() with existing output (P2)
  approved --> candidate: regenerate() with existing output (P2)
```

Candidate runs (Phase 2, `requirements` / `readiness_criteria` / `test_strategy`): regenerating a stage that already has output writes a new `stage_run` with `review_status = pending_review`; the stage's current pointer and status do not move until the user applies the change review (then the run becomes current, `applied`) or discards it (`discarded`, kept in history). The first generation applies directly. Applying a change to an approved stage reopens its gate; downstream keeps the last approved version until re-approval with a different snapshot marks it `stale`.

Rules:
- **Persisted**: `workflow_stages` holds the current status per project+stage; each execution is a `stage_runs` row (version n) with input snapshot hash, output, validation issues, timings, `generated_by`. The stage points at its `current_stage_run_id`.
- **Regenerate one stage**: new `stage_run` (version n+1) from current upstream versions; earlier versions stay readable. Downstream stages become `stale` (not deleted, not auto-rerun); the UI offers "regenerate downstream".
- **Pause** is cooperative: agents check the cancellation/pause token between units (e.g. between pages). Paused discovery resumes from its persisted frontier (`scan_sessions.frontier`).
- **Project-level pause** stops `advance()` from enqueuing anything new.
- **Restart safety**: on worker start, tasks `running` with an expired heartbeat return to `queued` (resumable stages) or `failed` with "interrupted" (non-resumable).

### Quality gates

`projects.approval_policy` maps each gate to `required | recommended | auto`. Defaults and locks:

| Gate | Default | Can be relaxed? | Blocks |
|---|---|---|---|
| G1 URL validation & authorisation | required | **No** (user attests authorisation to test; automated checks must pass) | Any browser activity |
| G2 Discovery completeness | recommended | yes | Requirements (if set to required) |
| G3 Requirements review | required | yes | Strategy |
| G4 Strategy approval | required | yes | Test design; performance branch |
| G5 Test case quality | required (user decision D1, Phase 3; `can_approve`, same as G3/G4; automated lint always runs) | yes | Automation |
| G6 Script validation | required (static validation always runs) | yes (human part only) | Execution |
| G7 Execution authorisation | required | **No** | Any execution against the target |
| G8 Defect review | required | **No** (spec §11: human confirms application defects) | Defect status `verified` |
| G9 Release readiness | required | **No** | Release recommendation becoming `final` |

Additional per-action approvals from spec §19 (destructive actions, external transactions, load tests, security tests, real user data) are separate `approvals` records, never covered by a gate policy. With `recommended`, the stage completes and the UI shows the agent's recommendation; with `required`, the stage stops at `awaiting_approval`. Gate decisions are recorded in `gate_decisions` and the audit log; an agent may write a `recommendation` but never a decision.

## 5. Evidence model

- `evidence` row = one immutable captured artefact: `kind ∈ {screenshot, dom_snapshot, aria_snapshot, console_log, network_log, http_response, page_text, trace, video, k6_summary, axe_result, lighthouse_result, report_render}`, `storage_key`, `sha256`, `mime`, `size`, `source_url`, `viewport`, `captured_at`, owning `scan_session_id` / `execution_result_id` / `performance_run_id`.
- `EvidenceRef{evidence_id, selector?, excerpt? (≤300 chars), note?}` is embedded (JSON) in every claim-bearing artefact item (feature, journey, requirement, AC, case, defect).
- Validation rule enforced in code: references must resolve to evidence in the same project; `observed` claims without a resolvable ref are downgraded to `unverified` and the downgrade is logged as a validation issue.
- Evidence is never deleted by workflow operations (spec §13). Project deletion is a soft archive; hard purge is an admin action (Phase 5) with an audit record.
- Sensitive capture rules: password fields masked in screenshots; DOM snapshots strip `value` attributes of password/hidden inputs; console/network text passes through `redact`.

## 6. Project knowledge base and memory

- `knowledge_items` table: `kind ∈ {fact, glossary, assumption, decision, constraint, user_note}`, `content`, `provenance`, `evidence_refs`, `source (agent key | user id)`, `status (proposed/active/superseded/rejected)`, `version`.
- Agents only **propose** items; facts with evidence from discovery are auto-activated, everything else needs a user (or gate approval) to activate. User decisions at gates (e.g. "reject REQ-0004: this is not a feature") become `decision` items so regeneration respects them.
- **Context pack**: the orchestrator assembles a budgeted, deterministic summary for each agent call: project profile, active facts/decisions/constraints, current upstream artefacts (IDs + titles + short fields), never raw page HTML. Token budget per agent configured in code.
- Search: SQL `LIKE` now; Postgres full-text in production; embeddings (pgvector) only if needed in Phase 6.

## 7. Untrusted content isolation and prompt injection

Website content (text, attributes, titles, console messages, uploaded docs) is **data, never instructions**:

1. **Channel separation**: system prompt holds rules and the output schema; untrusted content goes only in the user turn inside `<untrusted_website_content source="evidence:<id>">…</untrusted_website_content>` blocks, after normalisation (strip zero-width/bidi control chars, collapse whitespace, truncate per field, drop `<script>/<style>` text). The system prompt states that instructions inside those blocks must be ignored and reported.
2. **Capability limits**: LLM calls that see website content have **no tools** (Discovery, Requirements, Strategy, Design) or only read-only tools. Side-effecting actions (navigate, execute, approve) are performed by code from validated structured output; the navigation allow-list is computed by code, never by the LLM.
3. **Output validation**: strict Pydantic schemas (`extra="forbid"`), evidence-ref resolution, length limits, enum checks; URLs in output must already exist in the scan.
4. **Detection**: a heuristic scanner flags injection-like strings (e.g. "ignore previous instructions", hidden text addressed to AI) on discovered pages; findings are stored as `knowledge_items(kind=fact)` with evidence and shown in the discovery report. Detection is informational; isolation is the control.
5. **Secret hygiene**: credentials and tokens never enter prompts (redaction + secrets referenced by id only).
6. **Browser isolation**: fresh incognito context per scan, no persistent profile, downloads disabled, permissions (geolocation, notifications, camera) denied, service workers blocked, Chromium sandbox on (no `--no-sandbox`).

## 8. Browser worker (Phase 1)

- `browser/session.py`: `BrowserPool` (one Chromium per worker process, max N contexts, from config) and `IsolatedSession` (context per scan: viewport, UA, `accept_downloads=False`, `service_workers="block"`, `java_script_enabled=True`, timeouts).
- `browser/network_policy.py`: `context.route("**/*")` handler: allow `data:`/`blob:`; block non-http(s); block metadata hosts; resolve host (cached per scan) and block private/reserved addresses unless `ALLOW_PRIVATE_TARGETS` (dev/test only); top-level navigations restricted to approved hosts; redirects validated hop by hop (navigation requests fetched with `route.fetch(max_redirects=0)`, each `Location` checked) and the final URL re-checked after `goto`. Blocked requests are recorded.
- Capture per page: screenshot (desktop; mobile 390×844 for the first `mobile_sample` pages), DOM extraction JSON, ARIA snapshot (`locator("body").aria_snapshot()`), console errors/warnings, failed requests and 4xx/5xx responses, timing.
- Limits: `max_pages` (default **30**, cap 100), `max_depth` (default 3), page timeout 20 s, total scan timeout **20 min**, 500 ms politeness delay, single page at a time per scan, max 2 concurrent scans per org (configurable), DOM extract capped at 2 MB. robots.txt respected by default. (Lead decisions; the original 25 pages / 10 min were raised.)
- Implementation note (Phase 1): Playwright does **not** route requests created by following a redirect, so the policy fetches every routed request itself with `route.fetch(max_redirects=0)` and validates each `Location` hop. A redirected top-level navigation is aborted and recorded; the crawler then navigates to the validated target itself. `ALLOW_PRIVATE_TARGETS` only lets the scanner reach the approved target origin (scheme+host+port) and only when it is on loopback (127.0.0.0/8, ::1); other loopback ports, LAN and link-local addresses stay blocked, and metadata addresses are always blocked.
- Interaction (lead decision): discovery may use a search box with the harmless term `test` (GET forms only) and follow pagination/filter links; it never submits forms that send, create, change or delete data and never clicks buttons. Password field values are removed from DOM and ARIA evidence and masked in screenshots.
- The `discovery_report` stage runs automatically whenever a discovery run produces at least one page (no gate); re-running discovery marks it `stale` and it re-runs when the new scan completes. Reports are versioned; older versions are kept.
- Not done in Phase 1 (recorded as limitations): form submission, login, clicking disclosure widgets, multi-step journeys. Authenticated discovery (encrypted test credentials) is Phase 2 story P2-01; safe exploratory interaction is Phase 6.

## 9. Execution, reporting, storage, queue

- **Execution (Phase 4)**: the Python worker writes a Playwright Test project into a per-run temp dir and runs `automation/` (Node) as a subprocess with timeouts, CPU/memory limits (`resource.setrlimit`), restricted env, network policy fixtures (ported from `playwright-project.ts`), JSON reporter. Docker-based sandbox when Docker exists.
- **Reporting**: report = versioned `qa_reports` row with structured JSON content (source of truth) + rendered files in storage (HTML, PDF via Chromium; DOCX/XLSX/CSV in Phase 5). AI narrative sections are labelled.
- **Storage**: `ObjectStorage` protocol (`put`, `get`, `open_stream`, `delete`, `exists`). Keys: `{org_id}/{project_id}/{kind}/{owner_id}/{name}`; path traversal rejected. Files are served only by the API after a tenant check, through short-lived HMAC-signed URLs (`/api/v1/evidence/{id}/content?exp=&sig=`) so `<img>` tags work without putting the session token in URLs.
- **Queue**: `JobQueue` protocol (`enqueue(kind, payload, *, org_id, project_id, dedupe_key, run_after)`, `cancel(job_id)`, `heartbeat`, `claim`). `SqlJobQueue` stores jobs in the `jobs` table and claims them with an atomic conditional `UPDATE`. The worker runs **inline** (inside the API process, default for local dev, one command) or **separate** (`python -m app.worker`), with the same code. Later: `CeleryJobQueue`/`ArqJobQueue` with Redis, same interface. The job payload carries only ids.
- **Event bus**: `agent_events` rows (monotonic id) are the source of truth; SSE tails them by cursor. That works across processes on SQLite; Redis pub/sub is used as a wake-up signal later.

### docker-compose design (for when Docker is installed)

```yaml
services:
  postgres: { image: postgres:17, environment: { POSTGRES_DB: qa, POSTGRES_USER: qa, POSTGRES_PASSWORD: ${PG_PASSWORD} }, ports: ["5433:5432"], volumes: [pg:/var/lib/postgresql/data] }
  redis:    { image: redis:7, ports: ["6380:6379"] }
  api:      { build: ./backend, command: uvicorn app.main:app --host 0.0.0.0 --port 8200, env_file: backend/.env, environment: { DATABASE_URL: postgresql+asyncpg://qa:${PG_PASSWORD}@postgres/qa, QUEUE_BACKEND: celery, REDIS_URL: redis://redis:6379/0, WORKER_MODE: separate }, ports: ["8200:8200"], depends_on: [postgres, redis] }
  worker:   { build: ./backend, command: python -m app.worker, environment: { same as api }, shm_size: 1gb, security_opt: ["seccomp=backend/docker/chromium-seccomp.json"], depends_on: [postgres, redis] }
  migrate:  { build: ./backend, command: alembic upgrade head, depends_on: [postgres] }
  minio:    { image: minio/minio, command: server /data, ports: ["9010:9000"] }   # optional S3-compatible storage
  web:      { build: ./web, ports: ["3002:3002"], environment: { NEXT_PUBLIC_API_URL: http://localhost:8200/api/v1 } }
volumes: { pg: {} }
```
Host ports 5433/6380 avoid the Postgres and Redis already running on this Mac.

## 10. Logging and observability

- Structured JSON logs (stdlib `logging` + JSON formatter; no extra dep) with `request_id`, `org_id`, `project_id`, `task_id`, `job_id` from `contextvars`. Redaction filter on every record.
- Request middleware: request id (`X-Request-ID` echoed), latency, status. Errors return the request id to the client.
- Agent telemetry stored in `agent_tasks`: duration, LLM model, input/output tokens, repair attempts, fallback used, validation issues. Agent events are the user-visible log.
- `/api/v1/health`: DB ok, worker heartbeat age, queue depth, AI enabled/model, browser available.
- Later: OpenTelemetry traces (FastAPI + SQLAlchemy instrumentation), Prometheus metrics.

## 11. Frontend

- Reuse `web/` App Router, auth context, `api.ts`, SWR hooks, `components/ui`. Visual design, tokens (light surfaces, navy-800 `#1A2847` primary), routes and screens are owned by the UX spec `docs/design/P1-qa-analyst-phase1.md`; this document only fixes the integration points.
- Routes: `/dashboard`, `/projects`, `/projects/new?url=` (Gate 1), nested project sections `/projects/[id]/{discovery,reports,…}` (not `?tab=`). Sections for unbuilt phases show a labelled "Coming in Phase N" page, not mock data. The design's `scan=<n>` query maps to the scan's sequence number in its key (`SCAN-000n`).
- Lifecycle progress indicator (stage rail) and live agent activity panel driven by SSE.
- SSE consumed with `fetch` + `ReadableStream` (not `EventSource`) so the bearer header is used.

## 12. `backend/` folder layout

```
backend/
  pyproject.toml  uv.lock  alembic.ini  .env.example  README.md
  app/
    main.py                 # create_app(): routers, middleware, error handlers, lifespan (inline worker)
    config.py               # pydantic-settings Settings
    logging.py
    worker.py               # `python -m app.worker`
    api/
      deps.py               # current_user, tenant_scope, db session
      errors.py             # AppError hierarchy -> JSON error envelope
      routers/              # health, auth, dashboard, projects, workflow, scans, evidence, reports, events
    schemas/                # Pydantic API DTOs (request/response)
    domain/                 # enums, stage registry, gate policy, provenance rules
    db/
      base.py  session.py  types.py (UTCDateTime, JSON variant, GUID)
      tenant.py             # TenantScope + ORM safety net
      models/               # one module per aggregate
      repositories/         # tenant-scoped data access
    services/               # use cases: auth, projects, workflow, reports, dashboard
    orchestrator/           # orchestrator.py, stages.py, gates.py, context_pack.py
    agents/
      base.py  tools.py     # Agent protocol, ToolRegistry + permissions
      discovery/            # agent.py, crawler.py, extract.js, heuristics.py, completeness.py, schemas.py
      reporting/            # discovery_report.py (Phase 1), later reports
    llm/                    # base.py (LLMClient protocol), claude.py, disabled.py, untrusted.py, prompts/
    browser/                # pool.py, session.py, network_policy.py, capture.py
    security/               # ssrf.py, passwords.py, tokens.py, crypto.py, redact.py, signing.py, ratelimit.py
    queue/                  # base.py, sql_queue.py, runner.py (worker loop)
    storage/                # base.py, local.py
    events/                 # emitter.py, sse.py
    reports/templates/      # Jinja2 HTML
  migrations/               # Alembic env + versions
  tests/
    unit/  integration/  fixtures/site/   # static test website served on localhost
automation/                 # Phase 4: Node toolkit (spec-guard, fixtures, runner) for generated TS tests
```
