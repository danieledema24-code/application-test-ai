# automation/ — Playwright toolkit (P4-01)

The Node side of Phase 4. The backend calls it through `backend/app/automation/toolkit.py` (it is never imported
as a library) to validate generated Playwright bundles and run them. Developers and CI can use the same CLI on an
exported bundle.

## Install

```sh
cd automation
npm ci
npx playwright install chromium        # firefox / webkit only if a run opts into them (decision D7)
```

Requires Node >= 22.6. `bin/qa.mjs` re-runs itself with `--experimental-strip-types`, so there is no build step.

`@playwright/test` is pinned to **1.65.0**: the Playwright driver bundled with the backend's Python `playwright`
package. Python and Node then share one browser install (same Chromium revision). If you upgrade one, upgrade the
other. `backend/tests/unit/test_toolkit.py` fails when the two disagree.

## CLI

Every command prints one JSON line on stdout. Exit codes: 0 means ok, 1 means checks or tests failed, 2 means the
command could not run (the line is then `{"error": "..."}`).

| Command | What it does |
|---|---|
| `qa version` | Node, toolkit and Playwright versions, and the installed browsers |
| `qa init <dir> [--live]` | Copies the platform files into a bundle directory |
| `qa validate <dir> [files...]` | Runs spec-guard, tsc (strict), eslint (`platform/eslint.config.js`) and the `TC-nnnn` tag check on each generated file |
| `qa run <dir> --report <file> [--grep <re>] [--live-dir <dir>]` | Runs the bundle with its `playwright.config.ts` and writes a JSON report |

A run is configured through the environment. The backend passes only these variables (`ALLOWED_CALL_ENV`):
`BASE_URL`, `ATA_*` (allowed hosts, approved origin, browsers, viewports, video, trace, report file, output dir,
live dir, login path), `PW_WORKERS` (capped at 4), `PW_RETRIES`, `TEST_TIMEOUT_MS`, `TEST_USERNAME` and
`TEST_PASSWORD`. Platform secrets never reach the child process.

## Trusted vs generated code

- **Trusted (toolkit-owned):** `src/`, `bin/` and `platform/`. The platform files are `fixtures.ts`, `qa.ts`,
  `policy.ts`, `playwright.config.ts`, `tsconfig.json` and `eslint.config.js`, plus `live.ts` for live view, which
  is never exported. They are copied into every bundle and never validated as generated code.
- **Generated (validated):** `*.spec.ts`, `pages/<Name>.ts` and `data/<name>.ts`.
  - Specs import `{ test, expect }` from `./fixtures` only, plus type-only imports from `@playwright/test`.
  - `waitForTimeout`, timers, `.only`, raw `page.locator` in specs and xpath/css engine strings are rejected.
  - Each spec has exactly one test titled `TC-nnnn: …` and tagged `@TC-nnnn` in `TC-nnnn.spec.ts`.

The fixtures apply the same network policy as the backend's SSRF guard:
- `test/policy-vectors.json` is shared with `backend/tests/unit/test_ssrf.py`.
- Every redirect hop is checked.
- Blocked requests are logged as `BLOCKED by policy <url> (<reason>)`.

The fixtures also attach evidence: a final screenshot with password fields masked in `#FF00FF`, the page state,
the console log and the network log. Failed `qa.expect*` assertions start with `QA_ASSERTION:` so failure analysis
can classify them.

## Development

```sh
npm test          # node:test; browser.test.ts drives real Chromium against a local fixture site
npm run typecheck
npm run lint
```
