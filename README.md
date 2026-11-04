# Application Test AI — MVP

AI-assisted QA platform: application discovery, AI test-case generation, manual and Playwright
automated testing, API testing, defect management, PDF/CSV reporting and an AI assistant that acts
through real platform functions.

```
web/   Next.js + Tailwind frontend (port 3000)
api/   Fastify + TypeScript API, Prisma, Playwright execution workers (port 4000)
docs/  API.md — REST contract
```

## Quick start

Requires Node 22+.

```bash
cd api
npm install
npx playwright install chromium
cp .env.example .env            # then set JWT_SECRET and ENCRYPTION_KEY (see comments)
npx prisma db push
npm run dev                      # API on http://localhost:4000
```

```bash
cd web
npm install
npm run dev                      # UI on http://localhost:3000
```

Optional, a demo application to test against (has deliberate bugs):

```bash
cd api && npm run demo-target    # http://localhost:4100
```

Login `qa.tester@example.com` / `Passw0rd!demo`, API bearer token `demo-token-7f3a9c`,
OpenAPI spec at `http://localhost:4100/openapi.json`.

### Enabling Claude

Set `ANTHROPIC_API_KEY` in `api/.env`. Without it every AI feature still works through clearly
labelled rule-based fallbacks (heuristic test generation, failure classification, script
generation, and a limited command mode for the assistant). Model: `claude-opus-5-5`
(override with `AI_MODEL`). Requests use server-side refusal fallbacks.

## Playwright automation

Every automated test case is stored as a standard **Playwright Test** spec
(`import { test, expect } from "../fixtures"`). The in-app runner writes them into a temporary
Playwright project and runs `playwright test`, so the same files run anywhere:

- **Download a project:** *Test cases → Download Playwright project* (or
  `GET /api/projects/:id/playwright-export`) gives a zip with `package.json`, `playwright.config.ts`,
  `fixtures.ts`, `tests/*.spec.ts` and `.env.example`. Run it with `npm install && npx playwright test`.
- **Remote browser grid:** set *Remote Playwright endpoint* (`wss://…`) on an environment and
  runs execute on that browser server instead of local Chromium. Exported projects use `PW_WS_ENDPOINT`.
- **Evidence:** a masked final screenshot, console and network logs per test; video and trace on failure.
- **Exports:** test cases as CSV (*Test cases → Export CSV*); run and project reports as PDF/CSV.

## End-to-end check

With the API and demo target running:

```bash
cd api && node test/e2e-journey.mjs
```

This walks the full MVP journey (spec §8) and the acceptance criteria AC-001–AC-015: register →
project → authorise environment → discovery → generate & approve cases → automated run with
evidence → Playwright project & CSV export → manual run → defect → OpenAPI import & API run → PDF/CSV reports → dashboard →
assistant → workspace isolation → password reset.

## Architecture notes and deviations from the recommended stack

| Spec recommendation | MVP implementation | Path to production |
|---|---|---|
| FastAPI (Python) | Fastify + TypeScript | One language across UI, API and Playwright scripts |
| PostgreSQL | Prisma + SQLite | Change `provider` to `postgresql` in `api/prisma/schema.prisma` and set `DATABASE_URL`; JSON is stored as text for portability |
| Redis queue | In-process bounded worker pool (`services/queue.ts`); job state lives in the DB, interrupted runs are recovered on restart | Replace `enqueue`/pump with BullMQ; handlers are unchanged |
| Docker workers | Each automated test runs in a separate child process (`worker/runner-child.ts`) with a scrubbed environment, a fresh browser and a network policy; job input arrives over stdin | Run the same entrypoint in a per-job container with egress firewall rules |
| S3 storage | Local filesystem, keys namespaced by `org/project/...` (`lib/storage.ts`) | Swap `putObject/getObject` for an S3 client |
| Managed auth | bcrypt + JWT sessions (revocable, 12 h), password reset tokens (dev mode returns the link, since no SMTP is configured) | Plug in a managed IdP |

### Safeguards (spec §13)
- **Authorisation before testing**: discovery, automated and API runs are refused until a user
  confirms authorisation for the environment; changing the URL withdraws it. Recorded in the audit log.
- **SSRF / approved domains**: cloud metadata endpoints are always blocked; private networks are blocked unless
  `ALLOW_PRIVATE_TARGETS=true` (dev only). Browsers may only navigate to the approved host.
- **Production**: production environments are read-only by default (no write API requests).
  Write requests always need explicit confirmation. Assistant runs against production need confirmation.
- **Secrets**: credentials are AES-256-GCM encrypted at rest, write-only in the API, injected
  only at execution time, redacted from logs, evidence, reports and AI prompts, and password fields are masked in screenshots.
- **AI honesty**: AI output is labelled (hypothesis / AI-generated / rule-based), never changes
  recorded statuses, and AI-generated cases start as DRAFT and must be approved before execution.
- **Isolation**: every query is scoped to the caller's organisation; cross-workspace access returns 404.
