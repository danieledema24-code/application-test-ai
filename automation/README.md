# automation/ — Playwright toolkit (P4-01) and load generator (P5-01a)

The Node side of Phase 4. The backend calls it through `backend/app/automation/toolkit.py` (it is never imported
as a library) to validate generated Playwright bundles and run them. Developers and CI can use the same CLI on an
exported bundle. Phase 5 adds `qa perf`, the built-in load generator (decision D17), called through
`backend/app/automation/loadgen.py`.

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
| `qa perf --config <file> --max-vus N --max-rps N --max-duration S [--summary <file>] [--control <file>]` | Runs a load test (see below); exit 1 when it was stopped or aborted |
| `qa perf … --export-k6 <file>` | Writes an equivalent k6 script for people to run themselves ("Not run by the platform") |

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

## Load generator (`qa perf`, P5-01a)

Plain `node:http`/`node:https` with a keep-alive agent; no extra dependency.

- **Input:** a JSON config (`src/perf/config.ts`, unknown keys refused): `origin`, `targets` (≤ 10 `{path, weight}`,
  GET only, paths on the origin), `stages` (`{duration_s, target_vus}`, linear ramps from 0 as in k6),
  `think_time_ms {min, max}`, `max_rps`, `thresholds`, `kill_switch`, `allowed_hosts`, `allow_private`,
  `max_duration_s`, `request_timeout_ms` (default 10 s). There is no way to pass headers, cookies or credentials.
- **Limits:** `--max-vus/--max-rps/--max-duration` (the platform hard cap) are required, refused above the compiled
  maximum 200 / 200 / 1800 s, and a config above any of them exits 2 with
  `{"error": "Profile exceeds the platform limit: 51 users (limit 50)"}` before any request.
- **Model:** closed; virtual users loop over weighted targets with think time. A token bucket of capacity 1 spaces
  requests at least `1/max_rps` apart across all users, so no one-second window holds more than `max_rps + 1`.
- **Network policy:** the origin is checked like the fixtures' policy (shared `test/policy-vectors.json`) and its host
  is resolved **once**; every connection goes to that address (`lookup` pinned, Host header and SNI kept). Redirects
  are never followed (3xx counted as `redirects`).
- **Metrics:** log-bucketed histogram (≤ 0.5 % error) per target and overall; errors are 5xx, timeouts and network
  errors, 4xx are `client_errors`. One JSON progress line a second; the summary goes to `--summary` and the last line.
- **Kill switch (D18 defaults):** after a 10 s warm-up, stop when the last 10 s have > 20 % errors, p95 > 10 s, or no
  response below 500 for 5 s. SIGTERM (or the `--control` file appearing) stops within 2 s with a partial summary.
  The backend adapter kills the process group 30 s after the planned duration.

## Development

```sh
npm test          # node:test; browser.test.ts drives real Chromium, perf.test.ts real load (about 1 minute)
npm run typecheck
npm run lint
```
