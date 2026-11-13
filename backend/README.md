# QA Analyst Platform backend (Phase 1)

FastAPI + SQLAlchemy 2 (async) + Alembic on SQLite, Playwright (Chromium) for discovery, optional Claude for analysis.
Phase 1 covers stories P1-01 to P1-11:

- accounts and organisations
- URL check and project creation (Gate 1)
- the workflow state machine
- read-only application discovery
- the Discovery Report (JSON, HTML, PDF)
- the live progress stream and the dashboard

The web app is built against `docs/architecture/api-contracts.md`. The live OpenAPI document is at
`http://localhost:8200/api/v1/openapi.json`, with Swagger UI at `/api/v1/docs`.

## Setup

Requires Python 3.12 and [uv](https://docs.astral.sh/uv/) (`~/.local/bin/uv`).

```bash
cd backend
uv sync                                  # creates .venv from uv.lock
uv run playwright install chromium       # browser used by discovery and PDF rendering
cp .env.example .env                     # optional: defaults work for local development
```

No Postgres or Redis is needed:

- The database is a SQLite file at `backend/data/qa.db`.
- Files go to `backend/data/storage/`.
- The job queue lives in the same database.

Migrations run automatically at startup, or by hand with `uv run alembic upgrade head`.

## Run

```bash
cd backend
ALLOW_PRIVATE_TARGETS=true uv run uvicorn app.main:app --port 8200
```

You only need `ALLOW_PRIVATE_TARGETS=true` to analyse a site on localhost, such as the demo shop:

1. Start it with `cd api && npx tsx src/demo/target-app.ts`.
2. Analyse `http://localhost:4100`.

The setting is refused when `ENV=production`. Even when it is on, the scanner can only reach the approved target's origin, and only on loopback (127.0.0.0/8, ::1). LAN (192.168.x, 10.x, …), link-local and other local ports stay blocked, and cloud metadata addresses are always blocked. `GET /api/v1/health` reports the flag as `allow_private_targets`.

The worker runs inside the API process by default (`WORKER_MODE=inline`). To run it as a separate process:

```bash
WORKER_MODE=separate uv run uvicorn app.main:app --port 8200
uv run python -m app.worker
```

## Test and check

```bash
cd backend
uv run pytest                    # unit + integration (starts a local fixture site; needs Chromium)
uv run pytest -m "not demo_shop" # skip the demo-shop test
uv run ruff check . && uv run ruff format --check .
uv run mypy                      # strict, over app/
```

`tests/integration/test_demo_shop.py` runs a real discovery of `http://localhost:4100`. It writes the report as JSON, HTML and PDF to `backend/data/test-artifacts/`, and is skipped when the demo shop is not running.

## Environment variables

All settings are read from the environment or from `backend/.env` (see `.env.example`). The main ones:

| Variable | Default | Purpose |
|---|---|---|
| `ENV` | `development` | `development`, `test` or `production`. Production refuses unsafe settings. |
| `DATABASE_URL` | `sqlite+aiosqlite:///backend/data/qa.db` | Postgres works by config (`postgresql+asyncpg://…`), but its driver is not installed yet. |
| `STORAGE_DIR` | `backend/data/storage` | Evidence and report files. |
| `SECRET_KEY` | dev placeholder | Signs evidence URLs. Required in production (32+ characters). |
| `ENCRYPTION_KEY` / `ENCRYPTION_KEY_ID` | derived from `SECRET_KEY` in dev / `k1` | AES-256-GCM key for stored test credentials: 32 bytes, base64-encoded. Required in production. |
| `WEB_ORIGIN` | `http://localhost:3002` | The only allowed CORS origin. |
| `PUBLIC_API_URL` | `http://localhost:8200` | Base of the signed `content_url` links. |
| `ALLOW_PRIVATE_TARGETS` | `false` | Dev/test only; see Run. |
| `WORKER_MODE` / `WORKER_CONCURRENCY` | `inline` / `2` | Mode is `inline`, `separate` or `off`. |
| `AI_PROVIDER` / `ANTHROPIC_API_KEY` / `AI_MODEL` | `auto` / unset / `claude-opus-5-5` | Without a key everything runs rule-based and is labelled `rules`. |
| `SCAN_DEFAULT_MAX_PAGES` / `SCAN_MAX_PAGES_CAP` | `30` / `100` | Page limits. |
| `SCAN_TIME_LIMIT_S` | `1200` | Total discovery time limit (20 min). |
| `MAX_CONCURRENT_SCANS_PER_ORG` | `2` | Extra scans wait in the queue. |
| `LOG_LEVEL` / `LOG_JSON` | `INFO` / `true` | Logs are redacted (tokens, keys, registered secrets). |

## Layout

| Path | Contents |
|---|---|
| `app/api` | Routers, dependencies, error envelope |
| `app/services` | Use cases |
| `app/orchestrator` | Stage state machine and gates |
| `app/agents/discovery` | Crawler, extraction, rules, completeness |
| `app/agents/reporting` | Discovery Report |
| `app/browser` | Chromium pool and network policy |
| `app/security` | SSRF protection, crypto, URL signing, redaction, rate limits |
| `app/llm` | Claude, Disabled and Fake providers |
| `app/db` | Models, tenant isolation, migrations helper |
| `app/queue` | SQL job queue and worker |
| `migrations/` | Alembic migrations |
