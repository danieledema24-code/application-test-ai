# Architecture: Autonomous AI QA Analyst Platform

Rebuild of Application Test AI against `docs/spec/qa-analyst-platform.md` (the "spec"). This folder covers spec §21 steps 1–7.

| Doc | Covers |
|---|---|
| [architecture.md](architecture.md) | Modules, agent contracts, workflow state machine, quality gates, evidence, knowledge base, prompt-injection isolation, observability, `backend/` layout |
| [database-schema.md](database-schema.md) | Every §14 entity, tenancy, versioning, audit, Phase 1 tables |
| [api-contracts.md](api-contracts.md) | REST + SSE contracts (Phase 1 in full, later phases outlined) |
| [security-risks.md](security-risks.md) | Threats mapped to spec §19, mitigations, delivery phase |
| [roadmap.md](roadmap.md) | Phases 1–6 stories, retirement of old `api/`, test strategy |

## Fixed decisions (from the user, not re-opened here)

- Backend: Python 3.12, FastAPI, Pydantic v2, SQLAlchemy 2 async + Alembic. **SQLite now, PostgreSQL by config only.**
- Jobs through a queue interface: in-process asyncio worker now, Celery/arq + Redis later. Storage through an interface: local FS now, S3-compatible later.
- Backend browser automation: Playwright for Python. Generated tests: Playwright Test in TypeScript (Phase 4).
- New code in `backend/`, port **8200**. `web/` (Next.js, port 3002) is reused and restyled to the light navy design.
- LLM behind a provider-independent interface; Claude first (`claude-opus-5-5`, `anthropic` Python SDK). Everything works with AI off via labelled rule-based fallbacks.
- Old `api/` stays runnable until each phase replaces its features, then is deleted.

## Repository inspection (spec §21.1–21.2)

### What exists (branch `qa-analyst-rebuild`, based on `main` @ e1be90d)

| Area | State |
|---|---|
| `api/` | Fastify 5 + Prisma 6 (SQLite) + TypeScript, ~5.5k LOC, port 4000. Routes: auth, workspace members, projects, environments, discovery, test cases, scripts, runs, results, evidence, defects, reports, integrations, webhooks, search, notifications, AI assistant. In-process job queue. Node built-in test runner (`tsx --test`), 7 test files + 2 UI journey scripts. |
| `web/` | Next.js 15.5 App Router, React 19, Tailwind v4, SWR, recharts, lucide-react. Dark theme with orange CTAs (`globals.css` tokens). Talks to `NEXT_PUBLIC_API_URL` (localhost:4000/api) with a bearer token in `localStorage`. Design-system primitives in `components/ui` (Button, Card, Field, Modal, States, StatusPill, Table, Tabs, Toast). |
| `docs/` | `API.md` (old REST contract), SCAN-1 design spec, backlog, UX review, QA reports. |
| Machine | Node 22.16, `uv` + Python 3.12 in `~/.local/bin`. No Docker/Homebrew. **Note:** ports 5432 (embedded Postgres from another project, `nucrox-pg`) and 6379 (a Redis build) are already listening; they belong to other work and must not be used. The docker-compose design maps to host ports 5433/6380 for that reason. Also taken: 3001, 4001, 5000, 5173, 7000. |

### Reuse map (old `api/` → new `backend/`)

