# Application Test AI: QA Analyst platform

An AI-assisted QA analyst that follows the testing life cycle with a person deciding at each gate: application
discovery, requirements, test strategy and plan, test design, automation (Playwright), authorised test runs,
failure analysis, defects, traceability and reports. Every step has a rule-based path, so the platform works with
AI off; AI output is labelled and never changes a recorded result.

```
backend/     FastAPI + SQLAlchemy (SQLite) + Playwright: API, workflow, agents, job worker (port 8200)
web/         Next.js 15 + Tailwind frontend (port 3002)
automation/  Trusted Node toolkit that validates and runs the generated Playwright tests
demo-shop/   Small application under test with deliberate bugs (port 4100)
docs/        Architecture, contracts, design specs, product backlog and QA verification
```

The old Fastify product was retired in Phase 4 (decision D16). It remains on `main`:
`git worktree add ../application-test-ai-main main`.

## Quick start

Requires Python 3.12 with [uv](https://docs.astral.sh/uv/) and Node 22.6+.

```bash
cd automation && npm install && npx playwright install chromium && cd ..

cd backend
uv sync
uv run playwright install chromium
ALLOW_PRIVATE_TARGETS=true uv run uvicorn app.main:app --port 8200   # API on http://localhost:8200
```

```bash
cd web
cp .env.example .env.local   # NEXT_PUBLIC_API_URL=http://localhost:8200
npm install
npx next dev -p 3002         # UI on http://localhost:3002
```

Optional, the demo application to test against:

```bash
cd demo-shop && npm start    # http://localhost:4100 (no dependencies)
```

Its test login is in `demo-shop/demo-login.mjs`. `ALLOW_PRIVATE_TARGETS=true` (development only) lets the backend
analyse a site on localhost; see `backend/README.md`.

### Enabling Claude

Set `ANTHROPIC_API_KEY` in `backend/.env`. Without it every agent uses its rule-based path and the assistant answers
its built-in questions.

## Checks

```bash
cd backend && uv run ruff check . && uv run ruff format --check . && uv run mypy && uv run pytest
cd automation && npm test && npm run typecheck && npm run lint
cd web && npx tsc --noEmit && npm run lint && npx playwright test --project=unit --project=ui-mocked --workers=2
```

Real-stack journeys (backend on 8200, web on 3002, demo shop on 4100):
`cd web && npx playwright test --project=e2e e2e/phase4-journey.spec.ts` (also `phase2-journey`, `phase3-journey`).
The Phase 4 journey invites a member (no gate approval) into the shared e2e account's organisation once and keeps
it in `web/playwright/.auth/e2e-member.json` (gitignored).

More detail: `backend/README.md`, `automation/README.md`, `demo-shop/README.md` and `docs/architecture/README.md`.