| Old piece | Verdict | How |
|---|---|---|
| `lib/ssrf.ts` (metadata host list, IPv4-in-IPv6 extraction, private ranges, DNS check) | **Port** | Python `security/ssrf.py` using `ipaddress` (`ipv4_mapped`, `sixtofour`, plus manual NAT64 and IPv4-compatible). Same test vectors as `test/security.test.ts`. Add redirect-hop validation (old code did not validate redirects). |
| `services/browser.ts` (`applyNetworkPolicy`) | **Port + harden** | `browser/network_policy.py`: same rules, plus DNS resolution of every new host (not only IP literals) and redirect validation. |
| `services/discovery.ts` `EXTRACT_SCRIPT` (in-page JS) | **Reuse verbatim, then extend** | Moved to `agents/discovery/extract.js`, loaded by Python. Extended for dropdowns, search, filters, tables, modals, ARIA roles, element fingerprints. |
| Discovery BFS, `SKIP_LINK` rule, limitations wording, `heuristicWorkflows` | **Port** | `agents/discovery/crawler.py`, `heuristics.py`. |
| Live screencast (CDP JPEG frames) | Drop in Phase 1 | Per-page screenshots are pushed over SSE instead. Revisit in Phase 4 with execution. |
| `lib/crypto.ts` (AES-256-GCM, `iv|tag|ct` base64) | **Port** | `security/crypto.py` with `cryptography` AESGCM, same envelope plus a key-id prefix for rotation. |
| `lib/redact.ts` | **Port** | `security/redact.py`, same regexes; applied to logs, prompts, evidence text. |
| `lib/storage.ts` (org-prefixed keys, path traversal check) | **Port as interface** | `storage/local.py` behind `ObjectStorage` protocol. |
| `services/queue.ts`, `lib/lock.ts` | **Replace** | DB-backed job table + asyncio worker (survives restarts, works across processes). |
| `services/ai.ts` (`aiJSON`, redaction before send, null on failure, server-side refusal fallback) | **Port pattern** | `llm/` provider interface. Same rule: callers must have a deterministic fallback. |
| Auth (JWT + session row, bcrypt, login throttle, enumeration-safe reset) | **Port pattern** | Opaque session tokens (hash stored), argon2id, same throttle and reset semantics. |
| `services/generation.ts` (case schema, rule-based generation) | Reference for Phase 3 | Field ideas (objective, per-step data/expected) feed the new TestCase schema. Code not ported. |
| `services/scriptgen.ts` (rule-based step→assertion translator), `playwright-project.ts` (fixtures, config, export), `lib/spec-guard.ts` (acorn allow-list) | **Reuse in Phase 4** | These are TypeScript and generated tests stay TypeScript, so they move into a Node toolkit `automation/` invoked by the Python worker as a subprocess. |
| `services/analysis.ts` (failure classes, "hypothesis" labelling) | Reference for Phase 4 | Class list extended to spec §8 (selector, test data). |
| `services/reports.ts` (pdfkit, "numbers computed from records") | **Replace** | HTML (Jinja2) rendered to PDF by the Playwright Chromium we already ship. Principle kept. |
| `api-runner.ts`, `openapi.ts` | Reference for Phase 4 API testing | |
| Assistant (`assistant.ts`, `actions.ts`: assistant calls the same functions as REST) | **Keep the principle** for spec §16 (Phase 3+) | |
| Integrations, webhooks, notifications, global search | **Dropped** from the rebuild scope | Not in the spec. Can return later on the new model. |
| Prisma schema | **Replaced** | New schema (database-schema.md). No data migration: old data is dev/demo only. |
| `demo/target-app.ts` (deliberately buggy site) | **Port idea** | Static fixture site served by pytest for discovery integration tests; old one still usable manually on 4100. |
| `web/` primitives, auth context, API wrapper, SWR hooks | **Reuse + restyle** | Tokens in `globals.css` change to light navy; component APIs stay. API client gets a new base URL (`http://localhost:8200/api/v1`). |
| `web/` project tabs (Test cases, Runs, API, Defects, Reports, Environments) | Removed from navigation in P1-12, files deleted in P1-16 | They cannot authenticate against the new backend. The old product stays usable from a `main` worktree. See the roadmap retirement plan. |

### Dependencies to watch

- **Playwright for Python vs Node Playwright 1.64**: separate browser builds. Python needs `uv run playwright install chromium` (about 150 MB download). Pin the Python version in `pyproject.toml`; Phase 4 pins `@playwright/test` in `automation/` independently.
- **Anthropic Python SDK**: structured outputs via `messages.parse` with a Pydantic model where the SDK supports it; otherwise forced tool-use with the model's JSON schema. Either way the output is re-validated with Pydantic.
- **SQLite specifics to avoid**: no SQLite-only SQL; JSON through SQLAlchemy `JSON` (variant `JSONB` on Postgres); enums as strings with CHECK constraints; UTC timestamps via a TypeDecorator (SQLite has no time zones); WAL mode + `busy_timeout` because API and worker write together.
- **Next.js 15 / React 19 / Tailwind v4** already in `web/`; no upgrade needed.
- **Report PDF**: avoid WeasyPrint (needs Pango via Homebrew). Use Chromium `page.pdf()`.
- **New Python deps (Phase 1)**: fastapi, uvicorn[standard], pydantic, pydantic-settings, sqlalchemy[asyncio], aiosqlite, alembic, argon2-cffi, cryptography, httpx, playwright, anthropic, jinja2. Dev: pytest, pytest-asyncio, ruff, mypy. `asyncpg`, `celery`/`arq`, `boto3`/`aioboto3` come when those backends are switched on.
